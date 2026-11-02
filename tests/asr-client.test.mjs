import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const KEY = 'NEW-PRIVATE-KEY-NEVER-RENDER';
const OLD_KEY = 'OLD-PRIVATE-KEY-NEVER-RETURN';
const COMMAND = "& 'C:/Python/python.exe' '-B' 'C:/plugin/python/setup_environment.py' '--backend' 'local' '--state-dir' 'C:/state' '--model' 'small' '--allow-downloads'";
const defaults = { mode: 'captions', defaultLanguage: 'auto', pythonPath: '', stateDir: '', outputDir: '', proxy: '',
  localModel: 'small', localModelDir: '', localDevice: 'cpu', localComputeType: 'int8', cloudEndpoint: '', cloudModel: '',
  cloudProviderName: '', cloudProtocol: 'auto', cloudResponseFormat: 'verbose_json', cloudAppId: '', cloudRegion: '', cloudResourceId: '',
  cloudApiKeyFile: '', cloudUploadConsent: false, cloudMaxAudioMiB: 25, allowInsecureLoopback: false,
  downloadTimeout: 300, asrTimeout: 3600, maxDuration: 14400 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function fixture(options = {}) {
  let module;
  let revision = 4, values = { ...defaults, ...options.values }, savedKey = options.savedKey || '';
  const calls = [], copied = [], effects = [], refs = [], rendered = [];
  const React = options.React || {
    createElement(type, props, ...children) { const item = { type, props, children }; rendered.push(item); return item; },
    useRef() { const value = { current: null }; refs.push(value); return value; },
    useState(value) { return [value, () => {}]; }, useEffect(effect) { effects.push(effect); },
  };
  function snapshot() {
    const response = { status: 'ok', revision, values: { ...values }, secretConfigured: !!savedKey };
    Object.defineProperty(response.values, 'cloudApiKey', { get() { throw new Error('secret must not be read'); } });
    Object.defineProperty(response, 'cloudApiKey', { get() { throw new Error('secret must not be read'); } });
    return response;
  }
  const fetch = async (url, request) => {
    const action = url.split('/').at(-1), body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ url, request, action, body });
    if (options.reply) {
      const custom = await options.reply(action, request.method, body, { snapshot, values, revision });
      if (custom) return custom;
    }
    let value;
    if (action === 'config') { assert.equal(request.method, 'GET'); value = snapshot(); }
    else if (action === 'save') {
      assert.equal(request.method, 'POST');
      assert.equal(body.revision, revision);
      assert.equal('cloudApiKey' in body.patch, false);
      values = { ...values, ...body.patch };
      if (body.secret?.action === 'set') savedKey = body.secret.value;
      if (body.secret?.action === 'clear') savedKey = '';
      revision++;
      value = snapshot();
    } else if (action === 'status') value = { status: 'ok', result: { status: 'ok',
      backend: { status: 'dependency_missing', missing_dependencies: ['faster-whisper', OLD_KEY], apiKey: OLD_KEY }, message: OLD_KEY } };
    else if (action === 'setup') value = { status: 'ok', result: { status: 'setup_command_prepared', command: COMMAND, executed: false, apiKey: OLD_KEY } };
    else throw new Error('Unexpected request: no auth, provider or installation allowed');
    return { status: 200, ok: true, async json() { return value; } };
  };
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const context = { window: { fetch, navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    __ModuleLoader__: { load(value) { module = value; } } }, URL, AbortController, TextEncoder, setTimeout, clearTimeout, Date };
  vm.runInNewContext(source, context, { timeout: 3000 });
  const exports = module.factory(name => { assert.equal(name, 'react'); return React; });
  const asr = exports._testing.asr;
  const controller = asr.createController();
  return { controller, asr, calls, copied, effects, refs, rendered, exports,
    getSavedKey: () => savedKey, snapshot };
}
function response(status, code, message = OLD_KEY, field) {
  return { status, ok: false, async json() { return { status: 'error', code, message, field, cloudApiKey: OLD_KEY }; } };
}
function treeNodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children || []).flatMap(item => Array.isArray(item) ? item.flatMap(treeNodes) : treeNodes(item))];
}
async function renderMode(mode, extra = {}) {
  const view = { loading: false, busy: false, draft: { ...defaults, mode }, values: { ...defaults, mode },
    dirty: false, secretConfigured: true, secretAction: 'keep', secretEpoch: 1, conflict: false, error: '', notice: '', result: null, command: '', ...extra };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return { current: null }; }, useState() { return [view, () => {}]; }, useEffect() {} };
  const built = await fixture({ React });
  return { ...built, tree: built.asr.Component(), view };
}

test('initial config GET is same-origin only and does not start QR, ASR, status or installation', async () => {
  const { controller, calls } = await fixture();
  assert.equal(await controller.load(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'api/video-study/asr/config');
  assert.equal(calls[0].request.method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].request.cache, 'no-store');
  assert.equal(calls[0].request.mode, 'same-origin');
  assert.equal(calls[0].request.credentials, 'same-origin');
  assert.equal(calls[0].request.redirect, 'error');
  assert.equal(controller.snapshot().draft.mode, 'captions');
  assert.equal(controller.snapshot().dirty, false);
  controller.dispose();
});

test('unloaded mode select uses a disabled empty placeholder and retains all three actual options', async () => {
  for (const loading of [true, false]) {
    const f = await renderMode('captions', { loading, values: null, error: loading ? '' : '设置服务返回格式无效，未确认完成。' });
    const nodes = treeNodes(f.tree), mode = nodes.find(node => node.type === 'select');
    assert.equal(mode.props.value, ''); assert.equal(mode.props.disabled, true);
    const options = treeNodes(mode).filter(node => node.type === 'option');
    assert.deepEqual(options.map(node => node.props.value), ['', 'captions', 'cloud', 'local']);
    assert.equal(options[0].props.disabled, true);
    assert.equal(options[0].children[0], loading ? '读取设置中…' : '设置未载入');
    assert.equal(JSON.stringify(f.tree).includes('不识别音频'), false);
    for (const name of ['保存设置', '检查环境', '生成部署命令'])
      assert.equal(nodes.find(node => node.type === 'button' && node.children[0] === name).props.disabled, true);
    if (!loading) assert.match(JSON.stringify(f.tree), /设置未载入/);
  }
});

test('GET failure leaves settings unloaded and cannot trigger save, environment, setup or automatic retries', async () => {
  const f = await fixture({ reply: async action => action === 'config'
    ? { status: 500, ok: false, async json() { throw new Error(OLD_KEY); } } : undefined });
  assert.equal(await f.controller.load(), false);
  assert.equal(f.controller.snapshot().values, null); assert.equal(f.controller.snapshot().revision, null);
  assert.equal(f.controller.update('mode', 'cloud'), false);
  assert.equal(await f.controller.save(), false); assert.equal(await f.controller.check(), false); assert.equal(await f.controller.setup(), false);
  await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.snapshot().error, '设置未载入，请先重新载入。');
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false);
  f.controller.dispose();
});

test('pending GET shows loading placeholder, then a successful snapshot enables the real server mode', async () => {
  let finish;
  const f = await fixture({ values: { mode: 'cloud' }, reply: async (action, method, _body, { snapshot }) => action === 'config' && method === 'GET'
    ? new Promise(resolve => { finish = () => resolve({ status: 200, ok: true, async json() { return snapshot(); } }); }) : undefined });
  const pending = f.controller.load(); await flush();
  assert.equal(f.controller.snapshot().values, null);
  const waiting = await renderMode('captions', { ...f.controller.snapshot() });
  assert.equal(treeNodes(waiting.tree).find(node => node.type === 'select').props.value, '');
  assert.equal(f.controller.update('mode', 'local'), false); assert.equal(await f.controller.save(), false);
  finish(); assert.equal(await pending, true);
  const ready = await renderMode('cloud', { ...f.controller.snapshot() });
  const mode = treeNodes(ready.tree).find(node => node.type === 'select');
  assert.equal(mode.props.value, 'cloud'); assert.equal(mode.props.disabled, false);
  assert.deepEqual(treeNodes(mode).filter(node => node.type === 'option').map(node => node.props.value), ['captions', 'cloud', 'local']);
  f.controller.dispose();
});

test('each loaded server mode remains selectable and persists through POST save only with CAS', async () => {
  for (const [initial, next] of [['captions', 'cloud'], ['cloud', 'local'], ['local', 'captions']]) {
    const f = await fixture({ values: { mode: initial } }); await f.controller.load();
    const ready = await renderMode(initial, { ...f.controller.snapshot() });
    const mode = treeNodes(ready.tree).find(node => node.type === 'select');
    assert.equal(mode.props.value, initial); assert.equal(mode.props.disabled, false);
    assert.equal(f.controller.update('mode', next), true); assert.equal(await f.controller.save(), true);
    assert.equal(f.calls[1].url, 'api/video-study/asr/save'); assert.equal(f.calls[1].request.method, 'POST');
    assert.equal(f.calls[1].body.revision, 4); assert.equal(f.calls[1].body.patch.mode, next);
    assert.equal(f.controller.snapshot().draft.mode, next); assert.equal(f.controller.snapshot().dirty, false);
    assert.equal(f.calls.some(call => call.action === 'config' && call.request.method === 'POST'), false);
    f.controller.dispose();
  }
});

test('failed explicit reload does not reuse a previous snapshot to unlock settings actions', async () => {
  let unavailable = false;
  const f = await fixture({ values: { mode: 'local' }, reply: async action => action === 'config' && unavailable
    ? response(503, 'settings_unavailable') : undefined });
  await f.controller.load(); unavailable = true;
  assert.equal(await f.controller.load(), false); assert.equal(f.controller.snapshot().values, null);
  assert.equal(f.controller.update('mode', 'cloud'), false); assert.equal(await f.controller.save(), false);
  assert.equal(await f.controller.check(), false); assert.equal(await f.controller.setup(), false);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'config']); f.controller.dispose();
});

test('snapshot never reads or exposes API key values, only secretConfigured', async () => {
  const { controller } = await fixture({ savedKey: OLD_KEY });
  await controller.load();
  assert.equal(controller.snapshot().secretConfigured, true);
  assert.equal('cloudApiKey' in controller.snapshot().values, false);
  assert.equal(JSON.stringify(controller.snapshot()).includes(OLD_KEY), false);
  controller.setSecret(KEY);
  assert.equal(JSON.stringify(controller.snapshot()).includes(KEY), false);
  controller.dispose();
});

test('mode selection is draft-only; cloud upload authorization never becomes implicit', async () => {
  const { controller, calls } = await fixture();
  await controller.load(); controller.update('mode', 'cloud');
  assert.equal(calls.length, 1);
  assert.equal(controller.snapshot().dirty, true);
  assert.equal(controller.snapshot().draft.cloudUploadConsent, false);
  await controller.save();
  assert.equal(calls[1].body.patch.mode, 'cloud');
  assert.equal(calls[1].body.patch.cloudUploadConsent, undefined);
  assert.equal(controller.snapshot().dirty, false);
  assert.equal(controller.snapshot().draft.cloudUploadConsent, false);
  controller.update('cloudUploadConsent', true); await controller.save();
  assert.equal(calls[2].body.patch.cloudUploadConsent, true);
  controller.dispose();
});

test('empty new Key means keep; only explicit set/clear changes the stored secret', async () => {
  const f = await fixture({ values: { mode: 'cloud' }, savedKey: OLD_KEY });
  await f.controller.load(); f.controller.setSecret(''); f.controller.update('cloudModel', 'model-one');
  await f.controller.save();
  assert.equal(f.calls[1].body.secret.action, 'keep');
  assert.equal('value' in f.calls[1].body.secret, false);
  assert.equal(f.getSavedKey(), OLD_KEY);
  const epoch = f.controller.snapshot().secretEpoch;
  f.controller.setSecret(KEY); await f.controller.save();
  assert.equal(f.calls[2].body.secret.action, 'set'); assert.equal(f.calls[2].body.secret.value, KEY);
  assert.equal(f.getSavedKey(), KEY);
  assert.equal(f.controller.snapshot().secretAction, 'keep');
  assert.equal(f.controller.snapshot().secretDraftPresent, false);
  assert.ok(f.controller.snapshot().secretEpoch > epoch);
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(KEY), false);
  f.controller.clearSecret(true); await f.controller.save();
  assert.equal(f.calls[3].body.secret.action, 'clear');
  assert.equal('value' in f.calls[3].body.secret, false);
  assert.equal(f.getSavedKey(), ''); assert.equal(f.controller.snapshot().secretConfigured, false);
  f.controller.dispose();
});

test('switching away from cloud drops only the unsaved secret, never implicitly clears the saved one', async () => {
  const f = await fixture({ values: { mode: 'cloud' }, savedKey: OLD_KEY });
  await f.controller.load(); f.controller.setSecret(KEY); f.controller.update('mode', 'local'); await f.controller.save();
  assert.equal(f.calls[1].body.secret.action, 'keep'); assert.equal(f.getSavedKey(), OLD_KEY);
  assert.equal(f.controller.snapshot().secretDraftPresent, false);
  f.controller.dispose();
});

test('unsaved edits block environment/setup calls until a successful save', async () => {
  const f = await fixture(); await f.controller.load(); f.controller.update('mode', 'local');
  assert.equal(await f.controller.check(), false); assert.equal(await f.controller.setup(), false);
  assert.equal(f.calls.length, 1); assert.equal(f.controller.snapshot().error, '请先保存设置。');
  await f.controller.save(); await f.controller.check(); await f.controller.setup();
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'save', 'status', 'setup']);
  for (const call of f.calls.slice(2)) { assert.equal(call.request.method, 'POST'); assert.deepEqual(call.body, {}); }
  assert.equal(f.controller.snapshot().command, COMMAND);
  assert.equal(f.copied.length, 0);
  await f.controller.copy(); assert.deepEqual(f.copied, [COMMAND]);
  f.controller.dispose();
});

test('status presents only safe offline summary and approved dependency names', async () => {
  const f = await fixture({ values: { mode: 'local' } }); await f.controller.load(); await f.controller.check();
  assert.equal(f.controller.snapshot().result.label, '缺少依赖');
  assert.deepEqual(Array.from(f.controller.snapshot().result.missing), ['faster-whisper']);
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false);
  assert.equal(f.calls.length, 2); f.controller.dispose();
});

test('CAS409 forces explicit reload rather than silently retrying or merging stale values', async () => {
  let conflict = true;
  const f = await fixture({ reply: async (action, method) => action === 'save' && method === 'POST' && conflict
    ? response(409, 'settings_conflict') : undefined });
  await f.controller.load(); f.controller.update('mode', 'local'); f.controller.setSecret(KEY);
  assert.equal(await f.controller.save(), false);
  assert.equal(f.controller.snapshot().conflict, true); assert.match(f.controller.snapshot().error, /重新载入/);
  assert.equal(f.controller.update('mode', 'cloud'), false);
  assert.equal(await f.controller.check(), false); assert.equal(await f.controller.setup(), false);
  assert.equal(f.calls.length, 2); assert.equal(JSON.stringify(f.controller.snapshot()).includes(KEY), false);
  conflict = false; await f.controller.load();
  assert.equal(f.controller.snapshot().conflict, false); assert.equal(f.controller.snapshot().draft.mode, 'captions');
  f.controller.update('defaultLanguage', 'zh'); await f.controller.save();
  assert.equal(f.calls.at(-1).body.patch.defaultLanguage, 'zh'); f.controller.dispose();
});

test('only known nonsecret differences are patched with the exact loaded numeric revision', async () => {
  const f = await fixture(); await f.controller.load();
  assert.equal(f.controller.update('cloudApiKey', KEY), false); assert.equal(f.controller.update('otherPlugin', true), false);
  f.controller.update('defaultLanguage', 'en'); f.controller.update('pythonPath', 'C:/Python/python.exe'); await f.controller.save();
  const body = f.calls[1].body;
  assert.equal(body.revision, 4);
  assert.deepEqual(body.patch, { defaultLanguage: 'en', pythonPath: 'C:/Python/python.exe' });
  assert.equal(f.calls[1].request.headers['Content-Type'], 'application/json'); f.controller.dispose();
});

test('all server errors and unknown messages are static and never expose secret/server text', async () => {
  for (const code of ['settings_save_failed', 'settings_unavailable', 'invalid_input', 'unknown-error']) {
    const f = await fixture({ reply: async (action, method) => method === 'POST' ? response(500, code) : undefined });
    await f.controller.load(); f.controller.update('mode', 'cloud'); f.controller.setSecret(KEY); await f.controller.save();
    const visible = JSON.stringify(f.controller.snapshot());
    for (const secret of [KEY, OLD_KEY, 'unknown-error']) assert.equal(visible.includes(secret), false);
    assert.equal(f.controller.snapshot().dirty, true); f.controller.dispose();
  }
});

test('save errors show safe field-specific guidance but no raw provider text or untrusted field name', async () => {
  for (const [field, expected] of [['cloudEndpoint', /API地址/], ['cloudModel', /模型/], ['cloudApiKey', /API Key/],
    ['cloudMaxAudioMiB', /不是文字字数限制/], ['FAKE_UNTRUSTED_FIELD', /设置格式无效/], ['__proto__', /设置格式无效/]]) {
    const f = await fixture({ reply: async action => action === 'save' ? response(400, 'invalid_input', OLD_KEY, field) : undefined });
    await f.controller.load(); f.controller.update('cloudModel', 'model');
    assert.equal(await f.controller.save(), false); assert.match(f.controller.snapshot().error, expected);
    assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false);
    assert.equal(JSON.stringify(f.controller.snapshot()).includes('FAKE_UNTRUSTED_FIELD'), false);
    assert.equal(f.controller.snapshot().dirty, true); f.controller.dispose();
  }
});

test('native unsupported model is explained during offline check without using raw error messages', async () => {
  const f = await fixture({ values: { mode: 'cloud' }, reply: async action => action === 'status'
    ? { status: 200, ok: true, async json() { return { status: 'ok', result: { backend: { status: 'unsupported_model', message: OLD_KEY } } }; } } : undefined });
  await f.controller.load(); assert.equal(await f.controller.check(), true);
  assert.match(f.controller.snapshot().result.label, /该协议不支持/);
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false); f.controller.dispose();
});

test('model input has no maxLength and preserves punctuation and long unicode names in save', async () => {
  const f = await fixture({ values: { mode: 'cloud' } }); await f.controller.load();
  const model = '供应商 model [v2] ' + 'x'.repeat(6000);
  f.controller.update('cloudModel', model); assert.equal(await f.controller.save(), true);
  assert.equal(f.calls[1].body.patch.cloudModel, model); assert.equal(f.controller.snapshot().draft.cloudModel, model);
  const rendered = await renderMode('cloud');
  for (const node of treeNodes(rendered.tree).filter(node => node.type === 'input')) assert.equal(node.props.maxLength, undefined);
  const visible = JSON.stringify(rendered.tree);
  assert.match(visible, /服务名称（自定义）/); assert.match(visible, /48小时/); assert.match(visible, /可能继续并计费/);
  for (const name of ['硅基流动', '阿里 Qwen-ASR', '腾讯云', '火山', 'Groq', '接口协议', '服务默认']) assert.match(visible, new RegExp(name));
  f.controller.dispose();
});

test('presets are draft-only editable suggestions, keep the saved key, and never choose a provider by name', async () => {
  const f = await fixture({ values: { mode: 'cloud', cloudUploadConsent: true, cloudApiKeyFile: 'C:/old.key' }, savedKey: OLD_KEY });
  await f.controller.load(); f.controller.setSecret(KEY);
  assert.equal(f.controller.applyPreset('siliconflow'), true);
  let state = f.controller.snapshot(); assert.equal(f.calls.length, 1);
  assert.equal(state.draft.cloudProtocol, 'openai'); assert.equal(state.draft.cloudResponseFormat, 'provider_default');
  assert.equal(state.secretAction, 'keep'); assert.equal(state.secretDraftPresent, false);
  assert.equal(state.draft.cloudUploadConsent, false);
  f.controller.update('cloudProviderName', '我的代理，不是硅基'); f.controller.update('cloudEndpoint', 'https://gateway.example.test/any/path');
  f.controller.update('cloudModel', '未来的自定义模型');
  assert.equal(f.controller.snapshot().draft.cloudProtocol, 'openai');
  assert.equal(await f.controller.save(), true); assert.equal(f.calls[1].body.secret.action, 'keep');
  assert.equal(f.getSavedKey(), OLD_KEY);
  assert.equal(f.calls[1].body.patch.cloudModel, '未来的自定义模型');
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(KEY), false);
  for (const [id, protocol] of [['paraformer', 'dashscope_paraformer'], ['qwen', 'dashscope_qwen'], ['tencent', 'tencent_rec_task'], ['volcengine', 'volcengine_flash']]) {
    assert.equal(f.controller.applyPreset(id), true); assert.equal(f.controller.snapshot().draft.cloudProtocol, protocol);
    assert.equal(f.controller.snapshot().draft.cloudUploadConsent, false);
  }
  assert.equal(f.controller.applyPreset('__proto__'), false); f.controller.dispose();
});

test('editing destination identifiers keeps the saved key, drops only the unsaved draft, and revokes consent', async () => {
  for (const key of ['cloudEndpoint', 'cloudProtocol', 'cloudAppId', 'cloudRegion', 'cloudResourceId']) {
    const f = await fixture({ values: { mode: 'cloud', cloudUploadConsent: true }, savedKey: OLD_KEY }); await f.controller.load(); f.controller.setSecret(KEY);
    f.controller.update(key, key === 'cloudProtocol' ? 'openai' : 'NEW');
    const state = f.controller.snapshot(); assert.equal(state.secretAction, 'keep'); assert.equal(state.secretDraftPresent, false);
    assert.equal(state.draft.cloudUploadConsent, false); assert.equal(JSON.stringify(state).includes(KEY), false);
    assert.equal(await f.controller.save(), true); assert.equal(f.getSavedKey(), OLD_KEY); f.controller.dispose();
  }
  const f = await fixture({ values: { mode: 'cloud', cloudUploadConsent: true } }); await f.controller.load(); f.controller.setSecret(KEY);
  f.controller.update('cloudProviderName', '任意名字'); f.controller.update('cloudModel', '任意模型');
  assert.equal(f.controller.snapshot().secretAction, 'set'); assert.equal(f.controller.snapshot().draft.cloudUploadConsent, true); f.controller.dispose();
});

test('setup is display/copy only and cannot accept an executed result or raw key as command', async () => {
  for (const result of [{ status: 'setup_command_prepared', executed: true, command: COMMAND },
    { status: 'setup_command_prepared', executed: false, command: OLD_KEY }]) {
    const f = await fixture({ reply: async action => action === 'setup'
      ? { status: 200, ok: true, async json() { return { status: 'ok', result }; } } : undefined });
    await f.controller.load(); assert.equal(await f.controller.setup(), false);
    assert.equal(f.controller.snapshot().command, ''); assert.equal(f.copied.length, 0);
    assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false); f.controller.dispose();
  }
});

test('unsaved secret alone blocks environment/setup, and missing setup dependencies are shown safely', async () => {
  const f = await fixture({ values: { mode: 'cloud' }, reply: async action => action === 'setup'
    ? { status: 200, ok: true, async json() { return { status: 'ok', result: { status: 'dependency_missing', message: OLD_KEY } }; } } : undefined });
  await f.controller.load(); f.controller.setSecret(KEY);
  assert.equal(await f.controller.check(), false); assert.equal(await f.controller.setup(), false);
  assert.equal(f.calls.length, 1);
  await f.controller.save(); assert.equal(await f.controller.setup(), false);
  assert.match(f.controller.snapshot().error, /缺少Python/);
  assert.equal(f.controller.snapshot().command, '');
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false); f.controller.dispose();
});

test('invalid revision snapshots fail closed and host authentication errors request reload', async () => {
  for (const reply of [
    async (_action, _method, _body, { snapshot }) => ({ status: 200, ok: true, async json() { return { ...snapshot(), revision: '4' }; } }),
    async () => ({ status: 401, ok: false, async json() { throw new Error(OLD_KEY); } }),
    async () => ({ status: 404, ok: false, async json() { throw new Error(OLD_KEY); } }),
  ]) {
    const f = await fixture({ reply });
    assert.equal(await f.controller.load(), false); assert.equal(f.controller.snapshot().values, null);
    assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false); f.controller.dispose();
  }
});

test('captions, cloud and local render only their relevant basic fields; advanced remains collapsed', async () => {
  const captions = await renderMode('captions');
  const captionsText = JSON.stringify(captions.tree);
  assert.match(captionsText, /仅现有字幕/); assert.match(captionsText, /不识别音频/);
  assert.equal(captionsText.includes('API地址'), false);
  const cloud = await renderMode('cloud'); const cloudNodes = treeNodes(cloud.tree);
  const password = cloudNodes.find(node => node.type === 'input' && node.props.type === 'password');
  assert.ok(password); assert.equal(password.props.defaultValue, ''); assert.equal(password.props.value, undefined);
  assert.equal(password.props.placeholder, '已配置，留空保留');
  assert.equal(JSON.stringify(cloud.tree).includes(OLD_KEY), false);
  assert.match(JSON.stringify(cloud.tree), /允许上传音频到此服务/);
  const local = await renderMode('local'); const localText = JSON.stringify(local.tree);
  for (const label of ['模型目录', 'CPU', 'CUDA', '计算类型', 'Python路径']) assert.equal(localText.includes(label), true);
  assert.equal(localText.includes('API地址'), false);
  for (const f of [captions, cloud, local]) {
    const details = treeNodes(f.tree).find(node => node.type === 'details');
    assert.ok(details); assert.equal(details.props?.open, undefined);
  }
});

test('dirty form disables environment/setup UI buttons but preserves save and reload', async () => {
  const f = await renderMode('local', { dirty: true });
  const buttons = treeNodes(f.tree).filter(node => node.type === 'button');
  const named = name => buttons.find(node => node.children[0] === name);
  assert.equal(named('检查环境').props.disabled, true); assert.equal(named('生成部署命令').props.disabled, true);
  assert.equal(named('保存设置').props.disabled, false);
});

test('component mount loads only config, and effect cleanup/StrictMode does not retain old controllers', async () => {
  const f = await fixture(); f.asr.Component();
  let cleanup = f.effects[0](); await flush();
  assert.deepEqual(f.calls.map(call => call.action), ['config']);
  const first = f.refs[0].current; cleanup(); cleanup = f.effects[0](); await flush();
  assert.notEqual(f.refs[0].current, first);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'config']); cleanup();
});
