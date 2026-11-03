import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildClient } from '../client/build.mjs';

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
    const response = { status: 'ok', revision, values: { ...values }, secretConfigured: !!savedKey,
      ...(options.localDefaults === undefined ? {} : { localDefaults: options.localDefaults }) };
    Object.defineProperty(response.values, 'cloudApiKey', { get() { throw new Error('secret must not be read'); } });
    Object.defineProperty(response, 'cloudApiKey', { get() { throw new Error('secret must not be read'); } });
    return response;
  }
  const fetch = async (url, request) => {
    const action = url.split('/').at(-1), body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ url, request, action, body });
    if (options.reply) {
      const custom = await options.reply(action, request.method, body, { snapshot, values, revision, signal: request.signal });
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
  const source = await buildClient({ write: false });
  const context = { window: { fetch, navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    __DSH_DIRECTORY_PICKER__: options.desktopPicker,
    __ModuleLoader__: { load(value) { module = value; } } }, URL, AbortController, TextEncoder, setTimeout, clearTimeout, Date };
  vm.runInNewContext(source, context, { timeout: 3000 });
  const exports = module.factory(name => { assert.equal(name, 'react'); return React; });
  const asr = exports._testing.asr;
  const controller = asr.createController(options.controllerOptions);
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
  const componentRef = { current: null };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return componentRef; }, useState() { return [view, () => {}]; }, useEffect() {} };
  const built = await fixture({ React });
  return { ...built, tree: built.asr.Component(), view, componentRef };
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

function ok(value) { return { status: 200, ok: true, async json() { return value; } }; }

test('picker posts only allowed field, fills draft only, and preserves unrelated draft, Key and upload authorization', async () => {
  const paths = { pythonPath: 'C:\\Python 3\\python.exe', localModelDir: 'D:\\模型\\small' };
  const f = await fixture({ values: { mode: 'cloud', cloudUploadConsent: true }, savedKey: OLD_KEY,
    reply: async (action, method, body) => action === 'pick-path' ? ok({ status: 'ok', cancelled: false, path: paths[body.field], message: OLD_KEY }) : undefined });
  await f.controller.load(); f.controller.update('cloudModel', 'unsaved-model'); f.controller.setSecret(KEY);
  assert.equal(await f.controller.pickPath('cloudApiKeyFile'), false);
  assert.equal(await f.controller.pickPath('__proto__'), false);
  for (const field of ['pythonPath', 'localModelDir']) {
    assert.equal(await f.controller.pickPath(field), true);
    const call = f.calls.at(-1);
    assert.equal(call.url, 'api/video-study/asr/pick-path'); assert.equal(call.request.method, 'POST');
    assert.deepEqual(call.body, { field });
    assert.equal(call.request.mode, 'same-origin'); assert.equal(call.request.cache, 'no-store');
    assert.equal(f.controller.snapshot().draft[field], paths[field]);
  }
  const state = f.controller.snapshot();
  assert.equal(state.revision, 4); assert.equal(state.dirty, true); assert.equal(state.draft.cloudModel, 'unsaved-model');
  assert.equal(state.draft.cloudUploadConsent, true); assert.equal(state.secretAction, 'set'); assert.equal(state.secretDraftPresent, true);
  assert.equal(f.calls.some(call => call.action === 'save'), false);
  assert.equal(JSON.stringify(state).includes(KEY), false); assert.equal(JSON.stringify(state).includes(OLD_KEY), false);
  assert.equal(await f.controller.save(), true); assert.equal(f.getSavedKey(), KEY);
  assert.deepEqual(f.calls.at(-1).body.patch, { cloudModel: 'unsaved-model', ...paths });
  assert.equal(f.calls.at(-1).body.secret.value, KEY); f.controller.dispose();
});

test('picker cancellation ignores any returned path and retains exact draft without save or setup', async () => {
  const f = await fixture({ values: { mode: 'local', pythonPath: 'C:/old/python.exe' },
    reply: async action => action === 'pick-path' ? ok({ status: 'ok', cancelled: true, path: 'C:/unwanted/python.exe', message: OLD_KEY }) : undefined });
  await f.controller.load(); f.controller.update('localModelDir', 'D:/unsaved');
  const before = JSON.stringify(f.controller.snapshot().draft);
  assert.equal(await f.controller.pickPath('pythonPath'), false);
  assert.equal(JSON.stringify(f.controller.snapshot().draft), before); assert.equal(f.controller.snapshot().busy, false);
  assert.match(f.controller.snapshot().notice, /取消.*草稿未改变/);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'pick-path']); f.controller.dispose();
});

test('open picker locks edits and other actions, and conflicts never reopen a picker or overwrite draft', async () => {
  let finish;
  const f = await fixture({ values: { mode: 'local' }, reply: async action => action === 'pick-path'
    ? new Promise(resolve => { finish = () => resolve(ok({ status: 'ok', cancelled: false, path: 'D:/selected-model' })); }) : undefined });
  await f.controller.load(); f.controller.update('localModelDir', 'D:/unsaved');
  const pending = f.controller.pickPath('localModelDir'); await flush();
  assert.equal(f.controller.snapshot().busy, true);
  assert.equal(f.controller.update('pythonPath', 'C:/ignored.exe'), false);
  assert.equal(await f.controller.pickPath('pythonPath'), false); assert.equal(await f.controller.save(), false);
  assert.equal(await f.controller.setup(), false); assert.equal(await f.controller.check(), false); assert.equal(await f.controller.load(), false);
  assert.equal(f.calls.length, 2); finish(); assert.equal(await pending, true);
  assert.equal(f.controller.snapshot().draft.localModelDir, 'D:/selected-model'); f.controller.dispose();
  const stale = await fixture({ reply: async action => action === 'save' ? response(409, 'settings_conflict') : undefined });
  await stale.controller.load(); stale.controller.update('localModelDir', 'D:/keep-draft'); await stale.controller.save();
  assert.equal(await stale.controller.pickPath('localModelDir'), false);
  assert.equal(stale.controller.snapshot().draft.localModelDir, 'D:/keep-draft'); assert.equal(stale.calls.length, 2); stale.controller.dispose();
});

test('picker rejects malformed, relative, URL and browser fakepath responses without rendering raw server text', async () => {
  for (const value of [
    { cancelled: false, path: 'relative/model' }, { cancelled: false, path: 'C:relative' },
    { cancelled: false, path: 'https://example.test/model' }, { cancelled: false, path: 'C:\\fakepath\\python.exe' },
    { cancelled: false, path: 'C:/bad\npath' }, { cancelled: false, path: '' }, { cancelled: false, path: {} },
    { cancelled: 'no', path: 'C:/python.exe' }, { path: 'C:/python.exe' }
  ]) {
    const f = await fixture({ values: { pythonPath: 'C:/keep/python.exe' },
      reply: async action => action === 'pick-path' ? ok({ status: 'ok', ...value, message: OLD_KEY }) : undefined });
    await f.controller.load(); const before = JSON.stringify(f.controller.snapshot().draft);
    assert.equal(await f.controller.pickPath('pythonPath'), false);
    assert.equal(JSON.stringify(f.controller.snapshot().draft), before);
    assert.equal(f.controller.snapshot().error, '设置服务返回格式无效，未确认完成。');
    assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false); f.controller.dispose();
  }
});

test('picker static errors support unsupported host, missing Python, busy, failed, cancelled and conflict safely', async () => {
  for (const [code, expected] of [['picker_unavailable', /手动填写/], ['python_not_found', /安装目录或venv目录/],
    ['picker_busy', /完成或取消/], ['picker_failed', /手动填写/], ['cancelled', /草稿未改变/], ['settings_conflict', /重新载入/],
    ['UNTRUSTED-PICKER-ERROR', /操作未完成/]]) {
    const f = await fixture({ reply: async action => action === 'pick-path' ? response(code === 'settings_conflict' ? 409 : 503, code) : undefined });
    await f.controller.load(); f.controller.update('pythonPath', 'C:/keep/python.exe');
    assert.equal(await f.controller.pickPath('pythonPath'), false);
    const state = f.controller.snapshot(); assert.equal(state.draft.pythonPath, 'C:/keep/python.exe'); assert.match(state.error, expected);
    assert.equal(JSON.stringify(state).includes(OLD_KEY), false); assert.equal(JSON.stringify(state).includes('UNTRUSTED-PICKER-ERROR'), false);
    assert.equal(state.conflict, code === 'settings_conflict'); assert.equal(f.calls.length, 2); f.controller.dispose();
  }
});

test('120s picker timeout rejects even late success, while disposal aborts and never applies a selected path', async () => {
  for (const disposed of [false, true]) {
    const timers = []; let finish, signal;
    const f = await fixture({ controllerOptions: { setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeout() {} },
      reply: async (action, _method, _body, context) => action === 'pick-path'
        ? new Promise(resolve => { signal = context.signal; finish = () => resolve(ok({ status: 'ok', cancelled: false, path: '/late/python' })); }) : undefined });
    await f.controller.load(); f.controller.update('pythonPath', '/keep/python');
    const pending = f.controller.pickPath('pythonPath'); await flush();
    assert.equal(timers.at(-1).delay, 120000);
    if (disposed) f.controller.dispose(); else timers.at(-1).fn();
    assert.equal(signal.aborted, true); finish(); assert.equal(await pending, false);
    assert.equal(f.controller.snapshot().draft.pythonPath, '/keep/python');
    if (!disposed) { assert.match(f.controller.snapshot().error, /超时/); assert.equal(f.controller.snapshot().busy, false); }
    assert.equal(f.calls.length, 2); f.controller.dispose();
  }
});

test('optional localDefaults metadata is display-only, uses draft root/model, and missing metadata uses honest placeholders', async () => {
  for (const [metadata, root, modelPath, pythonPath] of [
    [{ stateDir: 'C:\\状态', platform: 'win32' }, '', 'C:\\状态\\models\\medium', 'C:\\状态\\venv\\Scripts\\python.exe'],
    [{ stateDir: '/server/state', platform: 'linux' }, '', '/server/state/models/medium', '/server/state/venv/bin/python'],
    [{ stateDir: '/server/state', platform: 'darwin' }, '/custom/state', '/custom/state/models/medium', '/custom/state/venv/bin/python'],
    [undefined, '', '<状态目录>/models/medium', '<状态目录>/venv/Scripts/python.exe'],
    [{ stateDir: 'BAD-RAW-DEFAULT', platform: 'unknown' }, '', '<状态目录>/models/medium', '<状态目录>/venv/Scripts/python.exe']
  ]) {
    const f = await fixture({ values: { mode: 'local' }, localDefaults: metadata }); await f.controller.load();
    if (root) f.controller.update('stateDir', root);
    f.controller.update('localModel', 'medium');
    const rendered = await renderMode('local', { ...f.controller.snapshot() });
    const text = treeNodes(rendered.tree).flatMap(node => node.children || []).filter(value => typeof value === 'string').join(' ');
    assert.ok(text.includes(modelPath), modelPath);
    assert.equal(text.includes(pythonPath), false, 'Do not restore the removed long Python deployment hint');
    assert.match(text, /选择Python安装或venv文件夹；留空自动查找/);
    assert.equal(text.includes('BAD-RAW-DEFAULT'), false); assert.equal(f.calls.length, 1);
    assert.equal('localDefaults' in f.controller.snapshot().draft, false); await f.controller.save();
    assert.equal('localDefaults' in f.calls.at(-1).body.patch, false); f.controller.dispose();
  }
});

test('local settings keep short field hints and remove the unwanted deployment essay and six-step list', async () => {
  const f = await renderMode('local'); const nodes = treeNodes(f.tree); const text = JSON.stringify(f.tree);
  for (const phrase of ['选择Python文件夹…', '选择模型文件夹…', '选择Python安装或venv文件夹；留空自动查找', '留空使用：'])
    assert.ok(text.includes(phrase), phrase);
  for (const phrase of ['初次部署推荐', '服务端本机路径', '不会安装到显式Python路径或模型目录', '不保证CUDA', 'forceAsr:true'])
    assert.equal(text.includes(phrase), false, phrase);
  assert.equal(nodes.filter(node => node.type === 'input').some(node => node.props.type === 'file'), false);
  assert.equal(nodes.some(node => node.type === 'ol'), false);
  assert.deepEqual(f.calls, []);
  for (const state of [{ busy: true }, { conflict: true }, { loading: true }, { values: null }]) {
    const locked = await renderMode('local', state);
    for (const node of treeNodes(locked.tree).filter(node => node.type === 'button' && /选择.*文件夹|恢复默认/.test(node.children[0])))
      assert.equal(node.props.disabled, true);
  }
});

test('fake React picker/reset buttons change controller draft only, while compute selects keep custom choices on device change', async () => {
  const f = await fixture({ values: { mode: 'local', localComputeType: 'custom-compute', localModelDir: '/old/model' },
    reply: async action => action === 'pick-path' ? ok({ status: 'ok', cancelled: false, path: '/chosen/bin/python' }) : undefined });
  await f.controller.load(); const rendered = await renderMode('local', { ...f.controller.snapshot() }); rendered.componentRef.current = f.controller;
  const nodes = treeNodes(rendered.tree), named = name => nodes.find(node => node.type === 'button' && node.children[0] === name);
  named('选择Python文件夹…').props.onClick(); await flush();
  assert.equal(f.controller.snapshot().draft.pythonPath, '/chosen/bin/python');
  named('恢复默认Python').props.onClick(); named('恢复默认模型目录').props.onClick();
  assert.equal(f.controller.snapshot().draft.pythonPath, ''); assert.equal(f.controller.snapshot().draft.localModelDir, '');
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'pick-path']);
  const compute = nodes.find(node => node.type === 'select' && node.props.value === 'custom-compute');
  assert.ok(compute); assert.ok(treeNodes(compute).some(node => node.type === 'option' && node.props.value === 'custom-compute'));
  assert.ok(treeNodes(compute).some(node => node.type === 'option' && node.props.value === 'int8'));
  assert.ok(treeNodes(compute).some(node => node.type === 'option' && node.props.value === 'float16'));
  const device = nodes.find(node => node.type === 'select' && node.props.value === 'cpu');
  device.props.onChange({ currentTarget: { value: 'cuda' } });
  assert.equal(f.controller.snapshot().draft.localDevice, 'cuda'); assert.equal(f.controller.snapshot().draft.localComputeType, 'custom-compute');
  compute.props.onChange({ currentTarget: { value: 'float16' } }); assert.equal(f.controller.snapshot().draft.localComputeType, 'float16');
  assert.equal(f.calls.length, 2); f.controller.dispose();
});

test('offline status displays only known absolute resolved paths and safe next steps, never unknown diagnostics', async () => {
  for (const bad of [false, true]) {
    const f = await fixture({ values: { mode: 'local' }, reply: async action => action === 'status' ? ok({ status: 'ok', result: {
      python_executable: bad ? 'https://secret.test/' + OLD_KEY : '/state/venv/bin/python', message: OLD_KEY,
      backend: { status: 'model_missing', resolved_model_dir: bad ? 'C:/bad\n' + OLD_KEY : '/state/models/small', unknown: OLD_KEY }
    } }) : undefined });
    await f.controller.load(); await f.controller.check();
    const result = f.controller.snapshot().result;
    assert.equal(result.python, bad ? '' : '/state/venv/bin/python'); assert.equal(result.modelDir, bad ? '' : '/state/models/small');
    assert.match(result.next, /恢复默认.*保存/); assert.match(result.next, /留空不会自动下载/);
    const rendered = await renderMode('local', { ...f.controller.snapshot() });
    assert.equal(JSON.stringify(rendered.tree).includes(OLD_KEY), false);
    if (!bad) { assert.match(JSON.stringify(rendered.tree), /检查使用的Python/); assert.match(JSON.stringify(rendered.tree), /检查解析的模型目录/); }
    f.controller.dispose();
  }
});

test('desktop picker is invoked synchronously from the click and only resolves the chosen directory on the backend', async () => {
  let invoked = 0, finish;
  const f = await fixture({ values: { mode: 'local' }, desktopPicker: { pick(...args) {
    assert.equal(args.length, 0); invoked++; return new Promise(resolve => { finish = resolve; });
  } }, reply: async (action, method, body) => {
    if (action !== 'resolve-path') return;
    assert.equal(method, 'POST'); assert.deepEqual(body, { field: 'pythonPath', path: 'C:/Python 3' });
    return ok({ status: 'ok', cancelled: false, path: 'C:/Python 3/python.exe' });
  } });
  await f.controller.load();
  const pending = f.controller.pickPath('pythonPath');
  assert.equal(invoked, 1); assert.match(f.controller.snapshot().notice, /正在打开/);
  assert.equal(f.controller.snapshot().picking, 'pythonPath'); assert.equal(f.calls.length, 1);
  finish('C:/Python 3'); assert.equal(await pending, true);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'resolve-path']);
  assert.equal(f.controller.snapshot().draft.pythonPath, 'C:/Python 3/python.exe');
  assert.equal(f.controller.snapshot().revision, 4); f.controller.dispose();
});

test('desktop cancellation, invalid paths and IPC failures never fall back to a second dialog or leak errors', async () => {
  for (const selected of [null, 'relative', 'C:/bad\npath', undefined, 'throws']) {
    const f = await fixture({ values: { mode: 'local', pythonPath: 'C:/keep/python.exe' }, desktopPicker: { async pick() {
      if (selected === 'throws') throw new Error(OLD_KEY); return selected;
    } } });
    await f.controller.load(); assert.equal(await f.controller.pickPath('pythonPath'), false);
    assert.equal(f.controller.snapshot().draft.pythonPath, 'C:/keep/python.exe');
    assert.deepEqual(f.calls.map(call => call.action), ['config']);
    assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false);
    if (selected === null) assert.match(f.controller.snapshot().notice, /取消/);
    else assert.ok(f.controller.snapshot().error);
    f.controller.dispose();
  }
});

test('cancel immediately releases UI wait but keeps the native dialog gate until late result settles without applying it', async () => {
  let finish, invoked = 0;
  const f = await fixture({ values: { mode: 'local', localModelDir: '/keep/model' }, desktopPicker: { pick() {
    invoked++; return new Promise(resolve => { finish = resolve; });
  } } });
  await f.controller.load(); const pending = f.controller.pickPath('localModelDir');
  assert.equal(f.controller.cancelPick(), true); assert.equal(await pending, false);
  assert.equal(f.controller.snapshot().busy, false); assert.equal(f.controller.snapshot().picking, '');
  assert.match(f.controller.snapshot().notice, /取消/);
  assert.equal(await f.controller.pickPath('localModelDir'), false); assert.equal(invoked, 1);
  assert.match(f.controller.snapshot().error, /完成或取消/);
  finish('/late/model'); await flush();
  assert.equal(f.controller.snapshot().draft.localModelDir, '/keep/model');
  assert.deepEqual(f.calls.map(call => call.action), ['config']); f.controller.dispose();
});

test('picker timeout releases UI even if the desktop IPC never settles and shows the error by its field', async () => {
  const timers = [];
  const f = await fixture({ values: { mode: 'local' }, desktopPicker: { pick: () => new Promise(() => {}) },
    controllerOptions: { setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeout() {} } });
  await f.controller.load(); const pending = f.controller.pickPath('pythonPath');
  const active = await renderMode('local', { ...f.controller.snapshot() }); active.componentRef.current = f.controller;
  const nodes = treeNodes(active.tree);
  assert.ok(nodes.some(node => node.type === 'button' && node.children[0] === '正在打开…'));
  assert.equal(nodes.find(node => node.type === 'button' && node.children[0] === '取消选择').props.disabled, false);
  assert.ok(nodes.some(node => node.props?.role === 'status' && JSON.stringify(node).includes('正在打开')));
  timers.at(-1).fn(); assert.equal(await pending, false); assert.equal(f.controller.snapshot().busy, false);
  const failed = await renderMode('local', { ...f.controller.snapshot() });
  assert.ok(treeNodes(failed.tree).some(node => node.props?.role === 'alert' && JSON.stringify(node).includes('超时')));
  assert.deepEqual(f.calls.map(call => call.action), ['config']); f.controller.dispose();
});

test('component mount loads only config, and effect cleanup/StrictMode does not retain old controllers', async () => {
  const f = await fixture(); f.asr.Component();
  let cleanup = f.effects[0](); await flush();
  assert.deepEqual(f.calls.map(call => call.action), ['config']);
  const first = f.refs[0].current; cleanup(); cleanup = f.effects[0](); await flush();
  assert.notEqual(f.refs[0].current, first);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'config']); cleanup();
});
