import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsrSettingsRepository, registerAsrSettings, AsrSettingsError } from '../lib/asr-settings.mjs';

const ORIGIN = 'http://127.0.0.1:1180';
const SECRET = 'FAKE_OLD_KEY_NEVER_REAL';
const NEW_KEY = 'FAKE_NEW_KEY_NEVER_REAL';
class SettingsConflictError extends Error {}
const noSecrets = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SECRET, NEW_KEY, 'OTHER_PLUGIN_SECRET']) assert.equal(text.includes(secret), false);
};
async function code(promise, expected) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AsrSettingsError);
    assert.equal(error.code, expected);
    noSecrets(error.message);
    return true;
  });
}
function fixture({ secret = SECRET, directEntry = true } = {}) {
  let currentRevision = 4;
  const own = { mode: 'captions', defaultLanguage: 'auto', localModel: 'small', cloudApiKey: secret,
    cloudEndpoint: '', cloudModel: '', cloudUploadConsent: false };
  const persisted = { ...own, registerSkill: true, biliCookieFile: 'NEVER_READ' };
  const refs = Object.fromEntries(['mode', 'defaultLanguage', 'cloudApiKey', 'cloudUploadConsent'].map(key => [key, { get: () => own[key] }]));
  const ownerFiber = directEntry ? { entry: { options: { id: 'our-instance' } } } : {};
  const otherFiber = { entry: { options: { id: 'other-instance' } } };
  const calls = { describe: [], mutate: [], entries: 0, status: [], setup: [] };
  const ownerContext = { fiber: ownerFiber };
  const ctx = {
    fiber: otherFiber, // injected context is deliberately NOT the plugin owner
    configEditor: { entries() { calls.entries++; return [
      { fiber: otherFiber, options: { id: 'other-instance' } }, { fiber: ownerFiber, options: { id: 'our-instance' } }]; } },
    settings: {
      describe(options) {
        calls.describe.push(options);
        return [{ ns: 'other-instance', revision: 99, applies: 'live', value: { cloudApiKey: 'OTHER_PLUGIN_SECRET', mode: 'cloud' }, schema: { private: 'OTHER_PLUGIN_SECRET' } },
          { ns: 'our-instance', revision: currentRevision, applies: 'live', value: { ...own, ns: 'MUST_NOT_RETURN', prototype: 'MUST_NOT_RETURN' },
            base: { cloudApiKey: SECRET }, user: { cloudApiKey: SECRET }, schema: { cloudApiKey: SECRET }, secrets: [{ path: ['cloudApiKey'], set: true, value: SECRET }] }];
      },
      async mutate(ns, ops, expectedRevision) {
        calls.mutate.push({ ns, ops, expectedRevision });
        assert.equal(ns, 'our-instance');
        if (expectedRevision !== currentRevision) throw new SettingsConflictError(SECRET);
        for (const op of ops) {
          assert.equal(op.op, 'set'); assert.equal(op.path.length, 1);
          own[op.path[0]] = op.value; persisted[op.path[0]] = op.value;
        }
        currentRevision++;
      },
    },
  };
  const runtime = {
    async status(args, execution) { calls.status.push({ args, execution }); return { status: 'ok', backend: { ready: false }, cloudApiKey: SECRET }; },
    async setup(args, execution) { calls.setup.push({ args, execution }); return { status: 'setup_command_prepared', executed: false, command: "'python' '-B' 'setup_environment.py' '--allow-downloads'", warnings: ['仅生成命令，不执行安装。'] }; },
    extract() { throw new Error('MUST NEVER EXTRACT'); },
  };
  const options = { ownerContext, hasSecret: () => !!own.cloudApiKey };
  const repository = createAsrSettingsRepository(ctx, options);
  return { ctx, ownerContext, ownerFiber, own, persisted, refs, calls, options, repository, runtime,
    setRevision(value) { currentRevision = value; } };
}
function routes(f = fixture(), { readTimeoutMs = 5000, ...changes } = {}) {
  const handlers = new Map();
  f.ctx.connection = { fetch: { register(route) { assert.equal(handlers.has(route.path), false); handlers.set(route.path, route); return route; } } };
  const registrations = registerAsrSettings(f.ctx, { runtime: f.runtime, ...f.options, readTimeoutMs, ...changes });
  async function request(action = 'config', body, custom = {}) {
    const method = custom.method ?? (body === undefined && action === 'config' ? 'GET' : 'POST');
    const headers = { Origin: ORIGIN, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...custom.headers };
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') init.body = custom.body ?? JSON.stringify(body ?? {});
    if (custom.duplex) init.duplex = 'half';
    const req = new Request(custom.url ?? ORIGIN + '/api/video-study/asr/' + action, init);
    const response = await handlers.get('/api/video-study/asr/' + action).fetch(req);
    const text = await response.text(); noSecrets(text);
    return { response, text, data: JSON.parse(text), request: req };
  }
  return { ...f, handlers, registrations, request };
}

test('document defaults and partial saves preserve cloud key, authorization and unrelated settings', async () => {
  const f = fixture();
  f.own.cloudUploadConsent = true;
  const initial = await f.repository.read();
  assert.equal(initial.values.documentFormat, 'docx');
  assert.equal(initial.values.documentOutputDir, '');
  await f.repository.save({ revision: 4, patch: { documentFormat: 'md', documentOutputDir: 'D:\\课程文档' } });
  assert.equal(f.own.cloudApiKey, SECRET); assert.equal(f.own.cloudUploadConsent, true);
  assert.equal(f.own.documentFormat, 'md');
  assert.deepEqual(f.calls.mutate[0].ops.map(op => op.path[0]), ['documentFormat', 'documentOutputDir']);
});

test('document settings reject unsupported formats and nonlocal/relative/traversing paths', async () => {
  for (const patch of [{ documentFormat: 'pdf' }, { documentOutputDir: 'relative' },
    { documentOutputDir: '\\\\server\\share' }, { documentOutputDir: 'D:/safe/../other' }, { documentOutputDir: 'D:\\x\n' }]) {
    const f = fixture(); await code(f.repository.save({ revision: 4, patch }), 'invalid_input');
    assert.equal(f.calls.mutate.length, 0);
  }
});

test('own fiber namespace is located without exposing any other descriptor or secrets', async () => {
  const f = fixture(), result = await f.repository.read();
  assert.equal(result.status, 'ok'); assert.equal(result.revision, 4);
  assert.equal(result.values.mode, 'captions'); assert.equal(result.secretConfigured, true);
  for (const key of ['ns', 'schema', 'base', 'user', 'secrets', 'cloudApiKey']) assert.equal(key in result, false);
  assert.equal('cloudApiKey' in result.values, false); noSecrets(result);
  assert.deepEqual(f.calls.describe, [{ redactSecrets: true }]);
  assert.equal(f.calls.entries, 0);
});

test('fiber-identity fallback locates exact instance instead of first/same-plugin entry', async () => {
  const f = fixture({ directEntry: false });
  await f.repository.save({ revision: 4, patch: { mode: 'local' } });
  assert.equal(f.calls.mutate[0].ns, 'our-instance');
  assert.ok(f.calls.entries >= 1);
  assert.equal(f.persisted.mode, 'local');
});

test('native mutate CAS persists the exact patch and updates existing live references', async () => {
  const f = fixture();
  const result = await f.repository.save({ revision: 4, patch: { mode: 'cloud', defaultLanguage: 'zh', cloudUploadConsent: true } });
  assert.equal(result.revision, 5); assert.equal(result.values.mode, 'cloud');
  assert.equal(f.refs.mode.get(), 'cloud'); assert.equal(f.refs.defaultLanguage.get(), 'zh');
  assert.equal(f.persisted.cloudUploadConsent, true); assert.equal(f.persisted.registerSkill, true);
  assert.deepEqual(f.calls.mutate[0], { ns: 'our-instance', expectedRevision: 4, ops: [
    { op: 'set', path: ['mode'], value: 'cloud' }, { op: 'set', path: ['defaultLanguage'], value: 'zh' },
    { op: 'set', path: ['cloudUploadConsent'], value: true }] });
  noSecrets(result);
});

test('secret keep emits no secret operation and does not overwrite an inherited key', async () => {
  const f = fixture();
  const result = await f.repository.save({ revision: 4, patch: { mode: 'local' }, secret: { action: 'keep' } });
  assert.equal(f.calls.mutate[0].ops.some(op => op.path[0] === 'cloudApiKey'), false);
  assert.equal(f.refs.cloudApiKey.get(), SECRET); assert.equal(result.secretConfigured, true); noSecrets(result);
});

test('secret set is write-only and latest GET reflects only configured boolean', async () => {
  const f = fixture({ secret: '' });
  const result = await f.repository.save({ revision: 4, patch: {}, secret: { action: 'set', value: NEW_KEY } });
  assert.equal(f.persisted.cloudApiKey, NEW_KEY); assert.equal(f.refs.cloudApiKey.get(), NEW_KEY);
  assert.deepEqual(f.calls.mutate[0].ops, [{ op: 'set', path: ['cloudApiKey'], value: NEW_KEY }]);
  assert.equal(result.secretConfigured, true); noSecrets(result); noSecrets(await f.repository.read());
});

test('clear uses set empty string, not unset, blocking inherited secret recovery', async () => {
  const f = fixture();
  const result = await f.repository.save({ revision: 4, patch: {}, secret: { action: 'clear' } });
  assert.deepEqual(f.calls.mutate[0].ops, [{ op: 'set', path: ['cloudApiKey'], value: '' }]);
  assert.equal(f.persisted.cloudApiKey, ''); assert.equal(result.secretConfigured, false);
});

test('production hasSecret overrides SDK default-empty sidecar misclassification', async () => {
  const f = fixture({ secret: '' });
  assert.equal((await f.repository.read()).secretConfigured, false);
  const sidecarFixture = createAsrSettingsRepository(f.ctx, { ownerContext: f.ownerContext });
  assert.equal((await sidecarFixture.read()).secretConfigured, true);
  const strictCallback = createAsrSettingsRepository(f.ctx, { ownerContext: f.ownerContext, hasSecret: async () => 'not-a-boolean' });
  assert.equal((await strictCallback.read()).secretConfigured, false);
});

test('malformed descriptor secret getter is never read, only allowed nonsecret values copied', async () => {
  const f = fixture(); const describe = f.ctx.settings.describe;
  f.ctx.settings.describe = options => {
    const rows = describe(options);
    Object.defineProperty(rows[1].value, 'cloudApiKey', { enumerable: true, get() { throw new Error(SECRET); } });
    rows[1].value.localModel = { cloudApiKey: SECRET };
    return rows;
  };
  const result = await f.repository.read();
  assert.equal(result.values.localModel, 'small'); noSecrets(result);
});

test('empty patch and keep are read-only but still check expected revision', async () => {
  const f = fixture();
  assert.equal((await f.repository.save({ revision: 4, patch: {}, secret: { action: 'keep' } })).revision, 4);
  assert.equal(f.calls.mutate.length, 0);
  await code(f.repository.save({ revision: 0, patch: {} }), 'settings_conflict');
});

test('preflight CAS conflict does not call mutate and native SettingsConflictError is mapped', async () => {
  const f = fixture();
  await code(f.repository.save({ revision: 3, patch: { mode: 'local' } }), 'settings_conflict');
  assert.equal(f.calls.mutate.length, 0);
  f.ctx.settings.mutate = async () => { throw new SettingsConflictError(SECRET + NEW_KEY); };
  await code(f.repository.save({ revision: 4, patch: { mode: 'local' } }), 'settings_conflict');
});

test('client cannot select a namespace or patch direct secret/prototype/private fields', async () => {
  const f = fixture();
  const inputs = [
    { revision: 4, ns: 'other-instance', patch: { mode: 'local' } },
    { revision: 4, patch: { ns: 'other-instance' } },
    { revision: 4, patch: { cloudApiKey: NEW_KEY } },
    { revision: 4, patch: { registerSkill: false } },
    { revision: 4, patch: { biliCookieFile: '/private/cookie' } },
    { revision: 4, patch: { lang: 'zh' } },
    JSON.parse('{"revision":4,"patch":{"__proto__":{"mode":"cloud"}}}'),
    JSON.parse('{"revision":4,"patch":{"constructor":"cloud"}}'),
    JSON.parse('{"revision":4,"__proto__":{"ns":"other-instance"},"patch":{}}'),
  ];
  for (const input of inputs) await code(f.repository.save(input), 'invalid_input');
  assert.equal(f.calls.describe.length, 0); assert.equal(f.calls.mutate.length, 0);
});

test('revision requires a nonnegative safe integer, not coercible strings/booleans', async () => {
  const f = fixture();
  for (const value of [-1, 1.2, '4', true, null, undefined, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await code(f.repository.save({ revision: value, patch: {} }), 'invalid_input');
});

test('secret action format and allowed ASCII bounds are strict', async () => {
  const f = fixture();
  for (const secret of [{ action: 'set', value: '' }, { action: 'set', value: 'x'.repeat(8193) },
    { action: 'set', value: 'key\r\nsecret' }, { action: 'set', value: '中文密钥不可直接传输' },
    { action: 'clear', value: SECRET }, { action: 'keep', value: SECRET }, { action: 'unset' },
    { action: 'set', value: NEW_KEY, ns: 'other-instance' }, null, []])
    await code(f.repository.save({ revision: 4, patch: {}, secret }), 'invalid_input');
  assert.equal(f.calls.mutate.length, 0);
});

test('format/range validation is local and never requires model/provider readiness', async () => {
  const f = fixture();
  const result = await f.repository.save({ revision: 4, patch: { mode: 'captions', pythonPath: '/does-not-exist/python',
    localModelDir: '/does-not-exist/model', stateDir: 'C:\\not-installed', outputDir: '/nonexistent/output',
    cloudEndpoint: '', cloudModel: '', cloudApiKeyFile: '', localDevice: 'cuda', localComputeType: 'float16' } });
  assert.equal(result.values.mode, 'captions'); assert.equal(result.values.localDevice, 'cuda');
  assert.equal(f.calls.status.length, 0); assert.equal(f.calls.setup.length, 0);
});

test('invalid finite ranges, enum, paths and unsafe endpoints/proxies are rejected before mutate', async () => {
  const f = fixture();
  const patches = [{ mode: 'unknown' }, { defaultLanguage: 'fr' }, { localModel: 'custom' }, { localDevice: 'gpu' },
    { localComputeType: 'shell command' }, { stateDir: 'relative/path' }, { outputDir: '../output' }, { pythonPath: 'python\nanything' },
    { cloudApiKeyFile: 'relative.key' }, { cloudModel: 'bad\nmodel' }, { cloudModel: '\ud800' }, { downloadTimeout: 0 }, { downloadTimeout: 3601 },
    { asrTimeout: Infinity }, { maxDuration: -1 }, { maxDuration: 86401 }, { cloudMaxAudioMiB: 0 }, { cloudMaxAudioMiB: 513 },
    { cloudUploadConsent: 'true' }, { allowInsecureLoopback: 1 }, { proxy: 'http://user:pass@proxy.invalid:80' },
    { proxy: 'http://proxy.invalid:0' }, { proxy: 'socks5://localhost:7897' }, { proxy: 'http://proxy.invalid/?token=secret' },
    { cloudEndpoint: 'http://public.invalid/v1/audio/transcriptions' }, { cloudEndpoint: 'https://api.invalid/v1/chat/completions?key=NO' },
    { cloudEndpoint: 'https://api.invalid/v1/../audio/transcriptions' }, { cloudEndpoint: 'https://api.invalid/%76%31/audio/transcriptions' },
    { cloudEndpoint: 'https://user:pass@api.invalid/v1/audio/transcriptions' }, { cloudEndpoint: 'https://api.invalid:0/v1/audio/transcriptions' }];
  for (const patch of patches) await code(f.repository.save({ revision: 4, patch }), 'invalid_input');
  assert.equal(f.calls.mutate.length, 0);
});

test('explicit compatible endpoints, loopback and safe proxy formats can be saved without contacting them', async () => {
  const f = fixture();
  await f.repository.save({ revision: 4, patch: { cloudEndpoint: 'https://api.invalid/openai/v1/audio/transcriptions', proxy: 'http://127.0.0.1:7897' } });
  await f.repository.save({ revision: 5, patch: { cloudEndpoint: 'http://[::1]:9000/v1/audio/transcriptions', allowInsecureLoopback: true } });
  assert.equal(f.calls.mutate.length, 2); assert.equal(f.calls.status.length, 0);
});

test('custom HTTPS domains and paths save offline, keep the stored key, and revoke upload consent', async () => {
  const f = fixture(); let revision = 4;
  for (const cloudEndpoint of ['https://gateway.example.test/custom/asr', 'https://api.example.test:9443/chat/completions',
    'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', 'https://asr.tencentcloudapi.com/']) {
    const result = await f.repository.save({ revision: revision++, patch: { cloudEndpoint, cloudProtocol: 'openai', cloudModel: '自定义 model' } });
    assert.equal(result.values.cloudEndpoint, cloudEndpoint); assert.equal(result.values.cloudModel, '自定义 model');
    assert.equal(result.values.cloudUploadConsent, false);
    // The key must survive a destination change: providers rarely show it again.
    assert.equal(f.own.cloudApiKey, SECRET); assert.equal(result.secretConfigured, true); noSecrets(result);
  }
  assert.equal(f.calls.status.length, 0); assert.equal(f.calls.mutate.length, 4);
});

test('destination change keeps credentials and only an explicit consent re-authorizes the same key', async () => {
  const f = fixture();
  const patch = { cloudEndpoint: 'https://gateway.example.test/asr', cloudProtocol: 'dashscope_qwen',
    cloudProviderName: '任意厂商' };
  let result = await f.repository.save({ revision: 4, patch });
  assert.equal(result.values.cloudUploadConsent, false); assert.equal(result.secretConfigured, true);
  assert.equal(f.own.cloudApiKey, SECRET);
  // Re-saving the same destination without an explicit checkbox keeps it revoked.
  result = await f.repository.save({ revision: 5, patch: { cloudEndpoint: 'https://other.example.test/asr' } });
  assert.equal(result.values.cloudUploadConsent, false); assert.equal(result.secretConfigured, true);
  // Explicit consent plus the retained key is a deliberate re-authorization.
  result = await f.repository.save({ revision: 6, patch: { cloudEndpoint: 'https://third.example.test/asr', cloudUploadConsent: true } });
  assert.equal(result.values.cloudUploadConsent, true); assert.equal(result.secretConfigured, true); noSecrets(result);
  result = await f.repository.save({ revision: 7, patch: { cloudProviderName: '只改显示名称', cloudModel: '新模型' } });
  assert.equal(result.secretConfigured, true); assert.equal(result.values.cloudUploadConsent, true);
  result = await f.repository.save({ revision: 8, patch: { cloudProtocol: 'auto' } });
  assert.equal(result.values.cloudUploadConsent, false); assert.equal(result.secretConfigured, true);
  assert.equal(f.own.cloudApiKey, SECRET);
});

test('model naming, punctuation and short key are not invented provider restrictions or truncated', async () => {
  const f = fixture();
  const model = '供应商 model [v2] ' + 'x'.repeat(6000);
  const result = await f.repository.save({ revision: 4, patch: { cloudModel: model }, secret: { action: 'set', value: 'a' } });
  assert.equal(result.values.cloudModel, model); assert.equal(f.persisted.cloudModel, model);
  assert.equal(f.own.cloudApiKey, 'a'); assert.equal('cloudApiKey' in result.values, false);
  assert.equal(f.calls.mutate[0].ops[1].value, 'a');
});

test('HTTP field errors identify only allowlisted field names, never rejected values or extra keys', async () => {
  const f = routes();
  for (const [key, value] of [['cloudEndpoint', 'https://api.invalid/chat/completions?token=BAD'], ['cloudModel', 'BAD\nMODEL'], ['asrTimeout', -1]]) {
    const result = await f.request('save', { revision: 4, patch: { [key]: value } });
    assert.equal(result.response.status, 400); assert.equal(result.data.code, 'invalid_input'); assert.equal(result.data.field, key);
    assert.equal(result.text.includes(String(value)), false);
    assert.deepEqual(Object.keys(result.data).sort(), ['code', 'field', 'message', 'status']);
  }
  const secret = await f.request('save', { revision: 4, patch: {}, secret: { action: 'set', value: 'FAKE INVALID KEY' } });
  assert.equal(secret.data.field, 'cloudApiKey'); assert.equal(secret.text.includes('FAKE INVALID KEY'), false);
  const unknown = await f.request('save', { revision: 4, patch: { untrusted_field: 'NEVER_ECHO' } });
  assert.equal('field' in unknown.data, false); assert.equal(unknown.text.includes('untrusted_field'), false);
  assert.equal(f.calls.mutate.length, 0);
});

test('missing host services or ambiguous/current-fiber mismatch fail closed', async () => {
  for (const configure of [f => { delete f.ctx.settings; }, f => { delete f.ownerContext.fiber; },
    f => { f.ownerFiber.entry.options.id = 'not-present'; },
    f => { f.ctx.settings.describe = () => []; },
    f => { const original = f.ctx.settings.describe; f.ctx.settings.describe = o => { const all = original(o); all.push(all[1]); return all; }; },
    f => { const original = f.ctx.settings.describe; f.ctx.settings.describe = o => { const all = original(o); all[1].applies = 'reload'; return all; }; }]) {
    const f = fixture(); configure(f);
    await code(f.repository.read(), 'settings_unavailable');
    await code(f.repository.save({ revision: 4, patch: { mode: 'cloud' } }), 'settings_unavailable');
    assert.equal(f.calls.mutate.length, 0);
  }
});

test('describe/mutate/get-secret failures never echo raw host values or namespace', async () => {
  const f = fixture();
  f.ctx.settings.mutate = async () => { throw new Error('other-instance ' + SECRET); };
  await code(f.repository.save({ revision: 4, patch: { mode: 'local' } }), 'settings_save_failed');
  f.ctx.settings.describe = () => { throw new Error(SECRET); };
  await code(f.repository.read(), 'settings_unavailable');
  const g = fixture();
  const repository = createAsrSettingsRepository(g.ctx, { ownerContext: g.ownerContext, hasSecret: () => { throw new Error(SECRET); } });
  await code(repository.read(), 'settings_unavailable');
});

test('four unique routes keep GET config buffered and all mutations separately streaming', () => {
  const f = routes();
  assert.deepEqual([...f.handlers.keys()], ['/api/video-study/asr/config', '/api/video-study/asr/save',
    '/api/video-study/asr/status', '/api/video-study/asr/setup']);
  for (const [path, route] of f.handlers) {
    const read = path.endsWith('/config');
    assert.deepEqual(route.methods, read ? ['GET'] : ['POST']);
    assert.equal(route.requestBody, read ? 'buffered' : 'streaming');
  }
});

test('GET config is whitelisted/nonsecret and POST save persists only explicit patch with no-store', async () => {
  const f = routes(); const get = await f.request();
  assert.equal(get.response.status, 200); assert.equal(get.data.secretConfigured, true);
  assert.equal(get.response.headers.get('cache-control'), 'no-store');
  assert.equal(get.response.headers.get('access-control-allow-origin'), null);
  assert.equal(get.response.headers.get('x-content-type-options'), 'nosniff');
  const post = await f.request('save', { revision: 4, patch: { mode: 'local' }, secret: { action: 'keep' } });
  assert.equal(post.data.values.mode, 'local'); assert.equal(post.data.revision, 5);
  assert.equal(f.calls.setup.length, 0); assert.equal(f.calls.status.length, 0);
});

test('HTTP CAS conflicts return 409 and fixed code without echoing exceptions', async () => {
  const f = routes();
  const result = await f.request('save', { revision: 1, patch: { mode: 'local' } });
  assert.equal(result.response.status, 409); assert.equal(result.data.code, 'settings_conflict');
  assert.equal(f.calls.mutate.length, 0);
});

test('owner routes reject foreign/null/path origins, wrong methods and query input before services', async () => {
  for (const custom of [{ headers: { Origin: 'https://evil.invalid' } }, { headers: { Origin: 'null' } },
    { headers: { Origin: ORIGIN + '/wrong' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { method: 'DELETE' }, { url: ORIGIN + '/api/video-study/asr/config?ns=other-instance' }]) {
    const f = routes(); const result = await f.request('save', { revision: 4, patch: {} }, custom);
    assert.equal(result.data.code, 'invalid_input'); assert.ok([400,403,405].includes(result.response.status));
    assert.equal(f.calls.describe.length, 0); assert.equal(f.calls.mutate.length, 0);
  }
});

test('missing Origin stays behind existing owner gate and mounted same-origin path works', async () => {
  const f = routes();
  const route = f.handlers.get('/api/video-study/asr/config');
  const result = await route.fetch(new Request(ORIGIN + '/mounted/api/video-study/asr/config'));
  assert.equal(result.status, 200); noSecrets(await result.text());
});

test('GET config cannot accept legacy POST saves and streaming save cannot be read by GET', async () => {
  const f = routes();
  const old = await f.request('config', { revision: 4, patch: { mode: 'cloud' }, secret: { action: 'set', value: NEW_KEY } });
  assert.equal(old.response.status, 405); assert.equal(old.data.code, 'invalid_input');
  const readSave = await f.request('save', undefined, { method: 'GET' });
  assert.equal(readSave.response.status, 405); assert.equal(readSave.data.code, 'invalid_input');
  assert.equal(f.calls.describe.length, 0); assert.equal(f.calls.mutate.length, 0);
});

test('synthetic SDK URL with original Host and browser Origin loads, saves and checks safely', async () => {
  const f = routes();
  const custom = action => ({ url: 'http://dsh.internal/api/video-study/asr/' + action,
    headers: { Host: '127.0.0.1:1180', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' } });
  const get = await f.request('config', undefined, custom('config'));
  assert.equal(get.response.status, 200); assert.equal(get.data.revision, 4);
  const saved = await f.request('save', { revision: 4, patch: { mode: 'local', defaultLanguage: 'zh' },
    secret: { action: 'keep' } }, custom('save'));
  assert.equal(saved.response.status, 200); assert.equal(saved.data.revision, 5);
  assert.equal(saved.data.values.mode, 'local'); assert.equal(f.refs.mode.get(), 'local');
  const state = await f.request('status', {}, custom('status'));
  const commands = await f.request('setup', {}, custom('setup'));
  assert.equal(state.response.status, 200); assert.equal(commands.data.result.executed, false);
  assert.equal(f.calls.status.length, 1); assert.equal(f.calls.setup.length, 1);
  assert.equal(f.calls.mutate.length, 1);
});

test('synthetic URL permits normalized HTTPS default port against original fenced Host', async () => {
  const f = routes();
  const result = await f.request('config', undefined, { url: 'http://dsh.internal/api/video-study/asr/config',
    headers: { Host: 'localhost:443', Origin: 'https://localhost' } });
  assert.equal(result.response.status, 200); assert.equal(result.data.status, 'ok');
});

test('synthetic URL rejects external/opaque/path Origin, missing or malformed Host and Forwarded spoofing', async () => {
  const cases = [{ Host: '127.0.0.1:1180', Origin: 'https://evil.invalid' },
    { Host: 'evil.invalid', Origin: ORIGIN }, { Origin: ORIGIN },
    { Host: '127.0.0.1:1180', Origin: 'null' }, { Host: '127.0.0.1:1180', Origin: ORIGIN + '/path' },
    { Host: '127.0.0.1:1180', Origin: 'http://user:pass@127.0.0.1:1180' },
    { Host: 'user@127.0.0.1:1180', Origin: ORIGIN }, { Host: '127.0.0.1:1180/path', Origin: ORIGIN },
    { Host: '127.0.0.1:1180,evil.invalid', Origin: ORIGIN },
    { Host: '127.0.0.1:1180', Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
    { Origin: ORIGIN, Forwarded: 'host=127.0.0.1:1180', 'X-Forwarded-Host': '127.0.0.1:1180' },
    { Host: 'evil.invalid', Origin: ORIGIN, Forwarded: 'host=127.0.0.1:1180', 'X-Forwarded-Host': '127.0.0.1:1180' }];
  for (const headers of cases) {
    const f = routes();
    const result = await f.request('save', { revision: 4, patch: { mode: 'local' } },
      { url: 'http://dsh.internal/api/video-study/asr/save', headers });
    assert.equal(result.response.status, 403); assert.equal(result.data.code, 'invalid_input');
    assert.equal(f.calls.describe.length, 0); assert.equal(f.calls.mutate.length, 0);
  }
});

test('POST requires bounded JSON object and field allowlist before any host mutation', async () => {
  const cases = [
    { headers: { 'Content-Type': 'text/plain' }, body: '{}' }, { body: '[]' }, { body: 'null' }, { body: '{invalid' },
    { headers: { 'Content-Length': '65537' }, body: '{}' }, { body: JSON.stringify({ revision: 4, patch: {}, junk: 'x'.repeat(65537) }) },
    { body: JSON.stringify({ revision: 4, patch: {}, ns: 'other-instance' }) },
  ];
  for (const custom of cases) {
    const f = routes(); const result = await f.request('save', {}, custom);
    assert.equal(result.data.code, 'invalid_input'); assert.equal(f.calls.mutate.length, 0);
  }
});

test('slow body deadline cancels the stream without reading/writing native settings', async () => {
  const f = routes(fixture(), { readTimeoutMs: 5 }); let cancelled = false;
  const body = new ReadableStream({ start() {}, cancel() { cancelled = true; } });
  const result = await f.request('save', {}, { body, duplex: true });
  assert.equal(result.response.status, 408); assert.equal(result.data.code, 'invalid_input');
  assert.equal(cancelled, true); assert.equal(f.calls.mutate.length, 0);
});

test('status/setup accept only empty objects and call fixed safe runtime methods with abort signal', async () => {
  const f = routes(); const state = await f.request('status', {});
  assert.equal(state.data.status, 'ok'); assert.equal(state.data.result.backend.ready, false);
  assert.equal('cloudApiKey' in state.data.result, false);
  assert.deepEqual(f.calls.status[0].args, {}); assert.equal(f.calls.status[0].execution.signal, state.request.signal);
  const setup = await f.request('setup', {});
  assert.equal(setup.data.result.executed, false); assert.ok(setup.data.result.command.includes('--allow-downloads'));
  assert.deepEqual(f.calls.setup[0].args, {}); assert.equal(f.calls.setup[0].execution.signal, setup.request.signal);
  assert.equal(f.calls.describe.length, 0); assert.equal(f.calls.mutate.length, 0);
  for (const action of ['status', 'setup']) {
    const result = await f.request(action, { backend: 'cloud', target: 'DO_NOT_EXTRACT', ns: 'other-instance' });
    assert.equal(result.data.code, 'invalid_input');
    assert.equal((await f.request(action, undefined, { method: 'GET' })).response.status, 405);
  }
});

test('runtime errors and missing settings/runtime never echo raw exception values', async () => {
  const f = routes(); f.runtime.status = async () => { throw new Error(SECRET + ' other-instance'); };
  assert.equal((await f.request('status', {})).data.code, 'settings_unavailable');
  delete f.ctx.settings;
  assert.equal((await f.request()).data.code, 'settings_unavailable');
  const g = routes(fixture(), { runtime: undefined });
  assert.equal((await g.request('setup', {})).data.code, 'settings_unavailable');
});
