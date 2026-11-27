// Verify the real centered modal does not move when its search mode changes.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { connect, waitForPort, stopChild, removeDirectory } = require('./islamqa_pr2_browser.cjs');

async function main() {
    const chrome = process.env.AAYATUN_CHROME;
    if (!chrome) throw new Error('Set AAYATUN_CHROME to a Chromium executable');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aayatun-toggle-'));
    const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket;
    try {
        const connection = await connect(await waitForPort(profile, 30000));
        socket = connection.socket;
        const { client } = connection;
        const evaluate = async expression => {
            const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser error');
            return result.result.value;
        };
        const pause = () => new Promise(resolve => setTimeout(resolve, 400));
        await client.send('Page.enable');
        // Hold inference pending so we can measure actual submit/progress/error UI.
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `
            window.Worker = class {
                constructor() { window.layoutWorker = this; }
                postMessage() {}
                terminate() {}
            };
        ` });
        await client.send('Page.navigate', { url: process.env.AAYATUN_URL || 'http://127.0.0.1:8000' });
        let ready = false;
        for (let i = 0; i < 100; i++) {
            ready = await evaluate('document.readyState === "complete" && !!window.jQuery?.fn.modal && !!document.querySelector("[data-meaning-mode]")');
            if (ready) break;
            await pause();
        }
        assert.ok(ready, 'Modal and search controls loaded');
        await evaluate(`jQuery('#searchwindow').modal('show'); true`);
        await pause();
        for (const width of [1440, 768, 390, 320]) {
            await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
            await pause();
            let baseline;
            for (const mode of ['keyword', 'meaning', 'keyword', 'meaning', 'keyword']) {
                await evaluate(`document.querySelector('#searchwindow input[name=search_mode][value=${mode}]').click()`);
                await pause();
                const layout = await evaluate(`(() => {
                    const dialog = document.querySelector('#searchwindow');
                    const input = dialog.querySelector('[name=query_str]');
                    const bounds = input.getBoundingClientRect();
                    const sources = dialog.querySelector('[data-meaning-scope-control]');
                    const hint = dialog.querySelector('.search-hint');
                    return { top: bounds.top, height: bounds.height,
                        visible: dialog.classList.contains('visible'),
                        sourcesVisible: getComputedStyle(sources).visibility === 'visible',
                        hintVisible: getComputedStyle(hint).visibility === 'visible',
                        tipGap: hint.getBoundingClientRect().top - dialog.querySelector('.meaning-options').getBoundingClientRect().bottom };
                })()`);
                assert.ok(layout.visible && layout.height > 0, 'Real modal is visible');
                baseline ??= layout;
                assert.ok(Math.abs(layout.top - baseline.top) < 1, `Search bar moved at ${width}px: ${JSON.stringify(layout)}`);
                assert.equal(layout.height, baseline.height);
                assert.equal(layout.sourcesVisible, mode === 'meaning');
                assert.equal(layout.hintVisible, mode === 'keyword');
                assert.ok(layout.tipGap <= 20, `Extra gap above tips at ${width}px: ${layout.tipGap}`);
            }
            await evaluate(`(() => {
                const dialog = document.querySelector('#searchwindow');
                dialog.querySelector('input[name=search_mode][value=meaning]').click();
                const form = dialog.querySelector('form');
                form.elements.query_str.value = 'What is the importance of prayer?';
                form.requestSubmit();
            })()`);
            for (const state of ['search', 'download', 'error', 'idle']) {
                await evaluate(`(() => {
                    if (${JSON.stringify(state)} === 'download') {
                        window.layoutWorker.onmessage({data:{type:'progress',phase:'download',progress:42}});
                    } else if (${JSON.stringify(state)} === 'error') {
                        window.layoutWorker.onmessage({data:{error:'test failure'}});
                    } else if (${JSON.stringify(state)} === 'idle') {
                        document.querySelector('#searchwindow input[value=keyword]').click();
                    }
                })()`);
                await pause();
                const statusLayout = await evaluate(`(() => {
                    const dialog = document.querySelector('#searchwindow');
                    const input = dialog.querySelector('[name=query_str]').getBoundingClientRect();
                    const status = dialog.querySelector('[data-meaning-status]');
                    return {top:input.top,height:input.height,text:status.textContent,
                        spinner:!!status.querySelector('.loader'),
                        clipped:status.scrollHeight > status.clientHeight};
                })()`);
                assert.ok(Math.abs(statusLayout.top - baseline.top) < 1,
                    `Input shifted during ${state} at ${width}px: ${JSON.stringify(statusLayout)}`);
                assert.equal(statusLayout.height, baseline.height);
                assert.equal(statusLayout.clipped, false);
                assert.equal(statusLayout.spinner, state === 'search' || state === 'download');
                if (state === 'download') assert.match(statusLayout.text, /42%/);
                if (state === 'error') assert.match(statusLayout.text, /could not load/);
                if (state === 'idle') assert.equal(statusLayout.text, '');
            }
            console.log(`PASS: ${width}px, mode switches, searching, download progress, error, and reset preserve input position and height`);
        }
    } finally {
        socket?.close();
        await stopChild(child);
        await removeDirectory(profile);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
