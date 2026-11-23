const model = 'Xenova/multilingual-e5-small';
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const indexUrl = new URL('../meaning/index.json', import.meta.url);
let encoderPromise;
let indexPromise;

async function loadEncoder() {
    const { env, pipeline } = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js'
    );
    env.allowLocalModels = new URL(import.meta.url).searchParams.has('local-model');
    env.localModelPath = new URL('../meaning/models/', import.meta.url).href;
    env.allowRemoteModels = !env.allowLocalModels;
    env.backends.onnx.wasm.numThreads = 1;
    return pipeline('feature-extraction', model, {
        revision, device: 'wasm', dtype: 'int8',
    });
}

async function loadIndex() {
    const response = await fetch(indexUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Missing meaning index');
    const { corpus, dimensions, file, refs } = await response.json();
    const matrix = await fetch(new URL(file, indexUrl));
    if (!matrix.ok) throw new Error('Missing meaning vectors');
    const vectors = new Int8Array(await matrix.arrayBuffer());
    if (dimensions !== 384 || vectors.length !== refs.length * dimensions) {
        throw new Error('Invalid meaning index');
    }
    const norms = refs.map((_, row) => {
        let sum = 0;
        const start = row * dimensions;
        for (let i = start; i < start + dimensions; i++) sum += vectors[i] ** 2;
        return Math.sqrt(sum);
    });
    return { corpus, dimensions, refs, vectors, norms };
}

self.onmessage = async ({ data: query }) => {
    try {
        encoderPromise ??= loadEncoder();
        indexPromise ??= loadIndex();
        const [encoder, index] = await Promise.all([encoderPromise, indexPromise]);
        const { data: embedding } = await encoder('query: ' + query, {
            pooling: 'mean', normalize: true, truncation: true, max_length: 512,
        });
        const scores = index.refs.map((ref, row) => {
            let dot = 0;
            const start = row * index.dimensions;
            for (let i = 0; i < index.dimensions; i++) dot += index.vectors[start + i] * embedding[i];
            return { ref, score: dot / index.norms[row] };
        });
        scores.sort((a, b) => b.score - a.score);
        self.postMessage({ corpus: index.corpus, refs: scores.slice(0, 10).map(row => row.ref) });
    } catch {
        encoderPromise = undefined;
        indexPromise = undefined;
        self.postMessage({ error: true });
    }
};
