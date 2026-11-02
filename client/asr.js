/* Host-React ASR settings. Persistence belongs exclusively to the owner-gated
 * native settings API. No localStorage, direct provider call, install, or ASR. */
function createAsrSettings(React, platform) {
  'use strict';
  platform = platform || {};
  var e = React.createElement;
  var defaults = Object.freeze({ mode: 'captions', defaultLanguage: 'auto', pythonPath: '', stateDir: '', outputDir: '', proxy: '',
    localModel: 'small', localModelDir: '', localDevice: 'cpu', localComputeType: 'int8', cloudEndpoint: '', cloudModel: '',
    cloudProviderName: '', cloudProtocol: 'auto', cloudResponseFormat: 'verbose_json', cloudAppId: '', cloudRegion: '', cloudResourceId: '',
    cloudApiKeyFile: '', cloudUploadConsent: false, cloudMaxAudioMiB: 25, allowInsecureLoopback: false,
    downloadTimeout: 300, asrTimeout: 3600, maxDuration: 14400 });
  // Presets only fill editable fields. Names never select code paths or hosts.
  var presets = Object.freeze({
    custom: { label: '自定义服务', cloudProviderName: '', cloudProtocol: 'openai', cloudEndpoint: '', cloudModel: '', cloudResponseFormat: 'verbose_json' },
    siliconflow: { label: '硅基流动', cloudProviderName: '硅基流动', cloudProtocol: 'openai', cloudEndpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions', cloudModel: 'FunAudioLLM/SenseVoiceSmall', cloudResponseFormat: 'provider_default' },
    paraformer: { label: '阿里 Paraformer', cloudProviderName: '阿里 Paraformer', cloudProtocol: 'dashscope_paraformer', cloudEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', cloudModel: 'paraformer-v2' },
    qwen: { label: '阿里 Qwen-ASR', cloudProviderName: '阿里 Qwen-ASR', cloudProtocol: 'dashscope_qwen', cloudEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', cloudModel: 'qwen3-asr-flash' },
  qwenFiletrans: { label: '阿里 Qwen 文件转写（长录音）', cloudProviderName: '阿里 Qwen 文件转写', cloudProtocol: 'dashscope_paraformer', cloudEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', cloudModel: 'qwen3-asr-flash-filetrans' },
    volcengine: { label: '火山 / 豆包语音极速版', cloudProviderName: '火山豆包', cloudProtocol: 'volcengine_flash', cloudEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', cloudModel: 'bigmodel', cloudResourceId: 'volc.bigasr.auc_turbo' },
    tencent: { label: '腾讯云录音识别', cloudProviderName: '腾讯云', cloudProtocol: 'tencent_rec_task', cloudEndpoint: 'https://asr.tencentcloudapi.com/', cloudModel: '16k_zh', cloudRegion: 'ap-guangzhou' },
    groq: { label: 'Groq（OpenAI兼容）', cloudProviderName: 'Groq', cloudProtocol: 'openai', cloudEndpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', cloudModel: 'whisper-large-v3-turbo' }
  });
  var keys = Object.keys(defaults), errors = new WeakMap();
  var messages = Object.freeze({
    settings_conflict: '设置已在其它位置修改，请重新载入后再编辑。',
    invalid_input: '设置格式无效，请检查字段后重试。', invalid_settings: '设置值无效，请检查字段后重试。',
    invalid_config: '配置无效，请检查字段后重试。',
    dependency_missing: '缺少Python或所需依赖，请检查环境并配置Python路径。',
    model_missing: '未找到本地模型，请检查模型目录。',
    settings_unavailable: '宿主设置服务不可用，请重载插件后重试。',
    settings_save_failed: '设置保存失败，未确认生效，请检查宿主设置服务。',
    storage_error: '设置保存失败，未确认生效，请检查宿主设置服务。',
    persistence_failed: '设置保存失败，未确认生效，请检查宿主设置服务。',
    origin_rejected: '页面来源校验失败，请重新加载DSH页面。',
    session_reload_required: '页面会话已失效，请重新加载DSH页面。',
    backend_reload_required: '未找到ASR设置接口，请重载插件后端并刷新页面。',
    upload_consent_required: '云端ASR需要明确勾选音频上传授权。',
    timeout: '设置请求超时，未确认完成，请手动重试。',
    network_error: '无法连接插件设置服务，请检查连接后手动重试。',
    invalid_response: '设置服务返回格式无效，未确认完成。',
  });
  var fieldMessages = Object.freeze({
    cloudEndpoint: 'API地址须为完整HTTPS地址（本机回环可另行允许HTTP），不含URL凭据、查询参数、片段或路径穿越；不限制厂商域名或固定路径。',
    cloudProviderName: '服务名称不能含控制字符或非法Unicode；名称只用于显示。',
    cloudProtocol: '请选择支持的接口协议；服务名称不能代替协议。', cloudResponseFormat: '请选择服务支持的响应请求格式。',
    cloudAppId: '应用/凭据标识不能含空格、换行或非ASCII字符。', cloudRegion: '地域标识不能含空格、换行或非ASCII字符。',
    cloudResourceId: '资源ID不能含空格、换行或非ASCII字符。',
    cloudModel: '模型必须是可正常编码的文本，不能含换行或控制字符；不限制模型名称格式或单独字数。',
    cloudApiKey: 'API Key 不能为空，不能含空格、换行或非 ASCII 字符；请求头安全上限为8192字符。不会截断输入，留空则保留旧Key。',
    cloudApiKeyFile: 'Key文件须填写绝对路径，不能含换行或控制字符。',
    proxy: '代理须为不含凭据、查询参数或路径的 HTTP(S) 地址。',
    pythonPath: 'Python路径不能含换行或控制字符。',
    stateDir: '状态目录须填写绝对路径。', outputDir: '输出目录须填写绝对路径。', localModelDir: '模型目录须填写绝对路径。',
    cloudMaxAudioMiB: '最大音频MiB须为大于0且不超过512的数值，不是文字字数限制。',
    downloadTimeout: '下载超时须为大于0且不超过3600的秒数。',
    asrTimeout: '转写超时须为大于0且不超过86400的秒数。', maxDuration: '最长音频须为大于0且不超过86400的秒数。',
  });
  function fail(code, field) {
    var error = new Error('ASR settings request failed');
    errors.set(error, { code: Object.prototype.hasOwnProperty.call(messages, code) ? code : 'unknown',
      field: code === 'invalid_input' && Object.prototype.hasOwnProperty.call(fieldMessages, field) ? field : null });
    return error;
  }
  function errorCode(error) { var entry = errors.get(error); return entry && entry.code; }
  function errorText(error) { var entry = errors.get(error); return entry && entry.field ? fieldMessages[entry.field]
    : messages[errorCode(error)] || '操作未完成，请检查设置后重试。'; }
  async function request(action, method, body, signal) {
    var options = { method: method, credentials: 'same-origin', mode: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: signal };
    if (method === 'POST') { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body || {}); }
    var response;
    try { response = await (platform.fetch || window.fetch.bind(window))('api/video-study/asr/' + action, options); }
    catch (_) { throw fail(signal && signal.aborted ? 'timeout' : 'network_error'); }
    if (response.status === 401 || response.status === 403) throw fail('session_reload_required');
    if (response.status === 404) throw fail('backend_reload_required');
    var value;
    try { value = await response.json(); } catch (_) { throw fail('invalid_response'); }
    if (response.status === 409) throw fail('settings_conflict');
    if (!response.ok || !value || value.status !== 'ok') throw fail(value && value.code, value && value.field);
    return value;
  }
  function valuesFrom(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('invalid_response');
    var result = {};
    keys.forEach(function (key) {
      var value = raw[key] === undefined ? defaults[key] : raw[key];
      if (typeof value !== typeof defaults[key] || (typeof value === 'number' && !Number.isFinite(value)))
        throw fail('invalid_response');
      result[key] = value;
    });
    return result;
  }
  function summary(raw) {
    if (!raw || typeof raw !== 'object') throw fail('invalid_response');
    var backend = raw.backend && typeof raw.backend === 'object' ? raw.backend : raw;
    var labels = { ok: '离线检查完成', dependency_missing: '缺少依赖', model_missing: '未找到本地模型',
      model_invalid: '本地模型无效', not_runtime_checked: '尚未验证运行环境', invalid_config: '配置无效',
      invalid_input: '配置无效', invalid_endpoint: 'API地址不符合所选协议', insecure_endpoint: 'API地址需要HTTPS',
      invalid_api_key: 'Key不符合安全请求头格式', invalid_model: '请填写不含控制字符的模型名称',
      unsupported_model: '该协议不支持此模型或能力；请核对服务文档，不由厂商名称决定',
      invalid_protocol: '接口协议无效', invalid_provider: '服务名称无效', invalid_credentials: '缺少该协议要求的应用标识或凭据',
      invalid_response_format: '响应格式选项无效', invalid_region: '地域参数无效', invalid_resource_id: '资源ID无效',
      upload_consent_required: '尚未勾选音频上传授权', invalid_proxy: '代理格式无效', unsupported_proxy: '云端仅支持HTTP代理',
      proxy_loopback_conflict: '本机HTTP接口不能与代理混用', invalid_limit: '音频大小或超时设置无效',
      timeout: '检查超时', cancelled: '检查已取消' };
    var status = Object.prototype.hasOwnProperty.call(labels, backend.status) ? backend.status : 'not_runtime_checked';
    var known = ['yt-dlp', 'faster-whisper', 'ctranslate2', 'av', 'tokenizers', 'onnxruntime'];
    var missing = Array.isArray(backend.missing_dependencies)
      ? backend.missing_dependencies.filter(function (name) { return known.indexOf(name) >= 0; }) : [];
    return { label: labels[status], missing: missing };
  }
  function safeCommand(result) {
    if (result && result.status !== 'setup_command_prepared') throw fail(result.status);
    var command = result && result.command;
    if (!result || result.executed !== false || typeof command !== 'string'
        || command.length > 16384 || /[\u0000\r\n]/.test(command) || command.indexOf('setup_environment.py') < 0
        || command.indexOf('--allow-downloads') < 0 || /(?:api[_-]?key|authorization|bearer|sessdata|cookie)/i.test(command)
        || /https?:\/\/[^\s/'"]*@/i.test(command)) throw fail('invalid_response');
    return command;
  }
  function createController(options) {
    options = options || {};
    var transport = options.request || request;
    var schedule = options.setTimeout || setTimeout, unschedule = options.clearTimeout || clearTimeout;
    var listeners = new Set(), pending = new Set(), disposed = false, loadingRequest = false;
    var secretValue = '';
    var state = { loading: true, busy: false, revision: null, values: null, draft: Object.assign({}, defaults),
      secretConfigured: false, secretAction: 'keep', secretDraftPresent: false, secretEpoch: 0,
      dirty: false, conflict: false, error: '', notice: '', result: null, command: '' };
    function emit(patch) {
      if (disposed) return;
      state = Object.assign({}, state, patch);
      state.dirty = state.secretAction !== 'keep' || !!state.values && keys.some(function (key) { return state.draft[key] !== state.values[key]; });
      listeners.forEach(function (listener) { listener(state); });
    }
    async function call(action, method, body) {
      var controller = new AbortController(); pending.add(controller);
      var timer = schedule(function () { controller.abort(); }, action === 'status' ? 50000 : action === 'setup' ? 30000 : 15000);
      try { return await transport(action, method, body, controller.signal); }
      catch (error) { if (controller.signal.aborted) throw fail('timeout'); throw error; }
      finally { unschedule(timer); pending.delete(controller); }
    }
    function accept(value, notice) {
      if (!value || value.status !== 'ok' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('invalid_response');
      var values = valuesFrom(value.values);
      secretValue = '';
      emit({ loading: false, busy: false, revision: value.revision, values: values, draft: Object.assign({}, values),
        secretConfigured: value.secretConfigured === true, secretAction: 'keep', secretDraftPresent: false,
        secretEpoch: state.secretEpoch + 1, conflict: false, error: '', notice: notice || '', result: null, command: '' });
    }
    var unsubscribeSettings = platform.settingsSync ? platform.settingsSync.subscribe(function (event) {
      if (disposed || !state.values || state.loading || state.busy || state.conflict || state.revision !== event.previousRevision
          || event.revision !== event.previousRevision + 1
          || event.fields.some(function (key) { return keys.indexOf(key) >= 0; }) || event.secretChanged) return;
      emit({ revision: event.revision });
    }) : function () {};
    function editable() { return !disposed && !!state.values && !state.loading && !state.busy && !state.conflict; }
    function requireSaved() {
      if (disposed) return false;
      if (state.loading || state.busy) return false;
      if (state.conflict) { emit({ error: messages.settings_conflict }); return false; }
      if (!state.values) { emit({ error: '设置未载入，请先重新载入。' }); return false; }
      if (state.dirty) { emit({ error: '请先保存设置。' }); return false; }
      return true;
    }
    return {
      snapshot: function () { return state; },
      subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
      load: async function () {
        if (disposed || state.busy || loadingRequest) return false;
        loadingRequest = true;
        emit({ loading: true, error: '', notice: '' });
        try { accept(await call('config', 'GET')); return !disposed; }
        catch (error) { emit({ loading: false, values: null, revision: null, result: null, command: '', error: errorText(error) }); return false; }
        finally { loadingRequest = false; }
      },
      update: function (key, value) {
        if (!editable() || keys.indexOf(key) < 0) return false;
        var draft = Object.assign({}, state.draft); draft[key] = value;
        var patch = { draft: draft, notice: '', error: '', result: null, command: '' };
        if (value !== state.draft[key] && ['cloudEndpoint', 'cloudProtocol', 'cloudAppId', 'cloudRegion', 'cloudResourceId'].indexOf(key) >= 0) {
          secretValue = ''; draft.cloudUploadConsent = false;
          patch.secretAction = 'keep'; patch.secretDraftPresent = false; patch.secretEpoch = state.secretEpoch + 1;
          patch.notice = '服务目标已改变：已保存的Key会保留（多数厂商不提供再次查看），但必须重新勾选“上传音频授权”才会使用；请先确认新地址可信。';
        }
        if (key === 'mode' && value !== 'cloud') { secretValue = ''; patch.secretAction = 'keep';
          patch.secretDraftPresent = false; patch.secretEpoch = state.secretEpoch + 1; }
        emit(patch); return true;
      },
      applyPreset: function (id) {
        if (!editable() || !Object.prototype.hasOwnProperty.call(presets, id)) return false;
        var preset = presets[id], draft = Object.assign({}, state.draft, {
          cloudAppId: '', cloudRegion: '', cloudResourceId: '', cloudResponseFormat: 'verbose_json', cloudApiKeyFile: '', cloudUploadConsent: false
        });
        Object.keys(preset).forEach(function (key) { if (keys.indexOf(key) >= 0) draft[key] = preset[key]; });
        secretValue = '';
        emit({ draft: draft, secretAction: 'keep', secretDraftPresent: false, secretEpoch: state.secretEpoch + 1,
          notice: '预设只填写草稿，所有地址和模型仍可编辑；已保存的Key会保留，切换目标后必须重新勾选上传授权才会使用。', error: '', result: null, command: '' });
        return true;
      },
      setSecret: function (value) {
        if (!editable() || typeof value !== 'string') return false;
        secretValue = value;
        emit({ secretAction: value ? 'set' : 'keep', secretDraftPresent: !!value, error: '', notice: '' }); return true;
      },
      clearSecret: function (checked) {
        if (!editable()) return false;
        secretValue = '';
        emit({ secretAction: checked === true ? 'clear' : 'keep', secretDraftPresent: false,
          secretEpoch: state.secretEpoch + 1, error: '', notice: '' }); return true;
      },
      save: async function () {
        if (!editable() || !state.values || !state.dirty) return false;
        var patch = {};
        keys.forEach(function (key) { if (state.draft[key] !== state.values[key]) patch[key] = state.draft[key]; });
        var secret = { action: state.secretAction };
        if (secret.action === 'set') secret.value = secretValue;
        var body = { revision: state.revision, patch: patch, secret: secret };
        emit({ busy: true, error: '', notice: '' });
        try {
          accept(await call('save', 'POST', body), '已保存。');
          if (!disposed && platform.settingsSync && state.revision === body.revision + 1) platform.settingsSync.publish({ previousRevision: body.revision,
            revision: state.revision, fields: Object.keys(patch), secretChanged: secret.action !== 'keep' });
          return !disposed;
        }
        catch (error) {
          var conflict = errorCode(error) === 'settings_conflict';
          if (conflict) secretValue = '';
          emit({ busy: false, conflict: conflict, error: errorText(error),
            ...(conflict ? { secretAction: 'keep', secretDraftPresent: false, secretEpoch: state.secretEpoch + 1 } : {}) });
          return false;
        }
      },
      check: async function () {
        if (!requireSaved()) return false;
        emit({ busy: true, error: '', notice: '', command: '', result: null });
        try { var value = await call('status', 'POST', {}); emit({ busy: false, result: summary(value.result) }); return !disposed; }
        catch (error) { emit({ busy: false, error: errorText(error) }); return false; }
      },
      setup: async function () {
        if (!requireSaved()) return false;
        emit({ busy: true, error: '', notice: '', command: '', result: null });
        try { var value = await call('setup', 'POST', {}); emit({ busy: false, command: safeCommand(value.result) }); return !disposed; }
        catch (error) { emit({ busy: false, error: errorText(error) }); return false; }
      },
      copy: async function () {
        if (!state.command || disposed) return false;
        try { var clipboard = platform.clipboard || window.navigator && window.navigator.clipboard;
          if (!clipboard || typeof clipboard.writeText !== 'function') throw fail('unknown');
          await clipboard.writeText(state.command); emit({ notice: '命令已复制，请检查后手动执行。' }); return true;
        } catch (_) { emit({ error: '无法自动复制，请手动选择命令复制。' }); return false; }
      },
      dispose: function () {
        disposed = true; unsubscribeSettings(); secretValue = ''; listeners.clear(); pending.forEach(function (controller) { controller.abort(); }); pending.clear();
        state = Object.assign({}, state, { secretDraftPresent: false, secretAction: 'keep', command: '' });
      },
    };
  }
  function AsrSettings() {
    var controllerRef = React.useRef(null);
    var pair = React.useState({ loading: true, busy: false, draft: Object.assign({}, defaults), values: null,
      dirty: false, secretConfigured: false, secretAction: 'keep', secretEpoch: 0, conflict: false, error: '', notice: '', result: null, command: '' });
    var view = pair[0], setView = pair[1];
    React.useEffect(function () {
      var controller = createController(); controllerRef.current = controller;
      var unsubscribe = controller.subscribe(setView); void controller.load();
      return function () { unsubscribe(); controller.dispose(); if (controllerRef.current === controller) controllerRef.current = null; };
    }, []);
    var draft = view.draft, activeMode = view.values && !view.loading ? draft.mode : '';
    var disabled = view.loading || view.busy || view.conflict || !view.values;
    function run(name) { return function () { if (controllerRef.current) void controllerRef.current[name](); }; }
    function change(key, value) { if (controllerRef.current) controllerRef.current.update(key, value); }
    var fieldStyle = { display: 'grid', gap: 5, minWidth: 0 }, inputStyle = { padding: '8px 10px', minWidth: 0,
      width: '100%', boxSizing: 'border-box', color: 'inherit', background: 'transparent', font: 'inherit',
      border: '1px solid #8888', borderRadius: 6 };
    function input(key, label, type) { return e('label', { style: fieldStyle }, label,
      e('input', { type: type || 'text', style: inputStyle, value: draft[key], disabled: disabled, autoComplete: 'off',
        onChange: function (event) { var value = event.currentTarget.value;
          change(key, type === 'number' && value !== '' ? Number(value) : value); } })); }
    function select(key, label, choices) {
      var unloadedMode = key === 'mode' && (view.loading || !view.values);
      return e('label', { style: fieldStyle }, label,
        e('select', { style: inputStyle, value: unloadedMode ? '' : draft[key], disabled: disabled,
          onChange: function (event) { change(key, event.currentTarget.value); } },
          unloadedMode ? e('option', { key: 'not-loaded', value: '', disabled: true }, view.loading ? '读取设置中…' : '设置未载入') : null,
          choices.map(function (choice) { return e('option', { key: choice[0], value: choice[0], style: { color: 'CanvasText', background: 'Canvas' } }, choice[1]); })));
    }
    function checkbox(key, label) { return e('label', null,
      e('input', { type: 'checkbox', checked: draft[key] === true, disabled: disabled,
        onChange: function (event) { change(key, event.currentTarget.checked); } }), ' ', label); }
    function button(label, name, off) { return e('button', { type: 'button', disabled: off, onClick: run(name), style: { padding: '8px 12px', color: 'inherit', background: '#8881', font: 'inherit', border: '1px solid #8888', borderRadius: 6, cursor: 'pointer' } }, label); }
    return e('section', { 'aria-label': '字幕与ASR', style: { display: 'grid', gap: 12 } },
      e('h3', { style: { margin: 0, fontSize: 18 } }, '字幕与ASR'),
      select('mode', '模式', [['captions', '仅现有字幕'], ['cloud', '云端ASR'], ['local', '本机ASR']]),
      select('defaultLanguage', '语言', [['auto', '自动'], ['zh', '中文'], ['en', '英语']]),
      view.loading ? e('p', { role: 'status' }, '读取设置中…') : !view.values ? e('p', { role: 'status' }, '设置未载入') : null,
      activeMode === 'captions' ? e('p', null, '不识别音频') : null,
      activeMode === 'cloud' ? e('div', { style: { display: 'grid', gap: 10 } },
        e('label', { style: fieldStyle }, '快捷填入（可选，不会自动保存）', e('select', { style: inputStyle, defaultValue: '', disabled: disabled,
          onChange: function (event) { if (controllerRef.current) controllerRef.current.applyPreset(event.currentTarget.value); } },
          e('option', { value: '', disabled: true }, '选择预设或自定义'), Object.keys(presets).map(function (id) { return e('option', { key: id, value: id, style: { color: 'CanvasText', background: 'Canvas' } }, presets[id].label); }))),
        input('cloudProviderName', '服务名称（自定义）'),
        select('cloudProtocol', '接口协议', [['auto', '自动兼容旧设置'], ['openai', 'OpenAI兼容文件转写'], ['dashscope_paraformer', 'DashScope Paraformer异步'],
          ['dashscope_qwen', 'Qwen-ASR聊天接口'], ['volcengine_flash', '火山 / 豆包极速识别'], ['tencent_rec_task', '腾讯云录音识别TC3']]),
        input('cloudEndpoint', 'API地址'), input('cloudModel', '模型 / 引擎参数'),
        draft.cloudProtocol === 'auto' || draft.cloudProtocol === 'openai' ? select('cloudResponseFormat', '响应请求格式', [
          ['verbose_json', '带分段扩展（verbose_json）'], ['json', 'JSON正文（json）'], ['provider_default', '服务默认（只传文件和模型）']]) : null,
        draft.cloudProtocol === 'volcengine_flash' || draft.cloudProtocol === 'tencent_rec_task' ? input('cloudAppId', draft.cloudProtocol === 'tencent_rec_task' ? 'SecretId（凭据标识）' : 'App ID（应用标识）') : null,
        draft.cloudProtocol === 'tencent_rec_task' ? input('cloudRegion', '地域（可选）') : null,
        draft.cloudProtocol === 'volcengine_flash' ? input('cloudResourceId', '语音资源ID') : null,
        e('p', null, '服务名称、完整URL和模型均可自定义；按所选接口协议发送，不按厂商名称或域名白名单。预设仅填草稿。模型无单独字数或命名格式限制，不截断输入。'),
        e('p', null, '服务只返回正文时保存无时间戳稿，不伪造分段、不生成SRT。保存和检查环境都不联网验证Key、余额或接口可用性。'),
        e('p', null, '切换目标/协议/凭据标识会保留已保存的Key，但会撤销上传授权；重新勾选“上传音频授权”后该Key才会发往新地址，请先确认地址可信。云转写可能收费；异步任务取消或超时后可能继续并计费，不自动重提。Paraformer临时OSS音频约48小时后清理。'),
        e('label', { style: fieldStyle }, draft.cloudProtocol === 'tencent_rec_task' ? 'SecretKey' : draft.cloudProtocol === 'volcengine_flash' ? 'Access Token' : 'API Key', e('input', { type: 'password', key: view.secretEpoch,
          defaultValue: '', autoComplete: 'new-password', spellCheck: false, disabled: disabled, style: inputStyle,
          placeholder: view.secretConfigured ? '已配置，留空保留' : '输入 API Key',
          onChange: function (event) { if (controllerRef.current) controllerRef.current.setSecret(event.currentTarget.value); } })),
        e('label', null, e('input', { type: 'checkbox', checked: view.secretAction === 'clear', disabled: disabled,
          onChange: function (event) { if (controllerRef.current) controllerRef.current.clearSecret(event.currentTarget.checked); } }), ' 清除已保存的Key'),
        checkbox('cloudUploadConsent', '允许上传音频到此服务（可能产生费用）')) : null,
      activeMode === 'local' ? e('div', { style: { display: 'grid', gap: 10 } },
        select('localModel', '模型', [['tiny', 'tiny'], ['base', 'base'], ['small', 'small'], ['medium', 'medium'], ['large-v3', 'large-v3']]),
        input('localModelDir', '模型目录（可选）'), select('localDevice', '设备', [['cpu', 'CPU'], ['cuda', 'CUDA']]),
        input('localComputeType', '计算类型'), input('pythonPath', 'Python路径')) : null,
      e('details', null, e('summary', null, '高级设置'), e('div', { style: { display: 'grid', gap: 10, paddingTop: 10 } },
        draft.mode !== 'local' ? input('pythonPath', 'Python路径') : null,
        input('stateDir', '状态目录'), input('outputDir', '输出目录'), input('proxy', '代理'),
        activeMode === 'cloud' ? e('div', { style: { display: 'grid', gap: 10 } }, input('cloudApiKeyFile', 'Key文件（可选）'),
          input('cloudMaxAudioMiB', '最大音频MiB', 'number'), checkbox('allowInsecureLoopback', '允许本机回环HTTP服务')) : null,
        activeMode && activeMode !== 'captions' ? e('div', { style: { display: 'grid', gap: 10 } }, input('downloadTimeout', '下载超时秒', 'number'),
          input('asrTimeout', '转写超时秒', 'number'), input('maxDuration', '最长音频秒', 'number')) : null)),
      e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        button('检查环境', 'check', disabled || view.dirty || !view.values),
        button('生成部署命令', 'setup', disabled || view.dirty || !view.values),
        button('保存设置', 'save', disabled || !view.dirty), button('重新载入', 'load', view.loading || view.busy)),
      view.dirty ? e('p', { role: 'status' }, '有未保存的修改。') : null,
      view.error ? e('p', { role: 'alert' }, view.error) : null,
      view.notice ? e('p', { role: 'status' }, view.notice) : null,
      view.result ? e('p', { role: 'status' }, view.result.label + '；仅检查，不启动转写。'
        + (view.result.missing.length ? ' 缺少：' + view.result.missing.join('、') : '')) : null,
      view.command ? e('div', { style: { display: 'grid', gap: 8 } },
        e('label', { style: fieldStyle }, '部署命令（检查后手动执行）', e('textarea', { value: view.command, readOnly: true, rows: 3 })),
        button('复制命令', 'copy', false)) : null);
  }
  return { Component: AsrSettings, _testing: { createController: createController, Component: AsrSettings, request: request, defaults: defaults } };
}
