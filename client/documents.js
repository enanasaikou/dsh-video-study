/* Document settings use the owner-gated config/save API only. No file access,
 * provider requests, credential reads, uploads, dependency installs or export. */
function createDocumentSettings(React, platform) {
  'use strict';
  platform = platform || {};
  var e = React.createElement;
  var defaults = Object.freeze({ documentOutputDir: '', documentFormat: 'docx' });
  var keys = Object.keys(defaults), formats = ['docx', 'md', 'txt'], errors = new WeakMap();
  var messages = Object.freeze({
    settings_conflict: '设置已在其它位置修改；草稿已保留，请核对并重新载入后再编辑。',
    invalid_input: '文档设置格式无效，请检查目录与格式后重试。',
    invalid_settings: '文档设置值无效，请检查目录与格式后重试。',
    invalid_config: '文档配置无效，请检查目录与格式后重试。',
    settings_unavailable: '宿主设置服务不可用，请重载插件后重试。',
    settings_save_failed: '文档设置保存失败，未确认生效，请手动重试。',
    storage_error: '文档设置保存失败，未确认生效，请手动重试。',
    persistence_failed: '文档设置保存失败，未确认生效，请手动重试。',
    origin_rejected: '页面来源校验失败，请重新加载DSH页面。',
    session_reload_required: '页面会话已失效，请重新加载DSH页面。',
    backend_reload_required: '未找到文档设置接口，请重载插件后端并刷新页面。',
    timeout: '设置请求超时，未确认完成，请手动重试。',
    network_error: '无法连接插件设置服务，请检查连接后手动重试。',
    invalid_response: '设置服务返回格式无效，未确认完成。'
  });
  var fieldMessages = Object.freeze({
    documentOutputDir: '文档目录须为服务端本机绝对路径，或留空使用默认目录；不能含换行或控制字符。',
    documentFormat: '请选择 Word（docx）、Markdown（md）或纯文本（txt）。'
  });
  function fail(code, field) {
    var error = new Error('Document settings request failed');
    errors.set(error, { code: Object.prototype.hasOwnProperty.call(messages, code) ? code : 'unknown',
      field: code === 'invalid_input' && Object.prototype.hasOwnProperty.call(fieldMessages, field) ? field : null });
    return error;
  }
  function code(error) { var entry = errors.get(error); return entry && entry.code; }
  function errorText(error) { var entry = errors.get(error); return entry && entry.field ? fieldMessages[entry.field]
    : messages[code(error)] || '文档设置操作未完成，请检查后手动重试。'; }
  async function request(action, method, body, signal) {
    // Deliberately no generic route bridge: these are the only two operations.
    if (!((action === 'config' && method === 'GET') || (action === 'save' && method === 'POST'))) throw fail('invalid_input');
    var options = { method: method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: signal };
    if (method === 'POST') { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
    var response;
    try { response = await (platform.fetch || window.fetch.bind(window))('api/video-study/asr/' + action, options); }
    catch (_) { throw fail(signal && signal.aborted ? 'timeout' : 'network_error'); }
    if (response.status === 401 || response.status === 403) throw fail('session_reload_required');
    if (response.status === 404) throw fail('backend_reload_required');
    if (response.status === 409) throw fail('settings_conflict');
    var value;
    try { value = await response.json(); } catch (_) { throw fail('invalid_response'); }
    if (!response.ok || !value || value.status !== 'ok') throw fail(value && value.code, value && value.field);
    return value;
  }
  function valuesFrom(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('invalid_response');
    var result = {};
    keys.forEach(function (key) {
      var value = raw[key] === undefined ? defaults[key] : raw[key];
      if (typeof value !== 'string') throw fail('invalid_response');
      result[key] = value;
    });
    if (formats.indexOf(result.documentFormat) < 0) throw fail('invalid_response');
    return result;
  }
  function createController(options) {
    options = options || {};
    var transport = options.request || request, schedule = options.setTimeout || setTimeout, unschedule = options.clearTimeout || clearTimeout;
    var listeners = new Set(), pending = new Set(), disposed = false, loadingRequest = false;
    var state = { loading: true, busy: false, revision: null, values: null, draft: Object.assign({}, defaults),
      dirty: false, conflict: false, reloadConfirmation: false, error: '', notice: '' };
    function emit(patch) {
      if (disposed) return;
      state = Object.assign({}, state, patch);
      state.dirty = !!state.values && keys.some(function (key) { return state.draft[key] !== state.values[key]; });
      listeners.forEach(function (listener) { listener(state); });
    }
    async function call(action, method, body) {
      var controller = new AbortController(); pending.add(controller);
      var timer = schedule(function () { controller.abort(); }, 15000);
      try { return await transport(action, method, body, controller.signal); }
      catch (error) { if (controller.signal.aborted) throw fail('timeout'); throw error; }
      finally { unschedule(timer); pending.delete(controller); }
    }
    function accept(value, notice) {
      if (!value || value.status !== 'ok' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('invalid_response');
      var values = valuesFrom(value.values);
      emit({ loading: false, busy: false, revision: value.revision, values: values, draft: Object.assign({}, values),
        conflict: false, reloadConfirmation: false, error: '', notice: notice || '' });
    }
    var unsubscribeSettings = platform.settingsSync ? platform.settingsSync.subscribe(function (event) {
      if (disposed || !state.values || state.loading || state.busy || state.conflict || state.revision !== event.previousRevision
          || event.revision !== event.previousRevision + 1
          || event.fields.some(function (key) { return keys.indexOf(key) >= 0; })) return;
      emit({ revision: event.revision });
    }) : function () {};
    function editable() { return !disposed && !!state.values && !state.loading && !state.busy && !state.conflict; }
    return {
      snapshot: function () { return state; },
      subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
      load: async function (discard) {
        if (disposed || state.busy || loadingRequest) return false;
        if (state.dirty && discard !== true) { emit({ reloadConfirmation: true }); return false; }
        loadingRequest = true; emit({ loading: true, error: '', notice: '', reloadConfirmation: false });
        try { accept(await call('config', 'GET')); return !disposed; }
        catch (error) { emit({ loading: false, values: null, revision: null, error: errorText(error) }); return false; }
        finally { loadingRequest = false; }
      },
      cancelReload: function () { emit({ reloadConfirmation: false }); },
      update: function (key, value) {
        if (!editable() || keys.indexOf(key) < 0 || typeof value !== 'string') return false;
        if (key === 'documentFormat' && formats.indexOf(value) < 0) return false;
        var draft = Object.assign({}, state.draft); draft[key] = value;
        emit({ draft: draft, error: '', notice: '', reloadConfirmation: false }); return true;
      },
      save: async function () {
        if (!editable() || !state.dirty) return false;
        var patch = {};
        keys.forEach(function (key) { if (state.draft[key] !== state.values[key]) patch[key] = state.draft[key]; });
        // Omitting secret means keep; never echo ASR fields, authorization or credentials.
        var body = { revision: state.revision, patch: patch };
        emit({ busy: true, error: '', notice: '', reloadConfirmation: false });
        try {
          accept(await call('save', 'POST', body), '文档设置已保存。');
          if (!disposed && platform.settingsSync && state.revision === body.revision + 1) platform.settingsSync.publish({ previousRevision: body.revision,
            revision: state.revision, fields: Object.keys(patch), secretChanged: false });
          return !disposed;
        } catch (error) { emit({ busy: false, conflict: code(error) === 'settings_conflict', error: errorText(error) }); return false; }
      },
      dispose: function () {
        disposed = true; unsubscribeSettings(); listeners.clear();
        pending.forEach(function (controller) { controller.abort(); }); pending.clear();
      }
    };
  }
  function DocumentSettings() {
    var controllerRef = React.useRef(null);
    var pair = React.useState({ loading: true, busy: false, values: null, draft: Object.assign({}, defaults),
      dirty: false, conflict: false, reloadConfirmation: false, error: '', notice: '' });
    var view = pair[0], setView = pair[1];
    React.useEffect(function () {
      var controller = createController(); controllerRef.current = controller;
      var unsubscribe = controller.subscribe(setView); void controller.load();
      return function () { unsubscribe(); controller.dispose(); if (controllerRef.current === controller) controllerRef.current = null; };
    }, []);
    var disabled = view.loading || view.busy || view.conflict || !view.values;
    var fieldStyle = { display: 'grid', gap: 6, minWidth: 0 };
    var inputStyle = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '9px 10px',
      color: 'inherit', background: 'transparent', font: 'inherit', border: '1px solid #8888', borderRadius: 6 };
    function invoke(name, arg) { return function () { if (controllerRef.current) void controllerRef.current[name](arg); }; }
    function button(label, name, off, arg) { return e('button', { type: 'button', onClick: invoke(name, arg), disabled: off,
      style: { padding: '8px 12px', color: 'inherit', background: '#8881', border: '1px solid #8888', borderRadius: 6, font: 'inherit', cursor: 'pointer' } }, label); }
    return e('section', { 'aria-label': '文档输出设置', style: { display: 'grid', gap: 16, minWidth: 0 } },
      e('div', null, e('h3', { style: { margin: 0, fontSize: 18 } }, '文档输出'),
        e('p', { style: { margin: '6px 0 0' } }, '保存整理后的课程正文，与字幕提取 / ASR 设置分开管理。此页不会启动导出、上传音频或安装依赖，也不会读取 API Key。')),
      e('label', { style: fieldStyle }, '文档输出目录（可选绝对路径）',
        e('input', { type: 'text', style: inputStyle, value: view.draft.documentOutputDir, disabled: disabled, autoComplete: 'off', spellCheck: false,
          placeholder: '留空：用户 Documents / DSH视频学习', 'aria-describedby': 'video-study-document-directory-help',
          onChange: function (event) { if (controllerRef.current) controllerRef.current.update('documentOutputDir', event.currentTarget.value); } })),
      e('p', { id: 'video-study-document-directory-help', style: { margin: '-8px 0 0', fontSize: 13, opacity: 0.85, overflowWrap: 'anywhere' } },
        '这是运行插件的服务端本机路径，不是浏览器下载目录。留空时，运行时默认使用该用户的 Documents/DSH视频学习；也可输入 Windows、macOS 或 Linux 的绝对目录。保存设置不会创建目录。'),
      e('label', { style: fieldStyle }, '默认文档格式',
        e('select', { style: inputStyle, value: view.draft.documentFormat, disabled: disabled,
          onChange: function (event) { if (controllerRef.current) controllerRef.current.update('documentFormat', event.currentTarget.value); } },
          [['docx', 'Word 文档（.docx，默认）'], ['md', 'Markdown（.md）'], ['txt', '纯文本（.txt）']].map(function (item) {
            return e('option', { key: item[0], value: item[0], style: { color: 'CanvasText', background: 'Canvas' } }, item[1]); }))),
      e('div', { style: { border: '1px solid #8885', borderRadius: 8, padding: 14, display: 'grid', gap: 8, overflowWrap: 'anywhere' } },
        e('h4', { style: { margin: 0 } }, '正文与公式'),
        e('p', { style: { margin: 0 } }, '工具 video_study_export 接收助手通读课程、核对公式后整理的正文；不会把原始字幕直接当作讲义。'),
        e('p', { style: { margin: 0 } }, 'Word 使用 OMML 可编辑公式；未支持的 LaTeX 会保留并给出 warning 警告。选择格式不代表公式已经核对，导出后仍应检查。'),
        e('p', { style: { margin: 0 } }, 'Word 需要为插件所用 Python 手动准备 python-docx；缺少依赖就停止，不会自动安装。请先核对插件配置的 Python 解释器与环境，再自行决定是否手动执行 python -m pip install python-docx（将 python 替换为该解释器）。本页不会运行命令。Markdown / 纯文本保留公式文本。')),
      e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        button('保存文档设置', 'save', disabled || !view.dirty), button('重新载入', 'load', view.loading || view.busy)),
      view.reloadConfirmation ? e('div', { role: 'alert', style: { border: '1px solid #8888', borderRadius: 6, padding: 12 } },
        e('p', { style: { marginTop: 0 } }, '重新载入会丢弃本页未保存草稿。确认前可先复制目录内容。'),
        e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, button('放弃草稿并载入', 'load', false, true), button('保留草稿', 'cancelReload', false))) : null,
      view.loading ? e('p', { role: 'status' }, '读取文档设置中…') : !view.values ? e('p', { role: 'status' }, '文档设置未载入。') : null,
      view.dirty ? e('p', { role: 'status' }, '文档设置有未保存的修改；切换标签会保留草稿。') : null,
      view.error ? e('p', { role: 'alert' }, view.error) : null,
      view.notice ? e('p', { role: 'status' }, view.notice) : null);
  }
  return { Component: DocumentSettings, _testing: { createController: createController, Component: DocumentSettings, defaults: defaults, request: request } };
}
