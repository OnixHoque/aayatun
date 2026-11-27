// Keep cache keys on our origin while downloading pinned model files from HF first.
export async function fetchModelFile(url, init, {
    fetchImpl, localRoot, remoteRoot, localOnly = false, timeoutMs = 10000,
}) {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (localOnly || !address.startsWith(localRoot)) return fetchImpl(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(remoteRoot + address.slice(localRoot.length), {
            ...init, signal: controller.signal,
        });
        if (response.ok) return response;
    } catch {
        // Missing/blocked/unreachable HF assets use the identical local snapshot.
    } finally {
        clearTimeout(timer);
    }
    return fetchImpl(url, init);
}
