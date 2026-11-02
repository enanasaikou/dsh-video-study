import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildClient } from '../client/build.mjs';

const FLOW = 'a'.repeat(36);
const QR = 'https://passport.bilibili.com/offline-test?fixture=NOT-A-REAL-LOGIN';
const COOKIE = 'SESSDATA=PRIVATE-OFFLINE-COOKIE';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
class Clock {
  time = 1000000; next = 1; tasks = new Map();
  now = () => this.time;
  set = (fn, delay) => { const id = this.next++; this.tasks.set(id, { fn, delay, due: this.time + delay }); return id; };
  clear = id => this.tasks.delete(id);
  async advance(ms) {
    this.time += ms;
    for (const [id, task] of [...this.tasks]) if (task.due <= this.time) { this.tasks.delete(id); task.fn(); }
    await flush();
  }
}
async function moduleFixture({ fetch, React, clock } = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let registration;
  const required = [];
  const singleton = React || { createElement(type, props, ...children) { return { type, props, children }; } };
  const context = { window: { fetch: fetch || (async () => { throw new Error('NO NETWORK'); }),
    __ModuleLoader__: { load(value) { registration = value; } } }, URL, AbortController, TextEncoder,
    setTimeout: clock?.set || setTimeout, clearTimeout: clock?.clear || clearTimeout, Date };
  vm.runInNewContext(source, context, { timeout: 3000 });
  assert.equal(registration.id, 'dsh-video-study');
  const exports = registration.factory(name => { required.push(name); assert.equal(name, 'react'); return singleton; });
  return { exports, required, singleton, source };
}
async function controllerFixture(custom = {}) {
  const { exports } = await moduleFixture();
  const clock = new Clock(), calls = [];
  const account = { status: 'ok', source: 'anonymous', loginStatus: 'anonymous',
    credentialAvailable: false, storage: { encrypted: false, persistent: false }, lastCheckedAt: null, qr: null };
  const results = [...(custom.pollResults || ['waiting_confirm', 'success'])];
  const request = async (action, body, signal) => {
    calls.push({ action, body, signal });
    if (custom.request) return custom.request(action, body, signal, { account, clock });
    if (action === 'start') return { flowId: FLOW, qrUrl: QR, expiresAt: clock.time + 20000, status: 'waiting_scan' };
    if (action === 'poll') {
      const status = results.shift() || 'waiting_scan';
      return { ...account, status, flowId: FLOW, loginStatus: status === 'success' ? 'authenticated' : 'anonymous' };
    }
    if (action === 'import') return { ...account, source: 'managed', loginStatus: 'unverified' };
    if (action === 'cancel') return { ...account, status: 'cancelled' };
    return account;
  };
  const controller = exports._testing.createAuthController({ request, now: clock.now,
    setTimeout: clock.set, clearTimeout: clock.clear });
  return { controller, clock, calls, exports };
}

async function fetchControllerFixture(reply) {
  const clock = new Clock(), calls = [];
  const { exports } = await moduleFixture({ fetch: async (url, options) => {
    calls.push({ url, options }); return reply(url, options, clock);
  } });
  const controller = exports._testing.createAuthController({ request: exports._testing.requestAction,
    now: clock.now, setTimeout: clock.set, clearTimeout: clock.clear });
  return { controller, calls, clock, exports };
}

test('new account and legacy passport domains encode locally; other URL boundaries remain closed', async () => {
  const { exports } = await moduleFixture();
  for (const host of ['account.bilibili.com', 'passport.bilibili.com']) {
    assert.ok(exports._testing.qrGeometry(`https://${host}/offline-test?fixture=NOT-A-REAL-LOGIN`).path.length > 500);
    assert.ok(exports._testing.qrGeometry(`https://${host}:443/offline-test`).path.length > 500);
  }
  for (const url of [
    'http://account.bilibili.com/offline-test', 'https://account.bilibili.com:444/offline-test',
    'https://account.bilibili.com.evil.invalid/offline-test', 'https://sub.account.bilibili.com/offline-test',
    'https://passport.bilibili.com.evil.invalid/offline-test', 'https://user@account.bilibili.com/offline-test',
    'https://@account.bilibili.com/offline-test', 'https://account.bilibili.com/offline-test#fragment',
    'https://account.bilibili.com/offline-test#', 'https://account.bilibili.com/\noffline-test',
  ]) assert.throws(() => exports._testing.qrGeometry(url), error => error.code === 'unsupported_qr_url');
});

test('new official account URL starts the same bounded local QR flow', async () => {
  const { controller, clock } = await controllerFixture({ request: async (action, _body, _signal, { account, clock }) =>
    action === 'start' ? { flowId: FLOW, qrUrl: QR.replace('passport.', 'account.'), expiresAt: clock.time + 20000 } : account });
  await controller.start();
  assert.equal(controller.snapshot().phase, 'waiting_scan');
  assert.equal(controller.snapshot().qr.url.includes('account.bilibili.com'), true);
  controller.dispose(); await flush();
  assert.equal(clock.tasks.size, 0);
});

test('whitelisted server error codes produce fixed specific Chinese messages, not server text', async () => {
  const checks = { unsupported_proxy: '代理', unsupported_qr_url: '更新插件', network_error: '网络', timeout: '超时',
    platform_restricted: '风控', rate_limited: '频繁', storage_error: '存储失败', verification_failed: '核验失败',
    origin_rejected: '重新加载', invalid_cookie: 'Cookie格式', flow_not_found: '已失效' };
  for (const [code, expected] of Object.entries(checks)) {
    const { controller, calls, clock } = await fetchControllerFixture(async () => ({ status: 502, ok: false,
      async json() { return { status: 'error', code, message: `${COOKIE} ${QR} https://unsafe.invalid/?key=SECRET` }; } }));
    await controller.start();
    assert.equal(controller.snapshot().phase, 'error');
    assert.equal(controller.snapshot().error.includes(expected), true, code);
    const serialized = JSON.stringify(controller.snapshot());
    for (const secret of [COOKIE, QR, 'unsafe.invalid', 'SECRET']) assert.equal(serialized.includes(secret), false, code);
    await clock.advance(60000);
    assert.equal(calls.length, 1);
    controller.dispose();
  }
});

test('401/403 reload-page and 404 reload-backend hints work even with non-JSON host responses', async () => {
  for (const status of [401, 403, 404]) {
    let readBody = false;
    const { controller, calls } = await fetchControllerFixture(async () => ({ status, ok: false,
      async json() { readBody = true; throw new Error(COOKIE); } }));
    await controller.load();
    assert.equal(readBody, false);
    assert.equal(controller.snapshot().phase, 'error');
    assert.match(controller.snapshot().error, status === 404 ? /插件后端/ : /重新加载DSH页面/);
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(controller.snapshot()).includes(COOKIE), false);
    controller.dispose();
  }
});

test('every user action uses safe mapped failures while unknown or forged Error text stays generic', async () => {
  for (const action of ['load', 'start', 'cancel', 'check', 'logout', 'importFile']) {
    const { controller } = await fetchControllerFixture(async () => ({ status: 502, ok: false,
      async json() { return { status: 'error', code: 'storage_error', message: COOKIE }; } }));
    if (action === 'importFile') await controller.importFile({ size: 100, async text() { return COOKIE; } });
    else await controller[action]();
    assert.match(controller.snapshot().error, /存储失败/, action);
    assert.equal(JSON.stringify(controller.snapshot()).includes(COOKIE), false, action);
    controller.dispose();
  }
  const unknown = await fetchControllerFixture(async () => ({ status: 500, ok: false,
    async json() { return { status: 'error', code: 'UNTRUSTED-' + COOKIE, message: COOKIE }; } }));
  await unknown.controller.check();
  assert.equal(unknown.controller.snapshot().error, '登录检查未完成。');
  const forged = await controllerFixture({ request: async () => {
    const error = new Error(COOKIE); Object.defineProperty(error, 'code', { get() { throw new Error('do not inspect'); } });
    throw error;
  } });
  await forged.controller.start();
  assert.match(forged.controller.snapshot().error, /二维码生成未完成/);
  assert.equal(JSON.stringify(forged.controller.snapshot()).includes(COOKIE), false);
});

test('poll mapping is specific, terminal and does not automatically retry', async () => {
  const { controller, clock, calls } = await fetchControllerFixture(async (url, _options, clock) => {
    const action = url.split('/').at(-1);
    return { status: action === 'poll' ? 502 : 200, ok: action !== 'poll', async json() {
      if (action === 'start') return { flowId: FLOW, qrUrl: QR, expiresAt: clock.time + 20000 };
      if (action === 'poll') return { status: 'error', code: 'rate_limited', message: COOKIE };
      return { status: 'ok' };
    } };
  });
  await controller.start(); await clock.advance(2000);
  assert.equal(controller.snapshot().phase, 'error'); assert.equal(controller.snapshot().qr, null);
  assert.match(controller.snapshot().error, /频繁/);
  await clock.advance(10000);
  assert.equal(calls.filter(call => call.url.endsWith('/poll')).length, 1);
  assert.equal(JSON.stringify(controller.snapshot()).includes(COOKIE), false);
});

test('network failures and malformed JSON remain safe fixed diagnostics', async () => {
  const network = await fetchControllerFixture(async () => { throw new Error(COOKIE + QR); });
  await network.controller.start(); assert.match(network.controller.snapshot().error, /网络/);
  assert.equal(JSON.stringify(network.controller.snapshot()).includes(COOKIE), false);
  const malformed = await fetchControllerFixture(async () => ({ status: 502, ok: false,
    async json() { throw new Error(COOKIE); } }));
  await malformed.controller.check(); assert.match(malformed.controller.snapshot().error, /响应格式无效/);
  assert.equal(JSON.stringify(malformed.controller.snapshot()).includes(COOKIE), false);
});

test('start transport timeout exceeds backend 15s budget and reports a fixed timeout at 20s', async () => {
  let startSignal;
  const { controller, clock, calls } = await controllerFixture({ request: async (action, _body, signal, { account }) => {
    if (action !== 'start') return account;
    return new Promise((_resolve, reject) => { startSignal = signal;
      signal.addEventListener('abort', () => reject(new Error(COOKIE)), { once: true }); });
  } });
  const pending = controller.start(); await flush();
  await clock.advance(15000);
  assert.equal(startSignal.aborted, false); assert.equal(controller.snapshot().phase, 'starting');
  await clock.advance(4999); assert.equal(startSignal.aborted, false);
  await clock.advance(1); await pending;
  assert.equal(startSignal.aborted, true); assert.equal(controller.snapshot().phase, 'error');
  assert.match(controller.snapshot().error, /超时/);
  assert.equal(calls.filter(call => call.action === 'start').length, 1);
  assert.equal(JSON.stringify(controller.snapshot()).includes(COOKIE), false);
  assert.equal(clock.tasks.size, 0);
});

test('artifact is reproducible, includes pinned MIT encoder and loads only host React', async () => {
  const fixture = await moduleFixture();
  assert.equal(fixture.source, await buildClient({ write: false }));
  assert.match(fixture.source, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.match(fixture.source, /MIT License/);
  assert.deepEqual(fixture.required, ['react']);
  assert.equal(fixture.source.includes('import React'), false);
});

test('native ModuleLoader registers the actual settings.section slot, not a new page/window', async () => {
  const { exports } = await moduleFixture();
  let registered;
  const ctx = { slots: { inject(name, factory) { assert.equal(name, 'settings.section'); factory(); },
    register(options, component) { registered = { options, component }; } } };
  exports.apply(ctx);
  assert.equal(registered.options.name, 'settings.section');
  assert.equal(registered.options.id, 'video-study');
  assert.equal(registered.options.label, '视频学习');
  assert.equal(registered.options.order, 30);
  assert.equal(typeof registered.component, 'function');
  assert.equal(JSON.stringify(registered.options.inject()), '{}');
});

test('status initialization never starts QR or polls', async () => {
  const { controller, calls } = await controllerFixture();
  await controller.load();
  assert.deepEqual(calls.map(call => call.action), ['status']);
  assert.equal(controller.snapshot().phase, 'idle');
  controller.dispose(); await flush();
  assert.deepEqual(calls.map(call => call.action), ['status']);
});

test('local QR creates only SVG matrix geometry, never an external image/network URL', async () => {
  const { exports } = await moduleFixture();
  const geometry = exports._testing.qrGeometry(QR);
  assert.ok(geometry.size > 25);
  assert.ok(geometry.path.length > 500);
  assert.match(geometry.path, /^[M0-9 hvz-]+$/);
  assert.equal(geometry.path.includes('http'), false);
  assert.throws(() => exports._testing.qrGeometry('https://external-qr.invalid/?data=secret'));
});

test('polling waits at least two seconds and pending confirmation is not success', async () => {
  const { controller, clock, calls } = await controllerFixture();
  await controller.start();
  assert.equal(controller.snapshot().phase, 'waiting_scan');
  await clock.advance(1999);
  assert.equal(calls.filter(call => call.action === 'poll').length, 0);
  await clock.advance(1);
  assert.equal(controller.snapshot().phase, 'waiting_confirm');
  assert.equal(controller.snapshot().auth.loginStatus, 'anonymous');
  await clock.advance(2000);
  assert.equal(controller.snapshot().phase, 'success');
  assert.equal(controller.snapshot().auth.loginStatus, 'authenticated');
  assert.equal(controller.snapshot().qr, null);
  assert.equal(clock.tasks.size, 0);
});

test('local deadline expires QR and cancels without another upstream poll', async () => {
  const { controller, clock, calls } = await controllerFixture();
  await controller.start();
  await clock.advance(20001);
  assert.equal(controller.snapshot().phase, 'expired');
  assert.equal(controller.snapshot().qr, null);
  assert.equal(calls.filter(call => call.action === 'poll').length, 0);
  assert.equal(calls.some(call => call.action === 'cancel'), true);
});

test('absolute QR expiry aborts a still-pending poll without waiting for its network timeout', async () => {
  let pollSignal;
  const { controller, clock } = await controllerFixture({ request: async (action, _body, signal, { account, clock }) => {
    if (action === 'start') return { flowId: FLOW, qrUrl: QR, expiresAt: clock.time + 5000 };
    if (action === 'poll') return new Promise((_resolve, reject) => {
      pollSignal = signal; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return account;
  } });
  await controller.start(); await clock.advance(2000);
  assert.equal(pollSignal.aborted, false);
  await clock.advance(3000);
  assert.equal(pollSignal.aborted, true);
  assert.equal(controller.snapshot().phase, 'expired');
  assert.equal(controller.snapshot().qr, null);
  assert.equal(clock.tasks.size, 0);
});

test('cancel stops future polling and clears local QR', async () => {
  const { controller, clock, calls } = await controllerFixture();
  await controller.start(); await controller.cancel();
  await clock.advance(10000);
  assert.equal(controller.snapshot().qr, null);
  assert.equal(controller.snapshot().phase, 'cancelled');
  assert.equal(calls.filter(call => call.action === 'poll').length, 0);
  assert.deepEqual(calls.find(call => call.action === 'cancel').body.flowId, FLOW);
});

test('unmount/dispose stops polls and sends independent best-effort cancellation', async () => {
  const { controller, clock, calls } = await controllerFixture();
  await controller.start(); controller.dispose(); await flush();
  assert.equal(controller.snapshot().qr, null);
  const cancel = calls.find(call => call.action === 'cancel');
  assert.equal(cancel.body.flowId, FLOW);
  assert.equal(cancel.signal.aborted, false);
  await clock.advance(5000);
  assert.equal(calls.filter(call => call.action === 'poll').length, 0);
  assert.equal(clock.tasks.size, 0);
});

test('poll errors stop automatically and never display raw sensitive error text', async () => {
  const { controller, clock, calls } = await controllerFixture({ request: async (action, _body, _signal, { account, clock }) => {
    if (action === 'start') return { flowId: FLOW, qrUrl: QR, expiresAt: clock.time + 20000 };
    if (action === 'poll') throw new Error(COOKIE + ' https://bad.invalid/?token=SECRET');
    return account;
  } });
  await controller.start(); await clock.advance(2000); await clock.advance(10000);
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(calls.filter(call => call.action === 'poll').length, 1);
  assert.equal(JSON.stringify(controller.snapshot()).includes(COOKIE), false);
});

test('late start after cancellation cannot restore a QR or polling', async () => {
  let finishStart;
  const { controller, clock, calls } = await controllerFixture({ request: async (action, _body, _signal, { account }) => {
    if (action === 'start') return new Promise(resolve => { finishStart = resolve; });
    return account;
  } });
  const starting = controller.start(); await flush();
  await controller.cancel();
  finishStart({ flowId: FLOW, qrUrl: QR, expiresAt: clock.time + 10000 });
  await starting; await flush();
  assert.equal(controller.snapshot().qr, null);
  assert.equal(controller.snapshot().phase, 'cancelled');
  assert.equal(calls.filter(call => call.action === 'cancel').length, 2);
});

test('late poll success after cancel cannot claim authenticated state', async () => {
  let finishPoll;
  const { controller, clock } = await controllerFixture({ request: async (action, _body, _signal, { account, clock }) => {
    if (action === 'start') return { flowId: FLOW, qrUrl: QR, expiresAt: clock.time + 20000 };
    if (action === 'poll') return new Promise(resolve => { finishPoll = resolve; });
    return account;
  } });
  await controller.start(); await clock.advance(2000); await controller.cancel();
  finishPoll({ status: 'success', loginStatus: 'authenticated' }); await flush();
  assert.equal(controller.snapshot().phase, 'cancelled');
  assert.notEqual(controller.snapshot().auth.loginStatus, 'authenticated');
});

test('import reads only the chosen small file and never exposes content in state', async () => {
  const { controller, calls } = await controllerFixture();
  let reads = 0;
  await controller.importFile({ size: COOKIE.length, async text() { reads++; return COOKIE; } });
  assert.equal(reads, 1);
  assert.equal(calls.find(call => call.action === 'import').body.text, COOKIE);
  assert.equal(controller.snapshot().auth.loginStatus, 'unverified');
  assert.equal(JSON.stringify(controller.snapshot()).includes(COOKIE), false);
});

test('oversize or UTF-8-expanded files are refused without sending contents', async () => {
  const { controller, calls } = await controllerFixture();
  let reads = 0;
  await controller.importFile({ size: 65537, async text() { reads++; return COOKIE; } });
  assert.equal(reads, 0);
  await controller.importFile({ size: 100, async text() { return '中'.repeat(22000); } });
  assert.equal(calls.some(call => call.action === 'import'), false);
});

test('closing while a selected file is being read prevents later import', async () => {
  let finishRead;
  const { controller, calls } = await controllerFixture();
  const importing = controller.importFile({ size: 100, text() { return new Promise(resolve => { finishRead = resolve; }); } });
  controller.dispose(); finishRead(COOKIE); await importing;
  assert.equal(calls.some(call => call.action === 'import'), false);
});

test('fetch uses mount-relative same-origin routes with JSON and no redirects/cache', async () => {
  const captured = [];
  const { exports } = await moduleFixture({ fetch: async (url, options) => {
    captured.push({ url, options }); return { ok: true, async json() { return { status: 'ok' }; } };
  } });
  await exports._testing.requestAction('status'); await exports._testing.requestAction('cancel', { flowId: FLOW });
  assert.equal(captured[0].url, 'api/video-study/auth/status');
  assert.equal(captured[0].options.method, 'GET');
  assert.equal(captured[0].options.body, undefined);
  assert.equal(captured[1].options.headers['Content-Type'], 'application/json');
  for (const { options } of captured) {
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.mode, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  }
});

test('login view is concise, retains confirmation/memory-only warning, and never shows QR URL or flow text', async () => {
  const view = { phase: 'waiting_confirm', auth: { loginStatus: 'anonymous', source: 'managed', credentialAvailable: true,
    storage: { encrypted: false, persistent: false } }, qr: { url: QR }, busy: false, error: '' };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return { current: null }; }, useState() { return [view, () => {}]; }, useEffect() {} };
  const { exports } = await moduleFixture({ React });
  const rendered = JSON.stringify(exports._testing.LoginSettings());
  assert.equal(rendered.includes('App 确认'), true);
  assert.equal(rendered.includes('当前会话仅保存在内存中'), true);
  assert.equal(rendered.includes('哔哩哔哩下载字幕需要登录，Cookie仅供B站请求使用。'), true);
  for (const removed of ['YouTube', '来源：', '最近检查', '尚未检查', '持久化', '平台登录'])
    assert.equal(rendered.includes(removed), false);
  assert.equal(rendered.includes(QR), false);
  assert.equal(rendered.includes(FLOW), false);
  assert.equal(rendered.includes('iframe'), false);
});

test('same video-study tab contains concise login and ASR sections with one title', async () => {
  const { exports } = await moduleFixture();
  const tree = exports._testing.VideoSettings();
  assert.equal(tree.children[0].type, 'h2');
  assert.equal(tree.children[0].children[0], '视频学习');
  assert.equal(tree.children[1].type, exports._testing.LoginSettings);
  assert.equal(tree.children[2].type, exports._testing.asr.Component);
});

test('idle login exposes only short buttons and hides cancel until active', async () => {
  const view = { phase: 'idle', auth: { source: 'anonymous', loginStatus: 'anonymous' }, qr: null, busy: false, error: '' };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return { current: null }; }, useState() { return [view, () => {}]; }, useEffect() {} };
  const { exports } = await moduleFixture({ React });
  const rendered = JSON.stringify(exports._testing.LoginSettings());
  for (const label of ['扫码登录', '检查', '退出', '导入 Cookie', '未登录']) assert.equal(rendered.includes(label), true);
  for (const label of ['取消', '检查登录', '退出并清除', '来源：', 'YouTube', '内存中']) assert.equal(rendered.includes(label), false);
});

test('short login status distinguishes unchecked persisted sessions from logged-out state', async () => {
  for (const [auth, phase, expected] of [
    [{ source: 'managed', loginStatus: 'unverified' }, 'idle', '待检查'],
    [{ source: 'managed', loginStatus: 'expired' }, 'idle', '登录已过期'],
    [null, 'error', '未读取'],
  ]) {
    const view = { auth, phase, qr: null, busy: false, error: '' };
    const React = { createElement(type, props, ...children) { return { type, props, children }; },
      useRef() { return { current: null }; }, useState() { return [view, () => {}]; }, useEffect() {} };
    const { exports } = await moduleFixture({ React });
    assert.ok(JSON.stringify(exports._testing.LoginSettings()).includes(expected));
  }
});

test('React effect cleanup cancels a QR and StrictMode remount uses a new live controller', async () => {
  const clock = new Clock();
  const effects = [], calls = [];
  const ref = { current: null };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return ref; }, useState(value) { return [value, () => {}]; }, useEffect(effect) { effects.push(effect); } };
  const { exports } = await moduleFixture({ React, clock, fetch: async (url, options) => {
    const action = url.split('/').at(-1); calls.push(action);
    return { ok: true, async json() { return action === 'start'
      ? { flowId: FLOW, qrUrl: QR, expiresAt: Date.now() + 20000 } : { status: 'ok' }; } };
  } });
  exports._testing.LoginSettings();
  let cleanup = effects[0](); await flush();
  const first = ref.current; await first.start(); cleanup(); await flush();
  assert.equal(calls.includes('cancel'), true);
  cleanup = effects[0](); await flush();
  assert.notEqual(ref.current, first);
  assert.equal(calls.filter(action => action === 'status').length, 2);
  cleanup(); await flush();
});
