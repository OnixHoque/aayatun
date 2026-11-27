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
        for (const width of [1440, 768, 390]) {
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
                        hintVisible: getComputedStyle(hint).visibility === 'visible' };
                })()`);
                assert.ok(layout.visible && layout.height > 0, 'Real modal is visible');
                baseline ??= layout;
                assert.ok(Math.abs(layout.top - baseline.top) < 1, `Search bar moved at ${width}px: ${JSON.stringify(layout)}`);
                assert.equal(layout.height, baseline.height);
                assert.equal(layout.sourcesVisible, mode === 'meaning');
                assert.equal(layout.hintVisible, mode === 'keyword');
            }
            console.log(`PASS: ${width}px, repeated mode switches preserve input position and height`);
        }
    } finally {
        socket?.close();
        await stopChild(child);
        await removeDirectory(profile);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
