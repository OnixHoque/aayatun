import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelFile } from '../static/js/meaning-model-source.mjs';

const localRoot = 'http://localhost/static/meaning/models/Xenova/multilingual-e5-small/';
const remoteRoot = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/';
const file = 'onnx/model_int8.onnx';

test('successful HF download never requests local model bytes', async () => {
    const calls = [];
    const response = await fetchModelFile(localRoot + file, {}, { localRoot, remoteRoot,
        fetchImpl: async url => { calls.push(url); return new Response('model'); } });
    assert.equal(await response.text(), 'model');
    assert.deepEqual(calls, [remoteRoot + file]);
});

for (const failure of ['404', 'network', 'timeout']) {
    test(`HF ${failure} falls back to the local snapshot`, async () => {
        const calls = [];
        const response = await fetchModelFile(localRoot + file, {}, { localRoot, remoteRoot, timeoutMs: 5,
            fetchImpl: async (url, init) => {
                calls.push(url);
                if (url === localRoot + file) return new Response('local');
                if (failure === '404') return new Response('', { status: 404 });
                if (failure === 'network') throw new TypeError('Unavailable');
                return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('Timeout'))));
            } });
        assert.equal(await response.text(), 'local');
        assert.deepEqual(calls, [remoteRoot + file, localRoot + file]);
    });
}

test('forced local mode and non-model assets never contact HF', async () => {
    const calls = [];
    const fetchImpl = async url => { calls.push(url); return new Response('local'); };
    await fetchModelFile(localRoot + file, {}, { localRoot, remoteRoot, fetchImpl, localOnly: true });
    await fetchModelFile('http://localhost/static/meaning/index.json', {}, { localRoot, remoteRoot, fetchImpl });
    assert.deepEqual(calls, [localRoot + file, 'http://localhost/static/meaning/index.json']);
});
