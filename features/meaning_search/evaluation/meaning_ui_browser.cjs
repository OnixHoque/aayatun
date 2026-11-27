// Exercise the actual form and verify persistent model caching across page loads.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { connect, waitForPort, stopChild, removeDirectory } = require('./islamqa_pr2_browser.cjs');

async function main() {
    const chrome = process.env.AAYATUN_CHROME;
    if (!chrome) throw new Error('Set AAYATUN_CHROME to a Chromium executable');
    const base = process.env.AAYATUN_URL || 'http://127.0.0.1:8000';
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aayatun-ui-'));
    const networkFlags = process.env.AAYATUN_LIVE_HF === '1' ? [] : [
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ];
    const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0',
        ...networkFlags,
        `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket;
    try {
        const connection = await connect(await waitForPort(profile, 30000));
        socket = connection.socket;
        const { client } = connection;
        await client.send('Page.enable');
        await client.send('Network.enable');
        const requests = [];
        client.on('Network.requestWillBeSent', e => {
            if (e.request.method === 'POST') requests.push(e.request.postData);
        });
        const evaluate = async expression => {
            const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'Browser error');
            return r.result.value;
        };
        const waitFor = async expression => {
            for (let i = 0; i < 600; i++) {
                try { if (await evaluate(expression)) return; } catch {}
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            throw new Error('Timed out: ' + expression);
        };
        await client.send('Page.navigate', { url: base });
        await waitFor('document.querySelector("select[name=search_mode]") && document.readyState === "complete"');
        await evaluate(`(() => {
            const mode = document.querySelector('select[name=search_mode]');
            mode.value = 'meaning'; mode.dispatchEvent(new Event('change'));
            mode.form.elements.query_str.value = 'saw the end';
            mode.form.requestSubmit();
        })()`);
        const spinner = await evaluate(`Boolean(document.querySelector('form[aria-busy] [data-meaning-status] .loader'))`);
        if (!spinner) throw new Error('Loading spinner was not displayed');
        await waitFor('document.querySelector("#result-search-mode") && !document.querySelector("form[aria-busy]")');
        const result = await evaluate(`(async () => ({ refs: [...document.querySelectorAll('.surahlink')].map(n => n.textContent.trim()),
            alerts: [...document.querySelectorAll('[role=alert]')].map(n => n.textContent),
            text: document.body.innerText, cacheNames: await caches.keys() }))()`);
        console.log(JSON.stringify({ refs: result.refs, alerts: result.alerts, posts: requests }, null, 2));
        if (result.refs.length !== 10) throw new Error('UI did not render ten results');
        if (/Vectors are about|download the E5 model/.test(result.text)) throw new Error('Technical copy is still visible');
        if (!result.text.includes('Tafsir Ibn Kathir') || !result.text.includes('AI explanation')) {
            throw new Error('Fused result context is missing from the page');
        }
        const modelFiles = await evaluate(`(async () => (await (await caches.open('transformers-cache')).keys()).map(r => r.url))()`);
        if (!modelFiles.some(url => url.endsWith('/model_int8.onnx'))) throw new Error('ONNX model was not cached');
        // Reload the document, then start a new worker with fetch instrumentation.
        await client.send('Page.reload');
        await waitFor('document.readyState === "complete" && document.querySelector("#result-search-mode")');
        const cached = await evaluate(`new Promise((resolve, reject) => {
            const source = 'const originalFetch = self.fetch; let modelFetches = 0; const phases = []; self.fetch = (...args) => { if (String(args[0]).includes("/meaning/models/")) modelFetches++; return originalFetch(...args); }; const send = self.postMessage.bind(self); self.postMessage = data => { if (data.type === "progress") phases.push(data.phase); send({...data, modelFetches, phases}); }; await import(' + JSON.stringify(location.origin + '/static/meaning/js/meaning-worker.js?v=8') + '); send({ready:true});';
            const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
            const worker = new Worker(url, {type:'module'});
            const timer = setTimeout(() => reject(new Error('Cache probe timed out')), 90000);
            worker.onerror = e => reject(new Error(e.message));
            worker.onmessage = ({data}) => {
                if (data.type === 'progress') return;
                if (data.ready) return worker.postMessage({query:'saw the end',scope:'all-fields'});
                clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(data);
            };
        })`);
        if (cached.error || cached.modelFetches !== 0 || cached.phases.includes('download') || cached.refs.length !== 10) {
            throw new Error('Cache reuse failed: ' + JSON.stringify(cached));
        }
        const report = { query:'saw the end', refs:result.refs, posted:requests,
            cachedModelFiles:modelFiles, freshWorkerAfterReloadModelFetches:cached.modelFetches };
        report.sourceComparison = {};
        for (const [scope, expectedFirst, action] of [['translation', '22:64', 'enter'], ['all-fields', '29:45', 'click'], ['all-fields', '29:45', 'enter'], ['translation', '22:64', 'click']]) {
            await evaluate(`(() => {
                const form = document.querySelector('#result-search-mode').form;
                const source = form.querySelector('[data-meaning-source]');
                source.value = ${JSON.stringify(scope)}; source.dispatchEvent(new Event('change'));
                form.elements.query_str.value = 'What is the Importance of Prayer?';
                form.elements.query_str.focus();
                if (${JSON.stringify(action)} === 'click') form.querySelector('[type=submit]').click();
            })()`);
            if (action === 'enter') {
                await client.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13, text:'\r'});
                await client.send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
            }
            await waitFor(`document.querySelector('.surahlink')?.textContent.trim() === ${JSON.stringify(expectedFirst)} && !document.querySelector('form[aria-busy]')`);
            if (!(await evaluate(`document.querySelector('#result-search-mode').form.querySelector('[data-meaning-source]').value === ${JSON.stringify(scope)}`))) throw new Error('Source selection changed after ' + action);
            report.sourceComparison[scope + ':' + action] = await evaluate(`Array.from(document.querySelectorAll('.surahlink'), n => n.textContent.trim()).slice(0,5)`);
        }
        await evaluate(`(() => {
            const mode = document.querySelector('#result-search-mode');
            mode.value = 'keyword';
            mode.dispatchEvent(new Event('change'));
            mode.form.elements.query_str.value = 'light upon light';
            mode.form.requestSubmit();
        })()`);
        await waitFor(`document.querySelector('#result-search-mode')?.value === 'keyword'
            && [...document.querySelectorAll('.surahlink')].some(node => node.textContent.trim() === '24:35')`);
        await fs.mkdir('features/meaning_search/deployment/verification', {recursive:true});
        await fs.writeFile('features/meaning_search/deployment/verification/meaning-ui-cache.json', JSON.stringify(report,null,2));
        console.log('PASS: ten UI results; no technical copy; model reused after reload with zero model fetches.');
        console.log('Source comparison:', JSON.stringify(report.sourceComparison));
    } finally {
        socket?.close(); await stopChild(child); await removeDirectory(profile);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
