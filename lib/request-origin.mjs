// Runs only behind ctx.connection.fetch's owner and Host/Origin admission.
// rc.5 uses a synthetic URL in its Node->Fetch bridge and retains the original
// Host header. Do not compare a browser Origin to http://dsh.internal.
export function isSameOriginRequest(request) {
  try {
    if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') return false;
    const raw = request.headers.get('origin');
    if (raw === null) return true; // non-browser owner clients; host gate still required
    const origin = new URL(raw);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
        || origin.href !== origin.origin + '/') return false;
    const url = new URL(request.url);
    if (url.origin !== 'http://dsh.internal') return origin.origin === url.origin;
    const host = request.headers.get('host');
    if (!host || /[\s\\/?#@\x00-\x1f\x7f]/.test(host)) return false;
    const expected = new URL(origin.protocol + '//' + host);
    return !!expected.hostname && !expected.username && !expected.password
      && expected.pathname === '/' && !expected.search && !expected.hash
      && origin.origin === expected.origin;
  } catch { return false; }
}
