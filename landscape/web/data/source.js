// Data access for the replay worker: JSON and byte ranges over HTTP (fetch + Range).
// Pure ES module (browser and Node 20 fetch). Tests can pass any object with the same
// shape ({json(path), bytes(path, start?, end?), describe()}).

/**
 * @param {string} baseUrl absolute URL of the data directory (ending in '/')
 * @param {{fetch?: typeof fetch}} [opts]
 */
export function httpSource(baseUrl, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch.bind(globalThis);
  const base = new URL(baseUrl, globalThis.location ? globalThis.location.href : undefined);
  const url = (path) => new URL(path, base).href;
  let requests = 0;
  let bytesFetched = 0;
  return {
    url,
    async json(path, { signal } = {}) {
      requests++;
      const r = await fetchImpl(url(path), { signal, cache: 'no-cache' });
      if (!r.ok) throw new Error('GET ' + url(path) + ' -> ' + r.status);
      const text = await r.text();
      bytesFetched += text.length;
      return JSON.parse(text);
    },
    /** Bytes [start, end) of a file (whole file when start is undefined). */
    async bytes(path, start, end, { signal } = {}) {
      requests++;
      const ranged = start !== undefined;
      if (ranged && !(end > start)) throw new RangeError('bytes: empty range ' + start + '-' + end + ' of ' + path);
      const headers = ranged ? { Range: 'bytes=' + start + '-' + (end - 1) } : undefined;
      const r = await fetchImpl(url(path), { headers, signal });
      if (r.status !== 200 && r.status !== 206) throw new Error('GET ' + url(path) + (ranged ? ' [' + start + ',' + end + ')' : '') + ' -> ' + r.status);
      let buf = new Uint8Array(await r.arrayBuffer());
      if (ranged && r.status === 200) buf = buf.subarray(start, end); // server ignored Range
      if (ranged && buf.byteLength !== end - start) {
        throw new Error('GET ' + url(path) + ' returned ' + buf.byteLength + ' bytes for range [' + start + ',' + end + ')');
      }
      bytesFetched += buf.byteLength;
      return buf;
    },
    stats() { return { requests, bytesFetched }; },
    describe() { return base.href; },
  };
}
