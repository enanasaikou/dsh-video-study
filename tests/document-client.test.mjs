import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildClient } from '../client/build.mjs';

const KEY = 'PRIVATE-KEY-DO-NOT-READ-OR-RENDER';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children || []).flatMap(nodes)];
}
// Small persistent fake React renderer. Hidden DOM branches retain their component
// hook storage; removing a branch runs cleanup, as a real unmount would.
function fakeReact() {
  const instances = new Map(); let current, hookIndex, touched, pendingEffects;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useRef(initial) { const index = hookIndex++; return current.hooks[index] ||= { current: initial }; },
    useState(initial) {
      const owner = current, index = hookIndex++;
      if (!(index in owner.hooks)) owner.hooks[index] = initial;
      return [owner.hooks[index], value => { owner.hooks[index] = typeof value === 'function' ? value(owner.hooks[index]) : value; }];
    },
    useEffect(effect) { const index = hookIndex++;
      if (!(index in current.hooks)) { current.hooks[index] = true; pendingEffects.push({ owner: current, index, effect }); } },
  };
  function visit(value, path) {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, path + '/' + (item?.props?.key || index)));
    if (!value || typeof value !== 'object') return value;
    if (typeof value.type === 'function') {
      const instance = instances.get(path) || { hooks: [], cleanups: [] };
      instances.set(path, instance); touched.add(path); current = instance; hookIndex = 0;
      return visit(value.type(value.props), path + '/component');
    }
    const result = { ...value, children: value.children.map((item, index) => visit(item, path + '/' + index)) };
    if (typeof value.props.ref === 'function') value.props.ref({ focus() { result.focused = true; } });
    return result;
  }
  return { React, render(Component) {
    touched = new Set(); pendingEffects = [];
    const tree = visit(React.createElement(Component), 'root');
    for (const [path, instance] of instances) if (!touched.has(path)) {
      instance.cleanups.forEach(cleanup => cleanup?.()); instances.delete(path);
    }
    for (const { owner, index, effect } of pendingEffects) owner.cleanups[index] = effect();
    return tree;
  }, dispose() { for (const instance of instances.values()) instance.cleanups.forEach(cleanup => cleanup?.()); instances.clear(); } };
}
async function fixture(options = {}) {
  const calls = [], fake = fakeReact();
  let registration, revision = 4, values = { documentOutputDir: '', documentFormat: 'docx', cloudUploadConsent: true, mode: 'cloud', ...options.values };
  let savedKey = KEY;
  function snapshot() {
    const raw = { ...values };
    // A document controller must not even inspect unrelated credential fields.
    Object.defineProperty(raw, 'cloudApiKey', { get() { throw new Error('KEY READ'); } });
    const result = { status: 'ok', revision, values: raw, secretConfigured: !!savedKey };
    Object.defineProperty(result, 'cloudApiKey', { get() { throw new Error('KEY READ'); } });
    return result;
  }
  const fetch = async (url, request) => {
    const action = url.split('/').at(-1), body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ url, request, action, body });
    if (options.reply) {
      const custom = await options.reply(action, request, body, { snapshot });
      if (custom) return custom;
    }
    if (url.startsWith('api/video-study/auth/')) {
      assert.equal(action, 'status');
      return { status: 200, ok: true, async json() { return { status: 'ok', loginStatus: 'anonymous' }; } };
    }
    let result;
    if (action === 'config') { assert.equal(request.method, 'GET'); result = snapshot(); }
    else if (action === 'save') {
      assert.equal(request.method, 'POST');
      if (body.revision !== revision) return { status: 409, ok: false, async json() { return { status: 'error', code: 'settings_conflict' }; } };
      values = { ...values, ...body.patch };
      if (body.secret?.action === 'set') savedKey = body.secret.value;
      else if (body.secret?.action === 'clear') savedKey = '';
      revision++;
      options.afterSave?.({ body, change(patch) { values = { ...values, ...patch }; revision++; } });
      result = snapshot();
    } else throw new Error('No provider/status/setup/export/install allowed');
    return { status: 200, ok: true, async json() { return result; } };
  };
  const source = await buildClient({ write: false });
  vm.runInNewContext(source, { window: { fetch, __ModuleLoader__: { load(module) { registration = module; } } },
    URL, AbortController, TextEncoder, Date, setTimeout, clearTimeout }, { timeout: 3000 });
  const exports = registration.factory(name => { assert.equal(name, 'react'); return options.React || fake.React; });
  return { exports, documents: exports._testing.documents, asr: exports._testing.asr, calls, fake,
    readSaved: () => ({ ...values, revision, savedKey }), externalChange(patch) { values = { ...values, ...patch }; revision++; } };
}

test('document controller GET defaults are isolated; POST only patches directory/format with revision and no secret', async () => {
  const f = await fixture(), controller = f.documents.createController();
  await controller.load();
  assert.equal(controller.snapshot().draft.documentOutputDir, '');
  assert.equal(controller.snapshot().draft.documentFormat, 'docx');
  assert.deepEqual(Object.keys(controller.snapshot().values).sort(), ['documentFormat', 'documentOutputDir']);
  assert.deepEqual(Object.keys(f.documents.defaults).sort(), ['documentFormat', 'documentOutputDir']);
  for (const key of ['documentOutputDir', 'documentFormat']) assert.equal(key in f.asr.defaults, false);
  for (const key of ['cloudApiKey', 'cloudUploadConsent', 'mode', 'pythonPath', '__proto__']) assert.equal(controller.update(key, KEY), false);
  const directory = 'D:\\课程讲义\\线性代数';
  controller.update('documentOutputDir', directory); controller.update('documentFormat', 'md');
  assert.equal(await controller.save(), true);
  assert.deepEqual(f.calls.map(call => call.url), ['api/video-study/asr/config', 'api/video-study/asr/save']);
  assert.deepEqual(f.calls[1].body, { revision: 4, patch: { documentOutputDir: directory, documentFormat: 'md' } });
  assert.equal(f.calls[1].request.headers['Content-Type'], 'application/json');
  for (const { request } of f.calls) {
    assert.equal(request.credentials, 'same-origin'); assert.equal(request.mode, 'same-origin');
    assert.equal(request.redirect, 'error'); assert.equal(request.cache, 'no-store');
  }
  assert.equal(f.readSaved().savedKey, KEY); assert.equal(f.readSaved().cloudUploadConsent, true);
  assert.equal(JSON.stringify(controller.snapshot()).includes(KEY), false);
  assert.equal('secretConfigured' in controller.snapshot(), false);
  assert.equal(controller.snapshot().dirty, false); controller.dispose();
});

test('all formats and empty default directory save exactly, without frontend path rewriting or implicit actions', async () => {
  const f = await fixture({ values: { documentOutputDir: '/srv/course notes' } }), c = f.documents.createController();
  await c.load();
  assert.equal(c.update('documentFormat', 'pdf'), false);
  for (const format of ['md', 'txt', 'docx']) { c.update('documentFormat', format); assert.equal(await c.save(), true); }
  c.update('documentOutputDir', ''); assert.equal(await c.save(), true);
  assert.deepEqual(f.calls.at(-1).body.patch, { documentOutputDir: '' });
  assert.equal(f.calls.some(call => !['config', 'save'].includes(call.action)), false); c.dispose();
});

test('same-page ASR/document saves advance only disjoint confirmed revisions and retain both drafts and saved key/consent', async () => {
  const f = await fixture(), document = f.documents.createController(), asr = f.asr.createController();
  await document.load(); await asr.load();
  asr.update('cloudModel', 'edited-model'); asr.setSecret('UNSAVED-SECRET');
  const secretEpoch = asr.snapshot().secretEpoch;
  document.update('documentOutputDir', 'C:\\讲义');
  assert.equal(await document.save(), true);
  assert.equal(asr.snapshot().revision, 5); assert.equal(asr.snapshot().draft.cloudModel, 'edited-model');
  assert.equal(asr.snapshot().secretAction, 'set'); assert.equal(asr.snapshot().secretEpoch, secretEpoch);
  assert.equal(asr.snapshot().draft.cloudUploadConsent, true);
  document.update('documentFormat', 'txt');
  assert.equal(await asr.save(), true);
  assert.equal(document.snapshot().revision, 6); assert.equal(document.snapshot().draft.documentFormat, 'txt');
  assert.equal(document.snapshot().dirty, true);
  assert.equal(await document.save(), true);
  assert.equal(asr.snapshot().revision, 7);
  assert.equal(f.readSaved().savedKey, 'UNSAVED-SECRET'); assert.equal(f.readSaved().cloudUploadConsent, true);
  for (const call of f.calls.filter(call => call.action === 'save' && !call.body.secret)) {
    assert.equal(Object.keys(call.body.patch).every(key => ['documentOutputDir', 'documentFormat'].includes(key)), true);
    assert.equal(JSON.stringify(call.body).includes('UNSAVED-SECRET'), false);
  }
  const asrSave = f.calls.find(call => call.body?.secret);
  assert.equal('documentOutputDir' in asrSave.body.patch, false); assert.equal('documentFormat' in asrSave.body.patch, false);
  document.dispose(); asr.dispose();
});

test('true external CAS drift is not silently rebased or retried and reload requires explicit draft discard', async () => {
  const f = await fixture(), c = f.documents.createController(); await c.load();
  c.update('documentOutputDir', '/home/user/unsaved'); f.externalChange({ documentOutputDir: '/external' });
  assert.equal(await c.save(), false); assert.equal(c.snapshot().conflict, true);
  assert.equal(c.snapshot().draft.documentOutputDir, '/home/user/unsaved'); assert.match(c.snapshot().error, /草稿已保留/);
  assert.equal(c.update('documentFormat', 'md'), false); assert.equal(await c.save(), false);
  assert.equal(await c.load(), false); assert.equal(c.snapshot().reloadConfirmation, true); assert.equal(f.calls.length, 2);
  c.cancelReload(); assert.equal(c.snapshot().reloadConfirmation, false);
  assert.equal(await c.load(true), true); assert.equal(c.snapshot().draft.documentOutputDir, '/external'); c.dispose();
});

test('a sibling confirmed save cannot mask intervening external same-field changes', async () => {
  const f = await fixture(), doc = f.documents.createController(), asr = f.asr.createController();
  await doc.load(); f.externalChange({ documentFormat: 'txt' }); await asr.load();
  doc.update('documentOutputDir', '/draft'); asr.update('cloudModel', 'model'); await asr.save();
  assert.equal(doc.snapshot().revision, 4); assert.equal(await doc.save(), false); assert.equal(doc.snapshot().conflict, true);
  doc.dispose(); asr.dispose();
});

test('post-mutate external drift returned by read cannot advance a stale sibling CAS revision in either direction', async () => {
  for (const sender of ['document', 'asr']) {
    const external = sender === 'document' ? { cloudModel: 'external-model' } : { documentFormat: 'txt' };
    let once = true;
    const f = await fixture({ afterSave({ change }) { if (once) { once = false; change(external); } } });
    const doc = f.documents.createController(), asr = f.asr.createController();
    await doc.load(); await asr.load();
    doc.update('documentFormat', 'md'); asr.update('cloudModel', 'unsaved-model');
    const publisher = sender === 'document' ? doc : asr, sibling = sender === 'document' ? asr : doc;
    assert.equal(await publisher.save(), true);
    assert.equal(publisher.snapshot().revision, 6);
    assert.equal(sibling.snapshot().revision, 4);
    assert.equal(await sibling.save(), false);
    assert.equal(sibling.snapshot().conflict, true);
    for (const [key, value] of Object.entries(external)) assert.equal(f.readSaved()[key], value);
    doc.dispose(); asr.dispose();
  }
});

test('document error allowlist never renders server text, secret, arbitrary field or forged Error properties', async () => {
  for (const [status, code, field, expected] of [[400, 'invalid_input', 'documentOutputDir', /绝对路径/],
    [400, 'invalid_input', 'documentFormat', /docx/], [400, 'invalid_input', '__proto__', /格式无效/],
    [500, 'storage_error', null, /保存失败/], [500, 'UNKNOWN-' + KEY, KEY, /操作未完成/]]) {
    const f = await fixture({ reply: async action => action === 'save' ? { status, ok: false,
      async json() { return { status: 'error', code, field, message: KEY, command: KEY }; } } : undefined });
    const c = f.documents.createController(); await c.load(); c.update('documentFormat', 'md');
    assert.equal(await c.save(), false); assert.match(c.snapshot().error, expected);
    assert.equal(JSON.stringify(c.snapshot()).includes(KEY), false); assert.equal(c.snapshot().dirty, true); c.dispose();
  }
  const f = await fixture(), c = f.documents.createController({ request: async () => {
    const error = new Error(KEY); Object.defineProperty(error, 'code', { get() { throw new Error('do not read'); } }); throw error;
  } });
  assert.equal(await c.load(), false); assert.equal(JSON.stringify(c.snapshot()).includes(KEY), false); c.dispose();
});

test('host auth errors avoid parsing bodies; unknown or malformed config snapshots fail closed without retries', async () => {
  for (const status of [401, 403, 404]) {
    let read = false;
    const f = await fixture({ reply: async () => ({ status, ok: false, async json() { read = true; throw new Error(KEY); } }) });
    const c = f.documents.createController(); assert.equal(await c.load(), false); assert.equal(read, false);
    assert.match(c.snapshot().error, status === 404 ? /插件后端/ : /重新加载DSH页面/);
    assert.equal(await c.save(), false); assert.equal(f.calls.length, 1); c.dispose();
  }
  for (const change of [{ revision: '4' }, { revision: -1 }, { values: { documentFormat: 'html' } }, { values: { documentOutputDir: 42 } }]) {
    const f = await fixture({ reply: async (_action, _request, _body, { snapshot }) => ({ status: 200, ok: true,
      async json() { return { ...snapshot(), ...change }; } }) });
    const c = f.documents.createController(); assert.equal(await c.load(), false); assert.equal(c.snapshot().values, null);
    assert.equal(c.update('documentFormat', 'txt'), false); await flush(); assert.equal(f.calls.length, 1); c.dispose();
  }
});

test('tab keyboard roving tabindex, aria linkage and hidden panels remain correct without unmounting drafts', async () => {
  const f = await fixture();
  let tree = f.fake.render(f.exports._testing.VideoSettings); await flush(); tree = f.fake.render(f.exports._testing.VideoSettings);
  const tabs = () => nodes(tree).filter(node => node.props?.role === 'tab');
  const panels = () => nodes(tree).filter(node => node.props?.role === 'tabpanel');
  assert.deepEqual(tabs().map(tab => tab.children[0]), ['字幕与ASR', '文档输出', 'B站登录']);
  function check(index) {
    assert.equal(tabs().filter(tab => tab.props['aria-selected']).length, 1);
    assert.equal(tabs().filter(tab => tab.props.tabIndex === 0).length, 1);
    assert.equal(panels().filter(panel => !panel.props.hidden).length, 1);
    tabs().forEach((tab, i) => { const panel = panels()[i];
      assert.equal(tab.props['aria-selected'], i === index); assert.equal(tab.props['aria-controls'], panel.props.id);
      assert.equal(panel.props['aria-labelledby'], tab.props.id); assert.equal(panel.props.hidden, i !== index);
      assert.equal(panel.props.style.display, i === index ? 'block' : 'none');
    });
  }
  check(0); const initialCalls = f.calls.length;
  const model = nodes(tree).find(node => node.type === 'label' && node.children[0] === '模型 / 引擎参数');
  const modelInput = nodes(model).find(node => node.type === 'input');
  modelInput.props.onChange({ currentTarget: { value: 'unsaved model' } });
  const password = nodes(tree).find(node => node.type === 'input' && node.props.type === 'password');
  password.props.onChange({ currentTarget: { value: 'tab-kept-secret' } });
  let prevented = false;
  tabs()[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(tabs()[1].focused, true);
  tree = f.fake.render(f.exports._testing.VideoSettings); check(1);
  const directory = nodes(tree).find(node => node.type === 'input' && node.props['aria-describedby'] === 'video-study-document-directory-help');
  directory.props.onChange({ currentTarget: { value: 'D:\\未保存讲义' } });
  const format = nodes(tree).find(node => node.type === 'select' && node.props.value === 'docx');
  format.props.onChange({ currentTarget: { value: 'txt' } });
  for (const [key, expected] of [['End', 2], ['ArrowRight', 0], ['ArrowLeft', 2], ['Home', 0]]) {
    const selected = tabs().find(tab => tab.props['aria-selected']);
    selected.props.onKeyDown({ key, preventDefault() {} }); tree = f.fake.render(f.exports._testing.VideoSettings); check(expected);
  }
  assert.equal(nodes(tree).find(node => node.type === 'label' && node.children[0] === '模型 / 引擎参数').children[1].props.value, 'unsaved model');
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.type === 'password').props.key, password.props.key);
  assert.equal(f.calls.length, initialCalls); // No remount GETs or auto-save when switching.
  tabs()[1].props.onClick(); tree = f.fake.render(f.exports._testing.VideoSettings); check(1);
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props['aria-describedby'] === 'video-study-document-directory-help').props.value, 'D:\\未保存讲义');
  assert.ok(nodes(tree).find(node => node.type === 'select' && node.props.value === 'txt'));
  tabs()[0].props.onClick(); tree = f.fake.render(f.exports._testing.VideoSettings);
  const saveAsr = nodes(tree).find(node => node.type === 'button' && node.children[0] === '保存设置');
  saveAsr.props.onClick(); await flush();
  assert.equal(f.calls.at(-1).body.secret.value, 'tab-kept-secret');
  f.fake.dispose();
});

test('document panel clearly explains server path, reviewed body, editable formulas and manual dependency setup', async () => {
  const view = { loading: false, busy: false, values: {}, draft: { documentOutputDir: '', documentFormat: 'docx' }, dirty: false };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return { current: null }; }, useState() { return [view, () => {}]; }, useEffect() {} };
  const f = await fixture({ React }), tree = f.documents.Component(), text = JSON.stringify(tree);
  for (const phrase of ['服务端本机路径', '不是浏览器下载目录', 'Documents/DSH视频学习', 'video_study_export', '通读课程、核对公式',
    '不会把原始字幕直接当作讲义', 'OMML 可编辑公式', 'LaTeX', 'warning', '不代表公式已经核对', 'python-docx',
    '插件配置的 Python 解释器与环境', 'python -m pip install python-docx', '缺少依赖就停止', '不会自动安装', '本页不会运行命令']) assert.ok(text.includes(phrase), phrase);
  const select = nodes(tree).find(node => node.type === 'select');
  assert.deepEqual(nodes(select).filter(node => node.type === 'option').map(node => node.props.value), ['docx', 'md', 'txt']);
  assert.equal(select.props.style.color, 'inherit'); assert.equal(select.props.style.width, '100%');
  assert.equal(nodes(tree).some(node => node.type === 'input' && node.props.type === 'password'), false);
  assert.deepEqual(nodes(tree).filter(node => node.type === 'button').map(node => node.children[0]), ['保存文档设置', '重新载入']);
});

test('document effect StrictMode remount creates new live controller, cleans pending work and never installs', async () => {
  const effects = [], ref = { current: null };
  const React = { createElement(type, props, ...children) { return { type, props, children }; },
    useRef() { return ref; }, useState(value) { return [value, () => {}]; }, useEffect(effect) { effects.push(effect); } };
  const f = await fixture({ React }); f.documents.Component();
  let cleanup = effects[0](); await flush(); const first = ref.current; cleanup();
  cleanup = effects[0](); await flush(); assert.notEqual(first, ref.current);
  assert.deepEqual(f.calls.map(call => call.action), ['config', 'config']); cleanup(); assert.equal(ref.current, null);
});
