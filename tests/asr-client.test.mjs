import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../client/asr.js', import.meta.url), 'utf8');

const KEY = 'NEW-PRIVATE-KEY-NEVER-RENDER';
const OLD_KEY = 'OLD-PRIVATE-KEY-NEVER-RETURN';
const COMMAND = "& 'C:/Python/python.exe' '-B' 'C:/plugin/python/setup_environment.py' '--backend' 'cloud' '--state-dir' 'C:/state' '--allow-downloads'";
const defaults = { mode: 'captions', defaultLanguage: 'auto', pythonPath: '', stateDir: '', outputDir: '', proxy: '',
  cloudEndpoint: '', cloudModel: '',
  cloudProviderName: '', cloudProtocol: 'auto', cloudResponseFormat: 'verbose_json', cloudAppId: '', cloudRegion: '', cloudResourceId: '',
  cloudApiKeyFile: '', cloudUploadConsent: false, cloudMaxAudioMiB: 25, allowInsecureLoopback: false,
  downloadTimeout: 300, asrTimeout: 3600, maxDuration: 14400 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function fixture(options = {}) {
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
      backend: { status: 'dependency_missing', missing_dependencies: ['yt-dlp', 'faster-whisper', OLD_KEY], apiKey: OLD_KEY }, message: OLD_KEY } };
    else if (action === 'setup') value = { status: 'ok', result: { status: 'setup_command_prepared', command: COMMAND, executed: false, apiKey: OLD_KEY } };
    else throw new Error('Unexpected request: no auth, provider or installation allowed');
    return { status: 200, ok: true, async json() { return value; } };
  };
  const context = { window: { fetch, navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    __DSH_DIRECTORY_PICKER__: options.desktopPicker }, React, URL, AbortController, TextEncoder, setTimeout, clearTimeout, Date };
  // Test the owned source directly: never run the client bundler or write its output.
  const settings = vm.runInNewContext(source + '\ncreateAsrSettings(React);', context, { timeout: 3000 });
  const asr = settings._testing;
  const controller = asr.createController(options.controllerOptions);
  return { controller, asr, calls, copied, effects, refs, rendered,
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

test('unloaded mode select uses a disabled empty placeholder and retains only captions/cloud options', async () => {
  for (const loading of [true, false]) {
    const f = await renderMode('captions', { loading, values: null, error: loading ? '' : '设置服务返回格式无效，未确认完成。' });
    const nodes = treeNodes(f.tree), mode = nodes.find(node => node.type === 'select');
    assert.equal(mode.props.value, ''); assert.equal(mode.props.disabled, true);
    const options = treeNodes(mode).filter(node => node.type === 'option');
    assert.deepEqual(options.map(node => node.props.value), ['', 'captions', 'cloud']);
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
  assert.equal(f.controller.update('mode', 'cloud'), false); assert.equal(await f.controller.save(), false);
  finish(); assert.equal(await pending, true);
  const ready = await renderMode('cloud', { ...f.controller.snapshot() });
  const mode = treeNodes(ready.tree).find(node => node.type === 'select');
  assert.equal(mode.props.value, 'cloud'); assert.equal(mode.props.disabled, false);
  assert.deepEqual(treeNodes(mode).filter(node => node.type === 'option').map(node => node.props.value), ['captions', 'cloud']);
  f.controller.dispose();
});

test('each loaded server mode remains selectable and persists through POST save only with CAS', async () => {
  for (const [initial, next] of [['captions', 'cloud'], ['cloud', 'captions']]) {
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

test('local/unknown modes and obsolete local ASR fields cannot enter the cloud edition draft or requests', async () => {
  const f = await fixture({ values: { localModel: 'small', localModelDir: '/legacy/model', localDevice: 'cuda', localComputeType: 'float16' } });
  await f.controller.load();
  assert.equal(f.controller.update('mode', 'local'), false); assert.equal(f.controller.update('mode', 'unknown'), false);
  for (const field of ['localModel', 'localModelDir', 'localDevice', 'localComputeType']) {
    assert.equal(field in f.asr.defaults, false); assert.equal(field in f.controller.snapshot().draft, false);
    assert.equal(f.controller.update(field, 'legacy-value'), false);
  }
  assert.equal(await f.controller.pickPath('localModelDir'), false);
  assert.equal(f.calls.length, 1); assert.equal(f.controller.snapshot().dirty, false); f.controller.dispose();
  for (const mode of ['local', 'unknown']) {
    const invalid = await fixture({ values: { mode } });
    assert.equal(await invalid.controller.load(), false); assert.equal(invalid.controller.snapshot().values, null);
    assert.equal(await invalid.controller.setup(), false); assert.equal(invalid.calls.length, 1); invalid.controller.dispose();
  }
});

test('setup in captions/cloud posts an empty request without local backend or model parameters', async () => {
  for (const mode of ['captions', 'cloud']) {
    const f = await fixture({ values: { mode } }); await f.controller.load();
    assert.equal(await f.controller.setup(), true);
    assert.equal(f.calls[1].action, 'setup'); assert.deepEqual(f.calls[1].body, {});
    assert.equal(f.controller.snapshot().command, COMMAND);
    assert.equal(/--model|'local'/.test(COMMAND), false); f.controller.dispose();
  }
});

test('failed explicit reload does not reuse a previous snapshot to unlock settings actions', async () => {
  let unavailable = false;
  const f = await fixture({ values: { mode: 'cloud' }, reply: async action => action === 'config' && unavailable
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
  await f.controller.load(); f.controller.setSecret(KEY); f.controller.update('mode', 'captions'); await f.controller.save();
  assert.equal(f.calls[1].body.secret.action, 'keep'); assert.equal(f.getSavedKey(), OLD_KEY);
  assert.equal(f.controller.snapshot().secretDraftPresent, false);
  f.controller.dispose();
});

test('unsaved edits block environment/setup calls until a successful save', async () => {
  const f = await fixture(); await f.controller.load(); f.controller.update('mode', 'cloud');
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
  const f = await fixture({ values: { mode: 'cloud' } }); await f.controller.load(); await f.controller.check();
  assert.equal(f.controller.snapshot().result.label, '缺少依赖');
  assert.deepEqual(Array.from(f.controller.snapshot().result.missing), ['yt-dlp']);
  assert.equal(JSON.stringify(f.controller.snapshot()).includes(OLD_KEY), false);
  assert.equal(f.calls.length, 2); f.controller.dispose();
});

async function checkedSummary(raw, mode = 'captions') {
  const f = await fixture({ values: { mode, cloudUploadConsent: true }, savedKey: OLD_KEY,
    reply: async action => action === 'status' ? ok({ status: 'ok', result: raw }) : undefined });
  assert.equal(await f.controller.load(), true);
  assert.equal(await f.controller.check(), true);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'status']);
  assert.equal(f.calls[1].request.method, 'POST'); assert.deepEqual(f.calls[1].body, {});
  assert.equal(f.getSavedKey(), OLD_KEY); assert.equal(f.controller.snapshot().draft.cloudUploadConsent, true);
  return f;
}

function rejectDiagnostics(raw) {
  for (const name of ['message', 'warnings', 'cloudApiKey']) Object.defineProperty(raw, name, {
    get() { throw new Error('raw diagnostics and credentials must not be read'); },
  });
  return raw;
}

test('captions reports both missing dependencies with their own purpose and an existing backend Python', async () => {
  const f = await checkedSummary(rejectDiagnostics({ status: 'ok', mode: 'captions', backend: rejectDiagnostics({
    status: 'dependency_missing', python_executable: 'C:/Python/python.exe',
    missing_dependencies: ['yt-dlp', 'python-docx', OLD_KEY, 'UNTRUSTED-DEPENDENCY', '__proto__', null, {},
      { toString() { throw new Error('must not coerce dependency'); } }],
  }) }));
  const result = f.controller.snapshot().result;
  assert.equal(result.label, '缺少依赖'); assert.equal(result.ready, false);
  assert.deepEqual(Array.from(result.missing), ['yt-dlp', 'python-docx']);
  assert.equal(result.python, 'C:/Python/python.exe');
  assert.ok(result.lines.includes('找到 Python：C:/Python/python.exe'));
  assert.ok(result.lines.includes('缺少：yt-dlp（YouTube 字幕）、python-docx（Word 导出）'));
  assert.match(result.next, /一键准备\/修复运行环境/);
  const rendered = await renderMode('captions', { ...f.controller.snapshot() }); const text = JSON.stringify(rendered.tree);
  for (const hidden of ['没有找到可用的 Python', 'UNTRUSTED-DEPENDENCY', '__proto__', OLD_KEY])
    assert.equal(text.includes(hidden), false, hidden);
  assert.equal(text.includes('python-docx（YouTube 字幕）'), false); f.controller.dispose();
});

test('captions missing only Word export stays unready and never mislabels it as YouTube or missing Python', async () => {
  const f = await checkedSummary(rejectDiagnostics({ status: 'ok', mode: 'captions', backend: rejectDiagnostics({
    status: 'dependency_missing', python_executable: '/state/venv/bin/python',
    missing_dependencies: ['python-docx', OLD_KEY, 'UNTRUSTED-DEPENDENCY', '<script>bad</script>', [], false],
  }) }));
  const result = f.controller.snapshot().result;
  assert.equal(result.label, '缺少依赖'); assert.equal(result.ready, false);
  assert.deepEqual(Array.from(result.missing), ['python-docx']);
  assert.ok(result.lines.includes('找到 Python：/state/venv/bin/python'));
  assert.ok(result.lines.includes('缺少：python-docx（Word 导出）'));
  assert.match(result.next, /一键准备\/修复运行环境/);
  const rendered = await renderMode('captions', { ...f.controller.snapshot() }); const text = JSON.stringify(rendered.tree);
  for (const hidden of ['没有找到可用的 Python', 'yt-dlp（', 'python-docx（YouTube 字幕）',
    'UNTRUSTED-DEPENDENCY', '<script>', OLD_KEY]) assert.equal(text.includes(hidden), false, hidden);
  f.controller.dispose();
});

test('captions checks use top-level ok when backend status is missing or not a string', async () => {
  for (const backend of [undefined, null, false, 42, 'untrusted', [], {},
    { status: null }, { status: false }, { status: 0 }, { status: [] },
    { status: { toString() { throw new Error('must not coerce status'); } } }]) {
    const raw = rejectDiagnostics({ status: 'ok', mode: 'captions', backend });
    const f = await checkedSummary(raw);
    const result = f.controller.snapshot().result;
    assert.equal(result.label, '环境可用'); assert.equal(result.ready, true); assert.equal(result.next, '');
    assert.match(result.lines.join(' '), /离线环境检查通过/);
    assert.match(result.lines.join(' '), /未验证 API Key、云服务连通性或实际转写/);
    assert.equal(JSON.stringify(result).includes('可以直接提取字幕、导出 Word'), false);
    f.controller.dispose();
  }
});

test('cloud string backend statuses take precedence and unknown strings safely refuse readiness', async () => {
  for (const [top, status, label, ready] of [
    ['ok', 'dependency_missing', '缺少依赖', false], ['dependency_missing', 'ok', '环境可用', true],
    ['ok', 'invalid_api_key', 'Key不符合安全请求头格式', false],
    ['ok', 'unsupported_model', '该协议不支持此模型或能力；请核对服务文档，不由厂商名称决定', false],
    ...['', 'UNTRUSTED-STATUS', '<script>bad</script>', '__proto__', 'constructor', 'toString'].map(status =>
      ['ok', status, '尚未验证运行环境', false]),
  ]) {
    const f = await checkedSummary(rejectDiagnostics({ status: top,
      backend: rejectDiagnostics({ status, missing_dependencies: ['yt-dlp', OLD_KEY] }) }), 'cloud');
    const result = f.controller.snapshot().result;
    assert.equal(result.label, label); assert.equal(result.ready, ready);
    assert.equal(JSON.stringify(result).includes(OLD_KEY), false);
    assert.equal(JSON.stringify(result).includes('UNTRUSTED-STATUS'), false);
    assert.equal(JSON.stringify(result).includes('<script>'), false);
    f.controller.dispose();
  }
});

test('missing unknown and malformed top-level status values fall back without coercion or raw diagnostics', async () => {
  for (const status of [undefined, null, false, 0, [], {}, 'UNTRUSTED-STATUS', '__proto__', 'constructor',
    { toString() { throw new Error('must not coerce status'); } }]) {
    const f = await checkedSummary(rejectDiagnostics({ status, backend: rejectDiagnostics({}) }));
    const result = f.controller.snapshot().result;
    assert.equal(result.label, '尚未验证运行环境'); assert.equal(result.ready, false);
    assert.equal(JSON.stringify(result).includes('UNTRUSTED-STATUS'), false);
    assert.equal(f.controller.snapshot().error, ''); f.controller.dispose();
  }
});

test('malformed summary payloads fail closed with only a static format error', async () => {
  for (const result of [undefined, null, false, 42, 'UNTRUSTED-RESULT', [], ['ok']]) {
    const f = await fixture({ reply: async action => action === 'status' ? ok({ status: 'ok', result }) : undefined });
    await f.controller.load(); assert.equal(await f.controller.check(), false);
    assert.equal(f.controller.snapshot().result, null);
    assert.equal(f.controller.snapshot().error, '设置服务返回格式无效，未确认完成。');
    assert.deepEqual(f.calls.map(call => call.action), ['config', 'status']);
    assert.equal(JSON.stringify(f.controller.snapshot()).includes('UNTRUSTED-RESULT'), false); f.controller.dispose();
  }
});

test('successful offline checks render the verification boundary without reading diagnostic or credential getters', async () => {
  for (const mode of ['captions', 'cloud']) {
    const f = await checkedSummary(rejectDiagnostics({ status: 'ok',
      python_executable: 'C:/Python/python.exe', backend: rejectDiagnostics({ status: 'ok' }) }), mode);
    const rendered = await renderMode(mode, { ...f.controller.snapshot() });
    const text = JSON.stringify(rendered.tree);
    assert.match(text, /环境可用/); assert.match(text, /离线环境检查通过/);
    assert.match(text, /未验证 API Key、云服务连通性或实际转写/);
    assert.match(text, /C:\/Python\/python.exe/);
    assert.equal(text.includes(OLD_KEY), false); assert.equal(text.includes(KEY), false);
    assert.deepEqual(treeNodes(rendered.tree).find(node => node.type === 'select').children.flat()
      .filter(node => node?.type === 'option').map(node => node.props.value), ['captions', 'cloud']);
    for (const field of ['ffmpegPath', 'localModel', 'localModelDir']) {
      assert.equal(field in f.asr.defaults, false); assert.equal(f.controller.update(field, '/not-added'), false);
    }
    f.controller.dispose();
  }
});

test('CAS409 forces explicit reload rather than silently retrying or merging stale values', async () => {
  let conflict = true;
  const f = await fixture({ reply: async (action, method) => action === 'save' && method === 'POST' && conflict
    ? response(409, 'settings_conflict') : undefined });
  await f.controller.load(); f.controller.update('mode', 'cloud'); f.controller.setSecret(KEY);
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
  for (const name of ['服务名称（自定义）', '接口协议', 'API地址', '模型 / 引擎参数', '服务默认']) assert.match(visible, new RegExp(name));
  f.controller.dispose();
});

test('manual cloud fields remain editable without any preset selector, data or apply API', async () => {
  const f = await fixture({ values: { mode: 'cloud' }, savedKey: OLD_KEY });
  await f.controller.load();
  assert.equal(f.controller.applyPreset, undefined);
  assert.equal(/\bpresets\b|applyPreset|siliconflow|qwenFiletrans|api\.groq\.com|SenseVoiceSmall/.test(source), false);
  f.controller.update('cloudProviderName', '我的自定义服务');
  f.controller.update('cloudProtocol', 'openai');
  f.controller.update('cloudEndpoint', 'https://gateway.example.test/any/path');
  f.controller.update('cloudModel', '未来的自定义模型');
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.snapshot().draft.cloudUploadConsent, false);
  assert.equal(await f.controller.save(), true);
  assert.equal(f.calls[1].body.secret.action, 'keep'); assert.equal(f.getSavedKey(), OLD_KEY);
  assert.deepEqual(f.calls[1].body.patch, { cloudProviderName: '我的自定义服务', cloudProtocol: 'openai',
    cloudEndpoint: 'https://gateway.example.test/any/path', cloudModel: '未来的自定义模型' });
  f.controller.dispose();
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

test('captions and cloud render only their relevant basic fields; advanced remains collapsed', async () => {
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
  for (const f of [captions, cloud]) {
    const text = JSON.stringify(f.tree);
    const mode = treeNodes(f.tree).find(node => node.type === 'select');
    assert.deepEqual(treeNodes(mode).filter(node => node.type === 'option').map(node => node.props.value), ['captions', 'cloud']);
    for (const removed of ['快捷填入（可选，不会自动保存）', '选择预设或自定义', '服务名称、完整URL和模型均可自定义',
      '服务只返回正文时', '切换目标/协议/凭据标识', '本机ASR', '模型目录', 'CPU', 'CUDA', '计算类型', '选择模型文件夹', '恢复默认模型目录'])
      assert.equal(text.includes(removed), false, removed);
    for (const retained of ['Python路径', '选择Python文件夹', '恢复默认Python', '状态目录', '输出目录', '代理'])
      assert.ok(text.includes(retained), retained);
    const details = treeNodes(f.tree).find(node => node.type === 'details');
    assert.ok(details); assert.equal(details.props?.open, undefined);
  }
});

test('every manual cloud protocol retains its credential inputs without presets or the removed explanation blocks', async () => {
  for (const protocol of ['auto', 'openai', 'dashscope_paraformer', 'dashscope_qwen', 'volcengine_flash', 'tencent_rec_task']) {
    const values = { ...defaults, mode: 'cloud', cloudProtocol: protocol };
    const f = await renderMode('cloud', { draft: values, values });
    const nodes = treeNodes(f.tree), text = JSON.stringify(f.tree);
    const selects = nodes.filter(node => node.type === 'select');
    assert.equal(selects.length, protocol === 'auto' || protocol === 'openai' ? 4 : 3);
    for (const label of ['服务名称（自定义）', '接口协议', 'API地址', '模型 / 引擎参数', 'Key文件（可选）', '允许上传音频到此服务'])
      assert.ok(text.includes(label), label);
    assert.ok(nodes.some(node => node.type === 'input' && node.props.type === 'password'));
    if (protocol === 'volcengine_flash') for (const label of ['App ID（应用标识）', 'Access Token', '语音资源ID']) assert.ok(text.includes(label), label);
    if (protocol === 'tencent_rec_task') for (const label of ['SecretId（凭据标识）', 'SecretKey', '地域（可选）']) assert.ok(text.includes(label), label);
    for (const removed of ['快捷填入', '选择预设', '服务名称、完整URL和模型均可自定义', '服务只返回正文', '切换目标/协议/凭据标识']) {
      assert.equal(text.includes(removed), false, removed); assert.equal(source.includes(removed), false, removed);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('proxy examples stay display-only and explain the cloud HTTP-only boundary', async () => {
  for (const mode of ['captions', 'cloud']) {
    for (const proxy of ['', 'http://127.0.0.1:3128']) {
      const values = { ...defaults, mode, proxy }, before = JSON.stringify(values);
      const f = await renderMode(mode, { draft: values, values });
      const labels = treeNodes(f.tree).filter(node => node.type === 'label');
      const field = labels.find(node => node.children[0] === '代理（可选）');
      const input = treeNodes(field).find(node => node.type === 'input');
      assert.equal(input.props.placeholder, 'http://127.0.0.1:7897'); assert.equal(input.props.value, proxy);
      const text = JSON.stringify(f.tree);
      assert.match(text, /请改为实际代理地址和端口/); assert.match(text, /示例不会自动填入或联网/);
      if (mode === 'cloud') {
        assert.match(text, /仅支持不带账号密码的HTTP代理/);
        assert.match(text, /不支持HTTPS或SOCKS代理/);
      }
      assert.equal(JSON.stringify(values), before); assert.deepEqual(f.calls, []);
    }
  }
});

test('cloud protocol menu uses consistent service names while retaining all internal values and legacy auto', async () => {
  const f = await renderMode('cloud');
  const label = treeNodes(f.tree).find(node => node.type === 'label' && node.children[0] === '接口协议');
  const select = treeNodes(label).find(node => node.type === 'select');
  const options = treeNodes(select).filter(node => node.type === 'option');
  assert.equal(select.props.value, 'auto');
  assert.deepEqual(options.map(node => [node.props.value, node.children[0]]), [
    ['openai', '通用 / OpenAI兼容'], ['dashscope_paraformer', '阿里 / 录音文件转写'], ['dashscope_qwen', '阿里 / Qwen短音频'],
    ['volcengine_flash', '火山 / 豆包录音转写'], ['tencent_rec_task', '腾讯 / 录音文件转写'], ['auto', '旧配置兼容（非自动识别）'],
  ]);
  assert.equal(/TC3|Base64|聊天接口|自动兼容/.test(options.map(node => node.children[0]).join(' ')), false);
  assert.deepEqual(f.calls, []);
});

test('selected protocol shows matching full address and model placeholders without changing blank fields', async () => {
  for (const [protocol, endpoint, model, description] of [
    ['auto', 'https://api.openai.com/v1/audio/transcriptions', 'whisper-1', '不会智能识别服务'],
    ['openai', 'https://api.openai.com/v1/audio/transcriptions', 'whisper-1', '不是聊天接口'],
    ['dashscope_paraformer', 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', 'qwen3-asr-flash-filetrans', 'Paraformer（如paraformer-v2）及Qwen filetrans'],
    ['dashscope_qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen3-asr-flash', '不支持filetrans模型'],
    ['volcengine_flash', 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', 'bigmodel', '录音文件极速识别'],
    ['tencent_rec_task', 'https://asr.tencentcloudapi.com/', '16k_zh', '服务支持的引擎参数'],
  ]) {
    const values = { ...defaults, mode: 'cloud', cloudProtocol: protocol }, before = JSON.stringify(values);
    const f = await renderMode('cloud', { draft: values, values, secretConfigured: false });
    const nodes = treeNodes(f.tree), text = JSON.stringify(f.tree);
    const field = name => treeNodes(nodes.find(node => node.type === 'label' && node.children[0] === name)).find(node => node.type === 'input');
    assert.equal(field('API地址').props.placeholder, '示例：' + endpoint); assert.equal(field('API地址').props.value, '');
    assert.equal(field('模型 / 引擎参数').props.placeholder, '示例：' + model); assert.equal(field('模型 / 引擎参数').props.value, '');
    assert.ok(text.includes(description), description);
    assert.match(text, /不会自动填入或发起请求/); assert.match(text, /账户实际开通能力/);
    const responseFormat = nodes.find(node => node.type === 'label' && node.children[0] === '响应请求格式');
    assert.equal(!!responseFormat, protocol === 'auto' || protocol === 'openai');
    const credential = protocol === 'tencent_rec_task' ? 'SecretKey' : protocol === 'volcengine_flash' ? 'Access Token' : 'API Key';
    assert.equal(field(credential).props.placeholder, '输入 ' + credential);
    assert.equal(!!nodes.find(node => node.type === 'label' && node.children[0] === 'App ID（应用标识）'), protocol === 'volcengine_flash');
    assert.equal(!!nodes.find(node => node.type === 'label' && node.children[0] === '语音资源ID'), protocol === 'volcengine_flash');
    assert.equal(!!nodes.find(node => node.type === 'label' && node.children[0] === 'SecretId（凭据标识）'), protocol === 'tencent_rec_task');
    assert.equal(!!nodes.find(node => node.type === 'label' && node.children[0] === '地域（可选）'), protocol === 'tencent_rec_task');
    assert.equal(JSON.stringify(values), before); assert.deepEqual(f.calls, []);
  }
});

test('protocol change through the rendered menu never applies examples and still revokes upload consent', async () => {
  const f = await fixture({ values: { mode: 'cloud', cloudProtocol: 'auto', cloudEndpoint: 'https://gateway.example.test/custom/transcribe',
    cloudModel: 'my-account-model', cloudAppId: 'my-app', cloudRegion: 'my-region', cloudResourceId: 'my-resource',
    cloudResponseFormat: 'json', proxy: 'http://127.0.0.1:3128', cloudUploadConsent: true }, savedKey: OLD_KEY });
  await f.controller.load();
  const initial = JSON.stringify(f.controller.snapshot().draft);
  const legacy = await renderMode('cloud', { ...f.controller.snapshot() });
  assert.equal(JSON.stringify(f.controller.snapshot().draft), initial); assert.equal(f.controller.snapshot().dirty, false);
  assert.deepEqual(f.calls.map(call => call.action), ['config']); assert.deepEqual(legacy.calls, []);
  for (const protocol of ['openai', 'dashscope_paraformer', 'dashscope_qwen', 'volcengine_flash', 'tencent_rec_task']) {
    f.controller.update('cloudUploadConsent', true); f.controller.setSecret(KEY);
    const previous = { ...f.controller.snapshot().draft };
    const rendered = await renderMode('cloud', { ...f.controller.snapshot() }); rendered.componentRef.current = f.controller;
    const label = treeNodes(rendered.tree).find(node => node.type === 'label' && node.children[0] === '接口协议');
    treeNodes(label).find(node => node.type === 'select').props.onChange({ currentTarget: { value: protocol } });
    const state = f.controller.snapshot();
    assert.deepEqual({ ...state.draft }, { ...previous, cloudProtocol: protocol, cloudUploadConsent: false });
    assert.equal(state.secretAction, 'keep'); assert.equal(state.secretDraftPresent, false);
    assert.equal(f.getSavedKey(), OLD_KEY); assert.equal(JSON.stringify(state).includes(KEY), false);
    assert.deepEqual(f.calls.map(call => call.action), ['config']);
  }
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(f.calls.at(-1).body.patch, { cloudProtocol: 'tencent_rec_task', cloudUploadConsent: false });
  assert.deepEqual(f.calls.at(-1).body.secret, { action: 'keep' }); assert.equal(f.getSavedKey(), OLD_KEY);
  f.controller.dispose();
});

test('filetrans protocol mismatch gives a safe selection hint instead of suggesting runtime installation', async () => {
  const f = await checkedSummary(rejectDiagnostics({ status: 'ok', backend: rejectDiagnostics({ status: 'protocol_model_mismatch' }) }), 'cloud');
  const result = f.controller.snapshot().result;
  assert.match(result.label, /filetrans模型请选择“阿里 \/ 录音文件转写”/);
  assert.equal(result.ready, false); assert.equal(result.next, '');
  assert.equal(JSON.stringify(result).includes(OLD_KEY), false); f.controller.dispose();
});

test('dirty form disables environment/setup UI buttons but preserves save and reload', async () => {
  const f = await renderMode('cloud', { dirty: true });
  const buttons = treeNodes(f.tree).filter(node => node.type === 'button');
  const named = name => buttons.find(node => node.children[0] === name);
  assert.equal(named('检查环境').props.disabled, true); assert.equal(named('生成部署命令').props.disabled, true);
  assert.equal(named('一键准备/修复运行环境').props.disabled, true);
  assert.equal(named('保存设置').props.disabled, false);
});

function ok(value) { return { status: 200, ok: true, async json() { return value; } }; }

test('picker posts only allowed field, fills draft only, and preserves unrelated draft, Key and upload authorization', async () => {
  const paths = { pythonPath: 'C:\\Python 3\\python.exe' };
  const f = await fixture({ values: { mode: 'cloud', cloudUploadConsent: true }, savedKey: OLD_KEY,
    reply: async (action, method, body) => action === 'pick-path' ? ok({ status: 'ok', cancelled: false, path: paths[body.field], message: OLD_KEY }) : undefined });
  await f.controller.load(); f.controller.update('cloudModel', 'unsaved-model'); f.controller.setSecret(KEY);
  assert.equal(await f.controller.pickPath('cloudApiKeyFile'), false);
  assert.equal(await f.controller.pickPath('__proto__'), false);
  assert.equal(await f.controller.pickPath('localModelDir'), false);
  for (const field of ['pythonPath']) {
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
  const f = await fixture({ values: { mode: 'cloud', pythonPath: 'C:/old/python.exe' },
    reply: async action => action === 'pick-path' ? ok({ status: 'ok', cancelled: true, path: 'C:/unwanted/python.exe', message: OLD_KEY }) : undefined });
  await f.controller.load(); f.controller.update('pythonPath', 'D:/unsaved/python.exe');
  const before = JSON.stringify(f.controller.snapshot().draft);
  assert.equal(await f.controller.pickPath('pythonPath'), false);
  assert.equal(JSON.stringify(f.controller.snapshot().draft), before); assert.equal(f.controller.snapshot().busy, false);
  assert.match(f.controller.snapshot().notice, /取消.*草稿未改变/);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'pick-path']); f.controller.dispose();
});

test('open picker locks edits and other actions, and conflicts never reopen a picker or overwrite draft', async () => {
  let finish;
  const f = await fixture({ values: { mode: 'cloud' }, reply: async action => action === 'pick-path'
    ? new Promise(resolve => { finish = () => resolve(ok({ status: 'ok', cancelled: false, path: 'D:/selected/python.exe' })); }) : undefined });
  await f.controller.load(); f.controller.update('pythonPath', 'D:/unsaved/python.exe');
  const pending = f.controller.pickPath('pythonPath'); await flush();
  assert.equal(f.controller.snapshot().busy, true);
  assert.equal(f.controller.update('pythonPath', 'C:/ignored.exe'), false);
  assert.equal(await f.controller.pickPath('pythonPath'), false); assert.equal(await f.controller.save(), false);
  assert.equal(await f.controller.setup(), false); assert.equal(await f.controller.check(), false); assert.equal(await f.controller.load(), false);
  assert.equal(f.calls.length, 2); finish(); assert.equal(await pending, true);
  assert.equal(f.controller.snapshot().draft.pythonPath, 'D:/selected/python.exe'); f.controller.dispose();
  const stale = await fixture({ reply: async action => action === 'save' ? response(409, 'settings_conflict') : undefined });
  await stale.controller.load(); stale.controller.update('pythonPath', 'D:/keep-draft/python.exe'); await stale.controller.save();
  assert.equal(await stale.controller.pickPath('pythonPath'), false);
  assert.equal(stale.controller.snapshot().draft.pythonPath, 'D:/keep-draft/python.exe'); assert.equal(stale.calls.length, 2); stale.controller.dispose();
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

test('optional environment metadata never introduces model defaults or leaks into the saved patch', async () => {
  for (const metadata of [{ stateDir: 'C:\\状态', platform: 'win32' }, { stateDir: '/server/state', platform: 'linux' },
    { stateDir: '/server/state', platform: 'darwin' }, undefined, { stateDir: 'BAD-RAW-DEFAULT', platform: 'unknown' }]) {
    const f = await fixture({ values: { mode: 'cloud' }, localDefaults: metadata }); await f.controller.load();
    f.controller.update('stateDir', '/custom/state');
    const rendered = await renderMode('cloud', { ...f.controller.snapshot() });
    const text = JSON.stringify(rendered.tree);
    assert.match(text, /可选自定义Python安装或venv文件夹；留空优先使用已准备的托管环境，不写死版本路径/);
    for (const removed of ['BAD-RAW-DEFAULT', '/models/', '模型目录']) assert.equal(text.includes(removed), false);
    assert.equal(f.calls.length, 1);
    assert.equal('localDefaults' in f.controller.snapshot().draft, false); await f.controller.save();
    assert.deepEqual(f.calls.at(-1).body.patch, { stateDir: '/custom/state' }); f.controller.dispose();
  }
});

test('environment settings keep only short Python hints and no model deployment guide', async () => {
  const f = await renderMode('cloud'); const nodes = treeNodes(f.tree); const text = JSON.stringify(f.tree);
  for (const phrase of ['选择Python文件夹…', '可选自定义Python安装或venv文件夹；留空优先使用已准备的托管环境，不写死版本路径'])
    assert.ok(text.includes(phrase), phrase);
  for (const phrase of ['初次部署推荐', '服务端本机路径', '不会安装到显式Python路径或模型目录', '不保证CUDA', 'forceAsr:true'])
    assert.equal(text.includes(phrase), false, phrase);
  assert.equal(nodes.filter(node => node.type === 'input').some(node => node.props.type === 'file'), false);
  assert.equal(nodes.some(node => node.type === 'ol'), false);
  assert.deepEqual(f.calls, []);
  for (const state of [{ busy: true }, { conflict: true }, { loading: true }, { values: null }]) {
    const locked = await renderMode('cloud', state);
    for (const node of treeNodes(locked.tree).filter(node => node.type === 'button' && /选择.*文件夹|恢复默认/.test(node.children[0])))
      assert.equal(node.props.disabled, true);
  }
});

test('Python picker/reset buttons change only the environment draft in both supported modes', async () => {
  for (const mode of ['captions', 'cloud']) {
    const f = await fixture({ values: { mode },
      reply: async action => action === 'pick-path' ? ok({ status: 'ok', cancelled: false, path: '/chosen/bin/python' }) : undefined });
    await f.controller.load(); const rendered = await renderMode(mode, { ...f.controller.snapshot() }); rendered.componentRef.current = f.controller;
    const nodes = treeNodes(rendered.tree), named = name => nodes.find(node => node.type === 'button' && node.children[0] === name);
    named('选择Python文件夹…').props.onClick(); await flush();
    assert.equal(f.controller.snapshot().draft.pythonPath, '/chosen/bin/python');
    named('恢复默认Python').props.onClick();
    assert.equal(f.controller.snapshot().draft.pythonPath, '');
    assert.deepEqual(f.calls.map(call => call.action), ['config', 'pick-path']);
    assert.equal(nodes.some(node => node.type === 'option' && ['cpu', 'cuda', 'int8', 'float16'].includes(node.props.value)), false);
    f.controller.dispose();
  }
});

test('offline status displays only known absolute resolved paths and safe next steps, never unknown diagnostics', async () => {
  for (const bad of [false, true]) {
    const f = await fixture({ values: { mode: 'cloud' }, reply: async action => action === 'status' ? ok({ status: 'ok', result: {
      python_executable: bad ? 'https://secret.test/' + OLD_KEY : '/state/venv/bin/python', message: OLD_KEY,
      backend: { status: 'dependency_missing', resolved_model_dir: bad ? 'C:/bad\n' + OLD_KEY : '/state/models/small', unknown: OLD_KEY }
    } }) : undefined });
    await f.controller.load(); await f.controller.check();
    const result = f.controller.snapshot().result;
    assert.equal(result.python, bad ? '' : '/state/venv/bin/python'); assert.equal('modelDir' in result, false);
    assert.match(result.next, /一键准备\/修复运行环境/);
    assert.equal(/生成部署命令|模型|faster-whisper|CUDA/.test(JSON.stringify(result)), false);
    const rendered = await renderMode('cloud', { ...f.controller.snapshot() });
    assert.equal(JSON.stringify(rendered.tree).includes(OLD_KEY), false);
    if (!bad) assert.match(JSON.stringify(rendered.tree), /找到 Python/);
    assert.equal(JSON.stringify(rendered.tree).includes('检查解析的模型目录'), false);
    f.controller.dispose();
  }
});

test('desktop picker is invoked synchronously from the click and only resolves the chosen directory on the backend', async () => {
  let invoked = 0, finish;
  const f = await fixture({ values: { mode: 'cloud' }, desktopPicker: { pick(...args) {
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
    const f = await fixture({ values: { mode: 'cloud', pythonPath: 'C:/keep/python.exe' }, desktopPicker: { async pick() {
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
  const f = await fixture({ values: { mode: 'cloud', pythonPath: '/keep/python' }, desktopPicker: { pick() {
    invoked++; return new Promise(resolve => { finish = resolve; });
  } } });
  await f.controller.load(); const pending = f.controller.pickPath('pythonPath');
  assert.equal(f.controller.cancelPick(), true); assert.equal(await pending, false);
  assert.equal(f.controller.snapshot().busy, false); assert.equal(f.controller.snapshot().picking, '');
  assert.match(f.controller.snapshot().notice, /取消/);
  assert.equal(await f.controller.pickPath('pythonPath'), false); assert.equal(invoked, 1);
  assert.match(f.controller.snapshot().error, /完成或取消/);
  finish('/late/python'); await flush();
  assert.equal(f.controller.snapshot().draft.pythonPath, '/keep/python');
  assert.deepEqual(f.calls.map(call => call.action), ['config']); f.controller.dispose();
});

test('picker timeout releases UI even if the desktop IPC never settles and shows the error by its field', async () => {
  const timers = [];
  const f = await fixture({ values: { mode: 'cloud' }, desktopPicker: { pick: () => new Promise(() => {}) },
    controllerOptions: { setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeout() {} } });
  await f.controller.load(); const pending = f.controller.pickPath('pythonPath');
  const active = await renderMode('cloud', { ...f.controller.snapshot() }); active.componentRef.current = f.controller;
  const nodes = treeNodes(active.tree);
  assert.ok(nodes.some(node => node.type === 'button' && node.children[0] === '正在打开…'));
  assert.equal(nodes.find(node => node.type === 'button' && node.children[0] === '取消选择').props.disabled, false);
  assert.ok(nodes.some(node => node.props?.role === 'status' && JSON.stringify(node).includes('正在打开')));
  timers.at(-1).fn(); assert.equal(await pending, false); assert.equal(f.controller.snapshot().busy, false);
  const failed = await renderMode('cloud', { ...f.controller.snapshot() });
  assert.ok(treeNodes(failed.tree).some(node => node.props?.role === 'alert' && JSON.stringify(node).includes('超时')));
  assert.deepEqual(f.calls.map(call => call.action), ['config']); f.controller.dispose();
});

test('legacy install response still accepts a backend-provided managed venv path', async () => {
  const timers = [];
  let polls = 0;
  const f = await fixture({ values: { mode: 'cloud' }, reply: async action => {
    if (action === 'setup-install') return ok({ status: 'ok', result: { status: 'setup_running', running: true,
      python_path: 'C:/state/venv/Scripts/python.exe', state_dir: 'C:/state' } });
    if (action === 'setup-install-status') {
      polls += 1;
      if (polls < 2) return ok({ status: 'ok', result: { status: 'setup_running', running: true } });
      return ok({ status: 'ok', result: { status: 'prepared', running: false,
        python_path: 'C:/state/venv/Scripts/python.exe', dependencies: { ytDlp: true, docx: true },
        python_path_saved: true, config: { status: 'ok', revision: 5,
          values: { ...defaults, pythonPath: 'C:/state/venv/Scripts/python.exe' }, secretConfigured: false } } });
    }
  }, controllerOptions: { setTimeout(fn) { const timer = { fn }; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } } });
  await f.controller.load();
  const pending = f.controller.install();
  for (let step = 0; step < 12; step++) {
    await flush();
    const due = timers.splice(0);
    if (!due.length) break;
    due.forEach(timer => timer.fn());
  }
  assert.equal(await pending, true);
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.busy, false); assert.equal(snapshot.install.status, 'prepared');
  assert.equal(snapshot.install.label, '运行环境已就绪');
  assert.equal(snapshot.install.python, 'C:/state/venv/Scripts/python.exe');
  assert.equal(snapshot.install.dependencies.ytDlp, true);
  assert.equal(snapshot.install.dependencies.docx, true);
  assert.equal(snapshot.values.pythonPath, 'C:/state/venv/Scripts/python.exe');
  assert.equal(snapshot.revision, 5); assert.equal(snapshot.dirty, false);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'setup-install', 'setup-install-status', 'setup-install-status']);
  assert.equal(f.calls[1].request.method, 'POST');
  assert.equal(f.calls[2].request.method, 'GET');
  assert.equal(JSON.stringify(snapshot).includes(KEY), false);
  f.controller.dispose();
});

test('installation progress renders once and a new phase replaces the previous line without logs', async () => {
  const timers = [];
  const phases = ['正在创建隔离环境（已用 2 秒）', '正在安装字幕依赖（已用 4 秒）'];
  let polls = 0;
  const f = await fixture({ reply: async action => {
    if (action === 'setup-install') return ok({ status: 'ok', result: { status: 'setup_running', progress: phases[0] } });
    if (action === 'setup-install-status') {
      polls++;
      return ok({ status: 'ok', result: polls === 1 ? { status: 'setup_running', progress: phases[1] }
        : { status: 'prepared', running: false } });
    }
  }, controllerOptions: {
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  } });
  await f.controller.load(); const pending = f.controller.install(); await flush();
  for (let index = 0; index < phases.length; index++) {
    const state = f.controller.snapshot(); assert.equal(state.busy, true);
    assert.equal(state.notice, phases[index]); assert.equal(state.install.progress, phases[index]);
    const rendered = await renderMode('captions', { ...state }); const text = JSON.stringify(rendered.tree);
    assert.equal(text.split(phases[index]).length - 1, 1);
    assert.equal(text.includes(phases[1 - index]), false);
    assert.equal(treeNodes(rendered.tree).filter(node => node.props?.['aria-live'] === 'polite').length, 1);
    const due = timers.findIndex(timer => timer.delay === 2000);
    assert.notEqual(due, -1); timers.splice(due, 1)[0].fn(); await flush();
  }
  assert.equal(await pending, true);
  const rendered = await renderMode('captions', { ...f.controller.snapshot() }); const text = JSON.stringify(rendered.tree);
  assert.equal(text.split('运行环境已就绪').length - 1, 1);
  for (const phase of phases) assert.equal(text.includes(phase), false);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'setup-install', 'setup-install-status', 'setup-install-status']);
  assert.deepEqual(f.calls[1].body, {}); f.controller.dispose();
});

test('install surfaces a configured custom interpreter without pretending it prepared anything', async () => {
  const f = await fixture({ values: { mode: 'cloud', pythonPath: 'C:/Other/python.exe' },
    reply: async action => action === 'setup-install' ? ok({ status: 'ok', result: { status: 'custom_python_configured',
      running: false, message: '已配置自定义 Python；一键准备只创建插件托管环境。' } }) : undefined });
  await f.controller.load();
  assert.equal(await f.controller.install(), true);
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.install.status, 'custom_python_configured');
  assert.match(snapshot.notice, /自定义 Python/);
  assert.equal(JSON.stringify(snapshot).includes('已就绪'), false);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'setup-install']);
  f.controller.dispose();
});

test('managed runtime preparation displays resolved Python but keeps the saved path empty and dependencies API unchanged', async () => {
  const python = 'C:/state/runtimes/cpython-fixed-win-x64-unique/python.exe';
  const f = await fixture({ reply: async action => action === 'setup-install' ? ok({ status: 'ok', result: {
    status: 'prepared', running: false, runtime_managed: true, python_path: python,
    dependencies: { ytDlp: true, docx: true },
    config: { status: 'ok', revision: 4, values: { ...defaults }, secretConfigured: false },
  } }) : undefined });
  await f.controller.load(); assert.equal(await f.controller.install(), true);
  const state = f.controller.snapshot();
  assert.equal(state.install.python, python); assert.equal(state.draft.pythonPath, '');
  assert.equal(state.values.pythonPath, ''); assert.equal(state.dirty, false);
  assert.equal(state.install.dependencies.ytDlp, true); assert.equal(state.install.dependencies.docx, true);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'setup-install']);
  const rendered = await renderMode('captions', { ...state }); const text = JSON.stringify(rendered.tree);
  for (const phrase of ['一键准备/修复运行环境', '仅点击准备/修复才联网下载', '不用系统Python或pip',
    '其他系统需已有Python 3.10+', '失败保留旧环境', '不自动更新', '高级系统Python方案']) assert.ok(text.includes(phrase), phrase);
  assert.ok(text.includes(python)); f.controller.dispose();
});

test('repair failures keep the saved interpreter and settings, do not retry or invent new status fields', async () => {
  for (const status of ['setup_failed', 'setup_timeout', 'setup_cancelled', 'setup_incomplete']) {
    const f = await fixture({ values: { pythonPath: 'C:/state/venv/Scripts/python.exe' },
      reply: async action => action === 'setup-install' ? ok({ status: 'ok', result: { status, running: false,
        dependencies: { ytDlp: false, docx: false } } }) : undefined });
    await f.controller.load(); const before = JSON.stringify(f.controller.snapshot().values);
    assert.equal(await f.controller.install(), true); await flush();
    const state = f.controller.snapshot();
    assert.equal(JSON.stringify(state.values), before); assert.equal(state.dirty, false);
    assert.equal(state.busy, false); assert.equal(state.install.status, status);
    assert.match(state.notice, /手动重试/);
    assert.deepEqual(f.calls.map(call => call.action), ['config', 'setup-install']);
    const rendered = await renderMode('captions', { ...state });
    const button = treeNodes(rendered.tree).find(node => node.type === 'button' && node.children[0] === '一键准备/修复运行环境');
    assert.equal(button.props.disabled, false); f.controller.dispose();
  }
});

test('non-dependency configuration errors do not misleadingly recommend installing a runtime', async () => {
  const f = await checkedSummary({ status: 'ok', backend: { status: 'invalid_api_key' } }, 'cloud');
  assert.equal(f.controller.snapshot().result.next, ''); f.controller.dispose();
});

test('component mount loads only config, and effect cleanup/StrictMode does not retain old controllers', async () => {
  const f = await fixture(); f.asr.Component();
  let cleanup = f.effects[0](); await flush();
  assert.deepEqual(f.calls.map(call => call.action), ['config']);
  const first = f.refs[0].current; cleanup(); cleanup = f.effects[0](); await flush();
  assert.notEqual(f.refs[0].current, first);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'config']); cleanup();
});
