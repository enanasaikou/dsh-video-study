import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAuthSettings } from '../lib/auth-settings.mjs';
import { BiliAuthError } from '../lib/bili-auth.mjs';

const ORIGIN = 'http://127.0.0.1:6626';
const FLOW = 'a'.repeat(36);
const SECRET = 'DO-NOT-RETURN-COOKIE';
const QR = 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=OFFLINE-FIXTURE';
function setup(overrides = {}, options) {
  const calls = [];
  let account = { source: 'anonymous', loginStatus: 'anonymous', storage: { encrypted: false, persistent: false },
    lastCheckedAt: null, credentialAvailable: false, qr: null,
    cookie: SECRET, uid: 'PRIVATE-UID', path: '/private/cookies', token: 'PRIVATE-TOKEN' };
  const fake = {
    async status() { calls.push(['status']); return account; },
    async startQr() { calls.push(['start']); return { flowId: FLOW, qrUrl: QR, expiresAt: Date.now() + 120000,
      pollIntervalMs: 2000, status: 'waiting_scan', cookie: SECRET }; },
    async pollQr(id) { calls.push(['poll', id]); account = { ...account, source: 'managed', loginStatus: 'authenticated',
      credentialAvailable: true }; return { flowId: id, status: 'success', expiresAt: Date.now() + 120000 }; },
    async cancelQr(id) { calls.push(['cancel', id]); return { ...account, status: 'cancelled' }; },
    async check() { calls.push(['check']); return account; },
    async importCookie(value) { calls.push(['import', value]); return { ...account, source: 'managed', loginStatus: 'unverified', cookie: value }; },
    async logout() { calls.push(['logout']); return { ...account, source: 'anonymous', loginStatus: 'anonymous' }; },
    credentialForRequest() { throw new Error('MUST NEVER BE ROUTED'); },
    ...overrides,
  };
  const routes = new Map();
  const ctx = { connection: { fetch: { register(definition) { routes.set(definition.path.split('/').at(-1), definition); return definition; } } } };
  registerAuthSettings(ctx, fake, options);
  async function request(action, data, custom = {}) {
    const method = custom.method ?? (action === 'status' ? 'GET' : 'POST');
    const headers = { Origin: ORIGIN, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...custom.headers };
    const init = { method, headers };
    if (method !== 'GET') init.body = custom.body ?? JSON.stringify(data ?? {});
    if (custom.duplex) init.duplex = 'half';
    return routes.get(action).fetch(new Request((custom.url ?? `${ORIGIN}/api/video-study/auth/${action}`), init));
  }
  return { calls, routes, request };
}
async function json(response) { const text = await response.text(); return { text, data: JSON.parse(text), response }; }

test('only seven fixed owner-gated connection routes exist; no credential/LLM/raw server route', () => {
  const { routes } = setup();
  assert.deepEqual([...routes.keys()], ['status', 'start', 'poll', 'cancel', 'check', 'import', 'logout']);
  for (const [action, route] of routes) {
    assert.deepEqual(route.methods, [action === 'status' ? 'GET' : 'POST']);
    assert.equal(route.requestBody, action === 'status' ? 'buffered' : 'streaming');
    assert.equal(route.path, `/api/video-study/auth/${action}`);
  }
  assert.equal(routes.has('credentialForRequest'), false);
});

test('status does not start login, exposes only safe state and has no cache/CORS', async () => {
  const { request, calls } = setup();
  const { data, response, text } = await json(await request('status'));
  assert.equal(data.source, 'anonymous');
  assert.equal(data.loginStatus, 'anonymous');
  assert.deepEqual(calls, [['status']]);
  assert.equal(text.includes(SECRET), false);
  for (const privateField of ['uid', 'path', 'token', 'cookie']) assert.equal(privateField in data, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('QR URL is returned only by explicit start, while poll merges account state offline', async () => {
  const { request } = setup();
  const start = (await json(await request('start'))).data;
  assert.equal(start.qrUrl, QR);
  assert.equal(start.flowId, FLOW);
  const poll = (await json(await request('poll', { flowId: FLOW }))).data;
  assert.equal(poll.status, 'success');
  assert.equal(poll.loginStatus, 'authenticated');
  assert.equal(poll.source, 'managed');
  assert.equal('qrUrl' in poll, false);
  assert.equal(JSON.stringify(poll).includes(SECRET), false);
});

test('cross-site/foreign/null/path origins are rejected before any auth call', async () => {
  for (const headers of [{ Origin: 'https://evil.invalid' }, { Origin: 'null' },
    { Origin: `${ORIGIN}/evil` }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const { request, calls } = setup();
    assert.equal((await request('start', {}, { headers })).status, 403);
    assert.equal(calls.length, 0);
  }
});

test('native internal bridge URL accepts the real browser Host/Origin pair', async () => {
  const { request, calls } = setup();
  const headers = { Host: new URL(ORIGIN).host, Origin: ORIGIN };
  assert.equal((await request('check', {}, { headers, url: 'http://dsh.internal/api/video-study/auth/check' })).status, 200);
  assert.deepEqual(calls, [['check']]);
});

test('internal bridge URL still rejects foreign Origin, missing Host and cross-site requests', async () => {
  for (const headers of [
    { Host: new URL(ORIGIN).host, Origin: 'http://evil.invalid' },
    { Origin: ORIGIN },
    { Host: new URL(ORIGIN).host, Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const { request, calls } = setup();
    assert.equal((await request('check', {}, { headers, url: 'http://dsh.internal/api/video-study/auth/check' })).status, 403);
    assert.equal(calls.length, 0);
  }
});

test('same-origin mount URLs are accepted without assuming root deployment', async () => {
  const { request } = setup();
  assert.equal((await request('status', undefined, { url: `${ORIGIN}/mount/api/video-study/auth/status` })).status, 200);
});

test('missing Origin is allowed only behind the existing connection owner gate', async () => {
  const { routes, calls } = setup();
  const response = await routes.get('status').fetch(new Request(`${ORIGIN}/api/video-study/auth/status`));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['status']]);
});

test('GET cannot mutate and POST cannot bypass a GET-only status handler', async () => {
  const { request, calls } = setup();
  assert.equal((await request('start', undefined, { method: 'GET' })).status, 405);
  assert.equal((await request('status', {}, { method: 'POST' })).status, 405);
  assert.equal(calls.length, 0);
});

test('strict JSON content type, valid object body and no query/body extra fields', async () => {
  const cases = [
    ['start', {}, { headers: { 'Content-Type': 'text/plain' } }, 415],
    ['start', {}, { body: '[]' }, 400],
    ['start', {}, { body: 'null' }, 400],
    ['start', {}, { body: '{bad' }, 400],
    ['start', { credential: SECRET }, {}, 400],
    ['status', undefined, { url: `${ORIGIN}/api/video-study/auth/status?cookie=${SECRET}` }, 400],
  ];
  for (const [action, data, custom, status] of cases) {
    const fixture = setup();
    const result = await json(await fixture.request(action, data, custom));
    assert.equal(result.response.status, status);
    assert.equal(result.text.includes(SECRET), false);
    assert.equal(fixture.calls.length, 0);
  }
});

test('declared and streamed bodies are capped before auth invocation', async () => {
  const first = setup();
  assert.equal((await first.request('import', {}, { headers: { 'Content-Length': '131073' }, body: '{}' })).status, 413);
  assert.equal(first.calls.length, 0);
  const second = setup();
  assert.equal((await second.request('import', {}, { body: JSON.stringify({ text: 'x'.repeat(131073) }) })).status, 413);
  assert.equal(second.calls.length, 0);
});

test('Cookie import caps decoded UTF-8 bytes and never echoes content', async () => {
  const fixture = setup();
  const value = `SESSDATA=${SECRET}; bili_jct=fixture`;
  const result = await json(await fixture.request('import', { text: value }));
  assert.deepEqual(fixture.calls[0], ['import', value]);
  assert.equal(result.data.loginStatus, 'unverified');
  assert.equal(result.text.includes(SECRET), false);
  const tooBig = setup();
  assert.equal((await tooBig.request('import', { text: '中'.repeat(22000) })).status, 413);
  assert.equal(tooBig.calls.length, 0);
});

test('unknown private operation names and invalid flow IDs never reach service', async () => {
  const { request, routes, calls } = setup();
  assert.equal(routes.has('markRejected'), false);
  for (const flowId of ['', '../cookies', SECRET + '?token=value', 123])
    assert.equal((await request('poll', { flowId })).status, 400);
  assert.equal(calls.length, 0);
});

test('cancel/check/logout fixed methods work; optional cancellation can clear a pending start', async () => {
  const { request, calls } = setup();
  assert.equal((await json(await request('cancel'))).data.status, 'cancelled');
  assert.equal((await request('check')).status, 200);
  assert.equal((await request('logout')).status, 200);
  assert.deepEqual(calls, [['cancel', undefined], ['check'], ['logout']]);
});

test('auth exceptions expose only whitelisted codes, not upstream messages or credentials', async () => {
  for (const code of ['network_error', 'invalid_cookie', 'unsupported_qr_url', 'unknown_code']) {
    const { request } = setup({ async check() { throw Object.assign(new Error(`https://bad.invalid/?token=${SECRET}`), { code }); } });
    const result = await json(await request('check'));
    assert.equal(result.data.code, code === 'unknown_code' ? 'auth_failed' : code);
    assert.equal(result.text.includes(SECRET), false);
    assert.equal(result.text.includes('bad.invalid'), false);
  }
});

test('start route supports account official QR shape and legacy passport/default TLS port', async () => {
  for (const qrUrl of [
    'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=OFFLINE-FIXTURE',
    QR, 'https://passport.bilibili.com:443/h5-app/passport/login/scan?qrcode_key=OFFLINE-FIXTURE',
  ]) {
    const { request } = setup({ async startQr() { return { flowId: FLOW, qrUrl, expiresAt: Date.now() + 10000,
      status: 'waiting_scan', qrcode_key: SECRET, upstreamBody: SECRET, uid: SECRET }; } });
    const result = await json(await request('start'));
    assert.equal(result.response.status, 200);
    assert.equal(result.data.qrUrl, qrUrl);
    assert.equal(result.data.status, 'waiting_scan');
    assert.equal(result.text.includes(SECRET), false);
    assert.equal('upstreamBody' in result.data, false);
  }
});

test('unsafe QR URLs return unsupported_qr_url without source host, URL, key or body', async () => {
  const urls = ['https://evil.invalid/scan', 'https://account.bilibili.com.evil.invalid/scan',
    'https://x.account.bilibili.com/scan', 'https://x.passport.bilibili.com/scan',
    'http://account.bilibili.com/scan', 'http://passport.bilibili.com/scan',
    'https://account.bilibili.com:8443/scan', 'https://passport.bilibili.com:80/scan',
    'https://user:pass@account.bilibili.com/scan', 'https://@passport.bilibili.com/scan',
    'https://account.bilibili.com/scan#', 'https://passport.bilibili.com/scan#fragment',
    'https://account.bilibili.com/scan\u0000', 'https://account.bilibili.com/scan\u007f',
    'https://account.bilibili.com/scan\n', 'https://account.bilibili.com\\evil.invalid/scan'];
  for (const base of urls) {
    const qrUrl = base + '?qrcode_key=' + SECRET;
    const { request } = setup({ async startQr() { return { flowId: FLOW, qrUrl, expiresAt: Date.now() + 10000,
      upstreamBody: { url: qrUrl, qrcode_key: SECRET } }; } });
    const result = await json(await request('start'));
    assert.equal(result.response.status, 502);
    assert.equal(result.data.code, 'unsupported_qr_url');
    for (const sensitive of [SECRET, 'bilibili.com', 'evil.invalid', 'qrcode_key', 'upstreamBody', 'user:pass'])
      assert.equal(result.text.includes(sensitive), false);
    assert.equal('qrUrl' in result.data, false);
  }
});

test('backend unsupported_qr_url is preserved safely by start RPC', async () => {
  const { request } = setup({ async startQr() { throw new BiliAuthError('unsupported_qr_url'); } });
  const result = await json(await request('start'));
  assert.equal(result.response.status, 502);
  assert.equal(result.data.code, 'unsupported_qr_url');
  assert.equal(result.text.includes('bilibili.com'), false);
  assert.equal(result.text.includes(SECRET), false);
});

test('slow body streams have a finite deadline and are cancelled', async () => {
  let cancelled = false;
  const { request } = setup({}, { readTimeoutMs: 5 });
  const body = new ReadableStream({ start() {}, cancel() { cancelled = true; } });
  const result = await request('start', {}, { body, duplex: true });
  assert.equal(result.status, 408);
  assert.equal(cancelled, true);
});
