import { fuseScores, orderedWeights, rankScores, scorePassages } from './meaning-core.mjs';

const model = 'Xenova/multilingual-e5-small';
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const indexUrls = {
    translation: new URL('../meaning/index.json', import.meta.url),
    'all-fields': new URL('../meaning/all-fields-index.json', import.meta.url),
};
let encoderPromise;
const indexPromises = {};

async function loadEncoder() {
    const { env, pipeline } = await import(
        '../meaning/vendor/transformers-3.7.2/transformers.min.js'
    );
    env.allowLocalModels = true;
    env.localModelPath = new URL('../meaning/models/', import.meta.url).href;
    env.allowRemoteModels = false;
    env.backends.onnx.wasm.wasmPaths = new URL('../meaning/vendor/transformers-3.7.2/', import.meta.url).href;
    env.backends.onnx.wasm.numThreads = 1;
    return pipeline('feature-extraction', model, {
        revision, device: 'wasm', dtype: 'int8',
    });
}

function vectorNorms(vectors, count, dimensions) {
    const norms = new Float64Array(count);
    for (let row = 0; row < count; row += 1) {
        let sum = 0;
        const start = row * dimensions;
        for (let i = start; i < start + dimensions; i += 1) sum += vectors[i] ** 2;
        norms[row] = Math.sqrt(sum);
        if (norms[row] === 0) throw new Error('Meaning index contains a zero vector');
    }
    return norms;
}

async function loadVectors(url, dimensions, count, label, expectedSha256) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Missing ${label} vectors`);
    const buffer = await response.arrayBuffer();
    const vectors = new Int8Array(buffer);
    if (vectors.length !== count * dimensions) throw new Error(`Invalid ${label} vector length`);
    if (expectedSha256) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
        if (actual !== expectedSha256) throw new Error(`${label} vector hash mismatch`);
    }
    return { vectors, norms: vectorNorms(vectors, count, dimensions) };
}

async function loadIndex(scope) {
    const indexUrl = indexUrls[scope];
    if (!indexUrl) throw new Error('Unknown meaning-search scope');
    const response = await fetch(indexUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Missing meaning index');
    const manifest = await response.json();
    if (manifest.dimensions !== 384 || !Array.isArray(manifest.refs) || manifest.refs.length !== 6236) {
        throw new Error('Invalid meaning index');
    }
    if (new Set(manifest.refs).size !== manifest.refs.length) throw new Error('Duplicate meaning references');
    if (scope === 'translation') {
        const matrix = await loadVectors(new URL(manifest.file, indexUrl), manifest.dimensions, manifest.refs.length, 'meaning');
        return { ...manifest, ...matrix };
    }
    if (manifest.schema_version !== 2 || manifest.scope !== 'all-fields' || !Array.isArray(manifest.fields)) {
        throw new Error('Invalid all-fields meaning index');
    }
    const fields = await Promise.all(manifest.fields.map(async field => {
        if (!Array.isArray(field.passage_to_ayah) || field.passage_to_ayah.some(index =>
            !Number.isInteger(index) || index < 0 || index >= manifest.refs.length)) {
            throw new Error(`Invalid ${field.name} passage map`);
        }
        const matrix = await loadVectors(
            new URL(field.file, indexUrl), manifest.dimensions, field.passage_to_ayah.length, field.name, field.sha256,
        );
        return { ...field, passageToAyah: Int32Array.from(field.passage_to_ayah), ...matrix };
    }));
    return { ...manifest, fields };
}

function translationRanking(index, embedding) {
    const scores = index.refs.map((ref, row) => {
        let dot = 0;
        const start = row * index.dimensions;
        for (let i = 0; i < index.dimensions; i += 1) dot += index.vectors[start + i] * embedding[i];
        return { ref, score: dot / index.norms[row] };
    });
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, 10).map(row => row.ref);
}

self.onmessage = async ({ data }) => {
    const request = typeof data === 'string' ? { query: data, scope: 'translation' } : data;
    const scope = request.scope || 'translation';
    try {
        if (typeof request.query !== 'string' || !request.query.trim()) throw new Error('Empty meaning query');
        const loadStarted = performance.now();
        encoderPromise ??= loadEncoder();
        indexPromises[scope] ??= loadIndex(scope);
        const [encoder, index] = await Promise.all([encoderPromise, indexPromises[scope]]);
        const loadMs = performance.now() - loadStarted;
        const embeddingStarted = performance.now();
        const { data: embedding } = await encoder('query: ' + request.query, {
            pooling: 'mean', normalize: true, truncation: true, max_length: 512,
        });
        const embeddingMs = performance.now() - embeddingStarted;
        const scoringStarted = performance.now();
        let refs;
        let diagnostics;
        let fusion;
        if (scope === 'translation') {
            refs = translationRanking(index, embedding);
            if (request.diagnostics) diagnostics = { embedding: Array.from(embedding) };
        } else {
            const scores = index.fields.map(field => scorePassages(
                field.vectors, field.norms, field.passageToAyah, embedding,
                index.dimensions, index.refs.length,
            ));
            const configured = request.fusion || index.fusion;
            const method = configured.method;
            const weights = orderedWeights(index.fields, configured);
            const fused = fuseScores(scores, weights, method);
            const fusedRanking = rankScores(index.refs, fused);
            refs = fusedRanking.map(row => row.ref);
            fusion = { method, weights };
            if (request.diagnostics) {
                diagnostics = {
                    embedding: Array.from(embedding),
                    field_rankings: index.fields.map((field, fieldIndex) => ({
                        field: field.name,
                        rows: rankScores(index.refs, scores[fieldIndex]),
                    })),
                    fused_ranking: fusedRanking,
                };
            }
        }
        const scoringMs = performance.now() - scoringStarted;
        const assetHashes = scope === 'translation'
            ? { vectors: index.file }
            : {
                vectors: Object.fromEntries(index.fields.map(field => [field.name, field.sha256])),
                vector_bytes: index.assets.vector_bytes,
            };
        self.postMessage({
            scope, corpus: index.corpus, refs, fusion, diagnostics, assetHashes,
            timings: { load_ms: loadMs, embedding_ms: embeddingMs, scoring_ms: scoringMs },
        });
    } catch (error) {
        encoderPromise = undefined;
        delete indexPromises[scope];
        self.postMessage({ error: true, message: error instanceof Error ? error.message : String(error) });
    }
};
