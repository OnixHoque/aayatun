// Run the production meaning worker against an IslamQA validation or test fixture.
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const HERE = __dirname;
const WORKSPACE = path.resolve(HERE, '..', '..');
const DEFAULT_ROOT = path.resolve(HERE, '..');
const DEFAULT_MODEL_ROOT = path.join(DEFAULT_ROOT, 'static', 'meaning', 'models');
const DEFAULT_FIXTURE = path.join(HERE, 'islamqa_pr2_test_queries.jsonl');
const DEFAULT_MANIFEST = path.join(HERE, 'islamqa_pr2_fixture_manifest.json');
const DEFAULT_OUTPUT = path.join(HERE, 'islamqa_pr2_meaning_rankings.json');
const DEFAULT_CHROME = 'C:\\Users\\mehra\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const PRODUCT_COMMIT = '357a367ef4631cb771cdd9e3a34116280c7dd2d8';
const MODEL_FILE_SHA256 = {
    'Xenova/multilingual-e5-small/config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
    'Xenova/multilingual-e5-small/tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    'Xenova/multilingual-e5-small/tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
    'Xenova/multilingual-e5-small/onnx/model_int8.onnx': '4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c',
};

function parseArgs() {
    const args = {};
    for (let index = 0; index < process.argv.length; index += 1) {
        const token = process.argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = process.argv[index + 1];
        if (!next || next.startsWith('--')) args[key] = true;
        else {
            args[key] = next;
            index += 1;
        }
    }
    return args;
}

function sha256File(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function textSha256File(filename) {
    const normalized = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function assertPinnedAsset(root, relative) {
    const workingBlob = execFileSync('git', ['-C', root, 'hash-object', '--', relative], {
        encoding: 'utf8',
    }).trim();
    const committedBlob = execFileSync(
        'git', ['-C', root, 'rev-parse', `${PRODUCT_COMMIT}:${relative}`],
        { encoding: 'utf8' },
    ).trim();
    if (workingBlob !== committedBlob) {
        throw new Error(`Working-tree asset differs from ${PRODUCT_COMMIT}: ${relative}`);
    }
}

function assertPinnedFile(filename, expected, label) {
    const actual = sha256File(filename);
    if (actual !== expected) {
        throw new Error(`${label} hash mismatch: expected ${expected}, got ${actual}`);
    }
    return actual;
}

function verifyModelFiles(modelRoot) {
    return Object.fromEntries(Object.entries(MODEL_FILE_SHA256).map(([relative, expected]) => [
        relative,
        assertPinnedFile(path.join(modelRoot, relative), expected, `E5 model ${relative}`),
    ]));
}

function readFixture(filename, manifestFilename) {
    const data = fs.readFileSync(filename);
    const manifest = JSON.parse(fs.readFileSync(manifestFilename, 'utf8'));
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== manifest.fixture_sha256) throw new Error('Fixture hash mismatch');
    const cases = data.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (cases.length !== manifest.counts.query_cases) throw new Error('Fixture count mismatch');
    return { cases, manifest, digest };
}

function contentType(filename) {
    const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.bin': 'application/octet-stream',
        '.onnx': 'application/octet-stream',
        '.wasm': 'application/wasm',
    };
    return types[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function safeFile(root, relative) {
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('Invalid path');
    }
    return resolved;
}

async function serve(appRoot, modelRoot) {
    const modelPrefix = '/static/meaning/models/';
    const transfers = {};
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            let decoded = decodeURIComponent(url.pathname);
            let root = appRoot;
            if (decoded.startsWith(modelPrefix)) {
                root = modelRoot;
                decoded = decoded.slice(modelPrefix.length);
            } else {
                decoded = decoded.replace(/^\/+/, '');
            }
            const filename = safeFile(root, decoded);
            const stat = await fsp.stat(filename);
            if (!stat.isFile()) throw new Error('Not a file');
            const headers = {
                'Content-Type': contentType(filename),
                'Content-Length': stat.size,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
            };
            let start = 0;
            let end = stat.size - 1;
            let status = 200;
            const range = request.headers.range;
            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match) {
                    response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                    response.end();
                    return;
                }
                if (match[1] === '') {
                    start = Math.max(0, stat.size - Number(match[2]));
                } else {
                    start = Number(match[1]);
                    if (match[2] !== '') end = Math.min(end, Number(match[2]));
                }
                if (start > end || start >= stat.size) {
                    response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                    response.end();
                    return;
                }
                status = 206;
                headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
                headers['Content-Length'] = end - start + 1;
            }
            const transferStarted = performance.now();
            response.on('finish', () => {
                const previous = transfers[url.pathname] || { bytes: 0, server_ms: 0, requests: 0 };
                previous.bytes += request.method === 'HEAD' ? 0 : end - start + 1;
                previous.server_ms += performance.now() - transferStarted;
                previous.requests += 1;
                transfers[url.pathname] = previous;
            });
            response.writeHead(status, headers);
            if (request.method === 'HEAD') {
                response.end();
                return;
            }
            await new Promise((resolve, reject) => {
                const stream = fs.createReadStream(filename, { start, end });
                stream.on('error', reject);
                stream.on('end', resolve);
                stream.pipe(response);
            });
        } catch (error) {
            if (!response.headersSent) response.writeHead(404);
            response.end('Not found');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, base: `http://127.0.0.1:${address.port}`, transfers };
}

async function waitForPort(userDataDir, timeoutMs) {
    const filename = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const text = await fsp.readFile(filename, 'utf8');
            const port = Number(text.split(/\r?\n/)[0]);
            if (port) return port;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Chromium remote debugging port did not appear');
}

class CdpClient {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
                else pending.resolve(message.result);
                return;
            }
            const callbacks = this.listeners.get(message.method) || [];
            for (const callback of callbacks) callback(message.params);
        });
    }

    on(method, callback) {
        const callbacks = this.listeners.get(method) || [];
        callbacks.push(callback);
        this.listeners.set(method, callbacks);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
}

async function connect(port) {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Could not create Chromium target: ${response.status}`);
    const target = await response.json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    return { client: new CdpClient(socket), socket, target };
}

async function stopChild(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    let timer;
    try {
        await Promise.race([
            exited,
            new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
}

async function removeDirectory(directory, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fsp.rm(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
}

async function closeServer(server) {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

async function main() {
    const args = parseArgs();
    const root = path.resolve(args.root || DEFAULT_ROOT);
    const modelRoot = path.resolve(args['model-root'] || DEFAULT_MODEL_ROOT);
    const fixturePath = path.resolve(args.fixture || DEFAULT_FIXTURE);
    const manifestPath = path.resolve(args.manifest || DEFAULT_MANIFEST);
    const outputPath = path.resolve(args.output || DEFAULT_OUTPUT);
    const scope = args.scope || 'translation';
    if (!['translation', 'all-fields'].includes(scope)) throw new Error('--scope must be translation or all-fields');
    const fusion = args.fusion ? JSON.parse(fs.readFileSync(path.resolve(args.fusion), 'utf8')) : null;
    const chromePath = args.chrome || process.env.AAYATUN_CHROME || DEFAULT_CHROME;
    const timeoutMs = Number(args.timeout || 180000);
    const attempts = Number(args.attempts || 2);
    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new Error('--attempts must be a positive integer');
    }
    const rootRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim();
    const { cases, manifest, digest } = readFixture(fixturePath, manifestPath);
    const selected = args.query ? [{ id: 'manual-query', query: args.query }]
        : args.limit ? cases.slice(0, Number(args.limit)) : cases;

    const workerPath = path.join(root, 'static', 'js', 'meaning-worker.js');
    const indexRelative = scope === 'all-fields' ? 'static/meaning/all-fields-index.json' : 'static/meaning/index.json';
    const indexPath = path.join(root, indexRelative);
    const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
    const vectorHashes = {};
    if (scope === 'translation') {
        if (index.corpus !== manifest.corpus.sha256) throw new Error('Meaning index corpus mismatch');
        vectorHashes.translation = sha256File(path.join(root, 'static', 'meaning', index.file));
        if (!args['allow-working-tree']) {
            assertPinnedAsset(root, 'static/js/meaning-worker.js');
            assertPinnedAsset(root, indexRelative);
            assertPinnedAsset(root, `static/meaning/${index.file}`);
        }
    } else {
        if (index.scope !== 'all-fields' || index.schema_version !== 2) throw new Error('Invalid all-fields index');
        const translation = index.fields.find(field => field.name === 'en');
        if (!translation || translation.corpus_sha256 !== manifest.corpus.sha256) {
            throw new Error('All-fields translation corpus mismatch');
        }
        for (const field of index.fields) {
            const actual = sha256File(path.join(root, 'static', 'meaning', field.file));
            if (actual !== field.sha256) throw new Error(`${field.name} vector hash mismatch`);
            vectorHashes[field.name] = actual;
        }
    }
    const workerHash = textSha256File(workerPath);
    const coreHash = scope === 'all-fields'
        ? textSha256File(path.join(root, 'static', 'js', 'meaning-core.mjs')) : null;
    const indexHash = textSha256File(indexPath);
    const vectorsHash = scope === 'translation'
        ? vectorHashes.translation
        : crypto.createHash('sha256').update(JSON.stringify(vectorHashes)).digest('hex');
    const modelFiles = verifyModelFiles(modelRoot);

    const { server, base, transfers } = await serve(root, modelRoot);
    const chromeErrors = [];
    let userDataDir;
    let child;
    let socket;
    let failure;
    const cleanupErrors = [];
    try {
        userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aayatun-pr2-'));
        child = spawn(chromePath, [
            '--headless=new',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            ...(args.offline ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--disable-background-networking'] : []),
            '--remote-debugging-port=0',
            '--remote-allow-origins=*',
            `--user-data-dir=${userDataDir}`,
            'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        child.stderr.on('data', chunk => {
            chromeErrors.push(chunk.toString());
            if (chromeErrors.length > 20) chromeErrors.shift();
        });
        const childFailure = new Promise((resolve, reject) => child.once('error', reject));
        const port = await Promise.race([waitForPort(userDataDir, 30000), childFailure]);
        const connected = await connect(port);
        socket = connected.socket;
        const { client } = connected;
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        const version = await client.send('Browser.getVersion');
        const loaded = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Page load timed out')), 30000);
            client.on('Page.loadEventFired', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        await client.send('Page.navigate', { url: `${base}/${indexRelative}` });
        await loaded;
        const workerSetup = `
            window.meaningWorker = new Worker('/static/js/meaning-worker.js?local-model', { type: 'module' });
            window.__runMeaning = query => new Promise((resolve, reject) => {
                const start = performance.now();
                const timer = setTimeout(() => reject(new Error('Meaning worker timed out')), ${timeoutMs});
                window.meaningWorker.onmessage = ({ data }) => {
                    clearTimeout(timer);
                    if (data.error) reject(new Error(data.message || 'Meaning worker failed'));
                    else resolve({ ...data, ms: Math.round(performance.now() - start) });
                };
                window.meaningWorker.onerror = event => reject(new Error(event.message || 'Meaning worker error'));
                window.meaningWorker.postMessage(${scope === 'translation' ? 'query' : `{ query, scope: 'all-fields', diagnostics: true${fusion ? `, fusion: ${JSON.stringify(fusion)}` : ''} }`});
            });
        `;
        const setupResponse = await client.send('Runtime.evaluate', { expression: workerSetup });
        if (setupResponse.exceptionDetails) {
            throw new Error(setupResponse.exceptionDetails.exception?.description || 'Worker setup failed');
        }

        const runs = {};
        const timings = [];
        for (let position = 0; position < selected.length; position += 1) {
            const testCase = selected[position];
            let result;
            const errors = [];
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                try {
                    const response = await client.send('Runtime.evaluate', {
                        expression: `window.__runMeaning(${JSON.stringify(testCase.query)})`,
                        awaitPromise: true,
                        returnByValue: true,
                        timeout: timeoutMs + 5000,
                    });
                    if (response.exceptionDetails) {
                        throw new Error(response.exceptionDetails.exception?.description || 'Evaluation failed');
                    }
                    result = response.result.value;
                    if (!result || result.error || !Array.isArray(result.refs)) {
                        throw new Error('Meaning worker returned an invalid result');
                    }
                    break;
                } catch (error) {
                    errors.push(error.message);
                    if (attempt < attempts) {
                        const retryResponse = await client.send('Runtime.evaluate', {
                            expression: `window.meaningWorker.terminate();\n${workerSetup}`,
                        });
                        if (retryResponse.exceptionDetails) {
                            throw new Error(retryResponse.exceptionDetails.exception?.description || 'Worker retry setup failed');
                        }
                    }
                }
            }
            if (!result) throw new Error(`${testCase.id}: ${errors.join('; ')}`);
            if (result.corpus !== index.corpus) throw new Error(`${testCase.id}: corpus hash mismatch`);
            if (result.refs.length !== 10 || new Set(result.refs).size !== 10) {
                throw new Error(`${testCase.id}: expected ten unique ranked ayat`);
            }
            if (scope === 'all-fields' && (
                result.scope !== 'all-fields' || result.diagnostics?.embedding?.length !== 384 ||
                result.diagnostics?.field_rankings?.length !== index.fields.length ||
                result.diagnostics?.fused_ranking?.length !== 10
            )) {
                throw new Error(`${testCase.id}: incomplete all-fields diagnostics`);
            }
            runs[testCase.id] = {
                query: testCase.query,
                refs: result.refs, ms: result.ms, attempts: errors.length + 1,
                worker_timings: result.timings,
                ...(scope === 'all-fields' ? {
                    embedding: result.diagnostics.embedding,
                    field_rankings: result.diagnostics.field_rankings,
                    fused_ranking: result.diagnostics.fused_ranking,
                    fusion: result.fusion,
                } : {}),
            };
            timings.push(result.ms);
            if (position === 0 || (position + 1) % 25 === 0) {
                console.log(`Meaning queries ${position + 1}/${selected.length}, last ${result.ms} ms`);
            }
        }
        const warm = timings.slice(1).sort((a, b) => a - b);
        const coldTransfers = Object.fromEntries(Object.entries(transfers).filter(([name]) =>
            name.startsWith('/static/meaning/')));
        const resourceTimings = await client.send('Runtime.evaluate', {
            expression: `performance.getEntriesByType('resource')
                .filter(entry => entry.name.includes('/static/meaning/'))
                .map(entry => ({name: entry.name, duration_ms: entry.duration,
                    transfer_size: entry.transferSize, decoded_body_size: entry.decodedBodySize}))`,
            returnByValue: true,
        });
        const report = {
            engine: 'Aayatun PR #2 Search by meaning',
            external_dns_blocked: Boolean(args.offline),
            product_commit: scope === 'translation' ? PRODUCT_COMMIT : rootRevision,
            root_revision: rootRevision,
            scope,
            working_tree_assets: scope === 'all-fields' || Boolean(args['allow-working-tree']),
            worker_sha256: workerHash,
            worker_core_sha256: coreHash,
            index_sha256: indexHash,
            vectors_sha256: vectorsHash,
            asset_hashes: { index_sha256: indexHash, vectors: vectorHashes },
            model_config_sha256: modelFiles['Xenova/multilingual-e5-small/config.json'],
            model_tokenizer_sha256: modelFiles['Xenova/multilingual-e5-small/tokenizer.json'],
            model_tokenizer_config_sha256: modelFiles['Xenova/multilingual-e5-small/tokenizer_config.json'],
            model_weights_sha256: modelFiles['Xenova/multilingual-e5-small/onnx/model_int8.onnx'],
            model_files: modelFiles,
            corpus: index.corpus,
            fixture: path.basename(fixturePath),
            fixture_sha256: digest,
            model: 'Xenova/multilingual-e5-small',
            model_revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
            dtype: 'int8',
            model_delivery: 'local static mirror',
            runtime_delivery: 'bundled same-origin Transformers.js 3.7.2 and ONNX/WASM',
            browser: version.product,
            first_query_ms: timings[0],
            warm_p50_ms: warm.length ? warm[Math.ceil(warm.length * 0.5) - 1] : null,
            warm_p95_ms: warm.length ? warm[Math.ceil(warm.length * 0.95) - 1] : null,
            cold_asset_transfer: {
                bytes: Object.values(coldTransfers).reduce((sum, row) => sum + row.bytes, 0),
                server_ms: Object.values(coldTransfers).reduce((sum, row) => sum + row.server_ms, 0),
                requests: Object.values(coldTransfers).reduce((sum, row) => sum + row.requests, 0),
                resources: coldTransfers,
                browser_resources: resourceTimings.result?.value || [],
                basis: 'fresh Chromium profile, loopback static server, no-store responses',
            },
            runs,
        };
        await fsp.mkdir(path.dirname(outputPath), { recursive: true });
        await fsp.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
        console.log(JSON.stringify({ output: outputPath, queries: Object.keys(runs).length }, null, 2));
    } catch (error) {
        if (chromeErrors.length) console.error(chromeErrors.join(''));
        failure = error;
    } finally {
        try {
            if (socket) socket.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await stopChild(child);
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            await closeServer(server);
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            if (userDataDir) await removeDirectory(userDataDir);
        } catch (error) {
            cleanupErrors.push(error);
        }
    }
    if (failure || cleanupErrors.length) {
        const errors = cleanupErrors.length ? [failure, ...cleanupErrors].filter(Boolean) : [failure];
        throw errors.length === 1 ? errors[0] : new AggregateError(errors, failure?.message || 'Browser cleanup failed');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
