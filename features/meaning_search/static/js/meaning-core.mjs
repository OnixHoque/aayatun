// Pure scoring helpers shared by the meaning worker and its deterministic tests.
export function roundScore(value) {
    if (!Number.isFinite(value)) return value;
    const scaled = Math.abs(value) * 1e12;
    return Math.sign(value) * Math.round(scaled) / 1e12;
}

export function validateWeights(weights) {
    if (!weights || typeof weights !== 'object') throw new Error('Missing fusion weights');
    const values = Object.values(weights);
    if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) {
        throw new Error('Fusion weights must be finite and nonnegative');
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > 1e-9) throw new Error('Fusion weights must sum to one');
}

export function orderedWeights(fields, configured) {
    if (!configured || typeof configured !== 'object') throw new Error('Missing fusion configuration');
    validateWeights(configured.weights);
    const weights = {};
    for (const field of fields) {
        const value = configured.weights[field.name];
        if (!Number.isFinite(value) || value < 0) throw new Error(`Missing weight for ${field.name}`);
        weights[field.name] = value;
    }
    validateWeights(weights);
    return weights;
}

export function scorePassages(vectors, norms, passageToAyah, query, dimensions, ayahCount) {
    const scores = new Float64Array(ayahCount).fill(-Infinity);
    for (let passage = 0; passage < passageToAyah.length; passage += 1) {
        let dot = 0;
        const start = passage * dimensions;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            dot += vectors[start + dimension] * query[dimension];
        }
        const score = roundScore(dot / norms[passage]);
        const ayah = passageToAyah[passage];
        if (score > scores[ayah]) scores[ayah] = score;
    }
    return scores;
}

export function zScores(scores) {
    const result = new Float64Array(scores.length).fill(NaN);
    let count = 0;
    let mean = 0;
    for (const score of scores) {
        if (!Number.isFinite(score)) continue;
        count += 1;
        mean += score;
    }
    if (!count) return result;
    mean /= count;
    let variance = 0;
    for (const score of scores) {
        if (Number.isFinite(score)) variance += (score - mean) ** 2;
    }
    const deviation = Math.sqrt(variance / count);
    for (let index = 0; index < scores.length; index += 1) {
        if (!Number.isFinite(scores[index])) continue;
        result[index] = deviation > 0 ? roundScore((scores[index] - mean) / deviation) : 0;
    }
    return result;
}

export function fuseScores(fieldScores, weights, method) {
    validateWeights(weights);
    if (method !== 'weighted_raw' && method !== 'weighted_z') {
        throw new Error('Unknown fusion method');
    }
    const values = Object.values(weights);
    const prepared = method === 'weighted_z' ? fieldScores.map(zScores) : fieldScores;
    const count = fieldScores[0]?.length || 0;
    const result = new Float64Array(count).fill(-Infinity);
    for (let ayah = 0; ayah < count; ayah += 1) {
        let numerator = 0;
        let denominator = 0;
        for (let field = 0; field < prepared.length; field += 1) {
            const score = prepared[field][ayah];
            if (!Number.isFinite(score)) continue;
            numerator += values[field] * score;
            denominator += values[field];
        }
        if (denominator > 0) result[ayah] = roundScore(numerator / denominator);
    }
    return result;
}

export function rankScores(refs, scores, limit = 10) {
    const indices = [];
    for (let index = 0; index < scores.length; index += 1) {
        if (Number.isFinite(scores[index])) indices.push(index);
    }
    indices.sort((left, right) => scores[right] - scores[left] || left - right);
    return indices.slice(0, limit).map(index => ({ ref: refs[index], score: scores[index] }));
}
