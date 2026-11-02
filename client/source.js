/* Source assembled by build.mjs. React 由宿主提供；不读浏览器 Cookie、不用外部二维码服务。 */
function createVideoStudyClient(React, qrcode, platform) {
  'use strict';
  platform = platform || {};
  var e = React.createElement;
  var asr = createAsrSettings(React, platform);
  var MAX_COOKIE = 64 * 1024;
  var FLOW = /^[A-Za-z0-9_-]{8,128}$/;
  var safeErrors = new WeakMap();
  var errorMessages = Object.freeze({
    unsupported_proxy: '当前登录通道不支持所配置的代理，请调整后重试。',
    unsupported_qr_url: '平台返回的扫码链接不在支持范围内，请更新插件后重试。',
    network_error: '无法连接B站登录服务，请检查网络与代理后重试。',
    timeout: '登录请求超时，请稍后重试。',
    platform_restricted: 'B站拒绝了本次请求或要求风控验证。',
    rate_limited: 'B站请求过于频繁，请稍后重试。',
    storage_error: '凭据存储失败，登录未确认保存。',
    verification_failed: '登录有效性核验失败。',
    origin_rejected: '页面来源校验失败，请重新加载DSH页面后重试。',
    session_reload_required: '登录设置访问未授权或页面会话已失效，请重新加载DSH页面后重试。',
    backend_reload_required: '未找到登录设置后台接口，请重新加载插件后端并刷新页面。',
    invalid_cookie: 'Cookie格式无效，请重新选择用户文件。',
    invalid_cookie_size: 'Cookie文件为空或超过64 KiB限制。',
    body_too_large: '所选文件或请求过大，已拒绝。',
    flow_not_found: '二维码流程不存在或已失效，请重新生成。',
    flow_cancelled: '扫码流程已取消，请重新生成。',
    disposed: '插件登录服务已停止，请重新加载插件后端。',
    invalid_response: '登录服务响应格式无效，已停止。',
    request_timeout: '设置请求超时，请刷新页面后重试。',
    json_required: '登录设置请求格式无效，请刷新页面后重试。',
    invalid_json: '登录设置请求格式无效，请刷新页面后重试。',
    method_not_allowed: '登录设置前后端接口不匹配，请重载插件与页面。',
  });
  function safeError(code) {
    var known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(errorMessages, code);
    var error = new Error('Video study request failed');
    error.code = known ? code : 'request_failed';
    safeErrors.set(error, error.code);
    return error;
  }
  function safeMessage(error, fallback) {
    var code = safeErrors.get(error);
    return Object.prototype.hasOwnProperty.call(errorMessages, code) ? errorMessages[code] : fallback;
  }
  function officialQr(value) {
    if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value)
        || /[\u0000-\u0020\u007f\\]/.test(value) || value.indexOf('#') >= 0
        || /^https:\/\/[^/?#]*@/i.test(value)) return false;
    try { var url = new URL(value); return url.protocol === 'https:'
      && ['account.bilibili.com', 'passport.bilibili.com'].indexOf(url.hostname) >= 0
      && !url.port && !url.username && !url.password && !url.hash; } catch (_) { return false; }
  }
  function expiry(value) { return typeof value === 'number' ? value : Date.parse(value); }
  function qrGeometry(value) {
    if (!officialQr(value)) throw safeError('unsupported_qr_url');
    var code = qrcode(0, 'M');
    code.addData(value, 'Byte'); code.make();
    var count = code.getModuleCount(), path = '';
    for (var y = 0; y < count; y++) for (var x = 0; x < count; x++)
      if (code.isDark(y, x)) path += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z';
    return { size: count + 8, path: path };
  }
  async function requestAction(action, body, signal) {
    var options = { method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin',
      mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: signal };
    if (options.method === 'POST') { options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body || {}); }
    var response;
    try { response = await (platform.fetch || window.fetch.bind(window))('api/video-study/auth/' + action, options); }
    catch (_) { throw safeError(signal && signal.aborted ? 'timeout' : 'network_error'); }
    // 宿主鉴权失败可能返回 HTML，不解析其正文。
    if (response.status === 401 || response.status === 403) throw safeError('session_reload_required');
    if (response.status === 404) throw safeError('backend_reload_required');
    var value;
    try { value = await response.json(); } catch (_) { throw safeError('invalid_response'); }
    if (!response.ok || !value || value.status === 'error')
      throw safeError(value && value.code);
    return value;
  }
  function createAuthController(options) {
    options = options || {};
    var request = options.request || requestAction;
    var now = options.now || Date.now;
    var schedule = options.setTimeout || setTimeout;
    var unschedule = options.clearTimeout || clearTimeout;
    var state = { auth: null, phase: 'loading', busy: false, qr: null, error: '' };
    var listeners = new Set(), pending = new Set(), starting = new Set();
    var disposed = false, generation = 0, timer = null, expiryTimer = null, pollRequest = null, activeFlow = null, expiresAt = 0;
    function emit(patch) {
      if (disposed) return;
      state = Object.assign({}, state, patch);
      listeners.forEach(function (listener) { listener(state); });
    }
    function stopTimer() { if (timer !== null) unschedule(timer); timer = null; }
    function stopExpiry() { if (expiryTimer !== null) unschedule(expiryTimer); expiryTimer = null; }
    async function call(action, body) {
      var controller = new AbortController(); pending.add(controller);
      if (action === 'poll') pollRequest = controller;
      // 后端生成二维码预算 15s，这里留 5s 传输余量。
      var deadline = schedule(function () { controller.abort(); }, action === 'start' ? 20000 : 10000);
      try { return await request(action, body || {}, controller.signal); }
      catch (error) { if (controller.signal.aborted) throw safeError('timeout'); throw error; }
      finally { unschedule(deadline); pending.delete(controller); if (pollRequest === controller) pollRequest = null; }
    }
    function bestCancel(flowId) {
      var controller = new AbortController();
      var deadline = schedule(function () { controller.abort(); }, 5000);
      void Promise.resolve().then(function () { return request('cancel', flowId ? { flowId: flowId } : {}, controller.signal); })
        .catch(function () {}).finally(function () { unschedule(deadline); });
    }
    function clearQr(phase, auth) {
      stopTimer(); stopExpiry(); activeFlow = null; expiresAt = 0;
      if (pollRequest) pollRequest.abort();
      emit({ phase: phase, qr: null, busy: false, auth: auth || state.auth });
    }
    function expireCurrent(token) {
      if (disposed || token !== generation || !activeFlow) return;
      var old = activeFlow; ++generation; clearQr('expired');
      if (pollRequest) pollRequest.abort();
      bestCancel(old);
    }
    function schedulePoll(token, interval) {
      stopTimer();
      timer = schedule(function () { timer = null; void poll(token); }, Math.max(2000, Math.min(interval || 2000, 5000)));
    }
    async function poll(token) {
      if (disposed || token !== generation || !activeFlow) return;
      if (now() >= expiresAt) { expireCurrent(token); return; }
      var flowId = activeFlow;
      try {
        var result = await call('poll', { flowId: flowId });
        if (disposed || token !== generation || flowId !== activeFlow) return;
        if (['success', 'expired', 'cancelled'].indexOf(result.status) >= 0) { clearQr(result.status, result); return; }
        if (['waiting_scan', 'waiting_confirm'].indexOf(result.status) < 0) throw new Error('request_failed');
        emit({ phase: result.status, auth: result });
        schedulePoll(token, result.retryAfterMs || 2000);
      } catch (error) {
        if (!disposed && token === generation) {
          clearQr('error'); emit({ error: safeMessage(error, '登录状态查询未完成，已停止轮询；请重新生成二维码。') });
          bestCancel(flowId);
        }
      }
    }
    return {
      snapshot: function () { return state; },
      subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
      load: async function () {
        if (disposed) return;
        var token = generation;
        try { var result = await call('status'); if (!disposed && token === generation) emit({ auth: result, phase: 'idle', error: '' }); }
        catch (error) { if (token === generation) emit({ phase: 'error', error: safeMessage(error, '无法读取登录设置状态。') }); }
      },
      start: async function () {
        if (disposed) return;
        var token = ++generation, previous = activeFlow;
        starting.add(token); stopTimer(); stopExpiry(); activeFlow = null;
        emit({ busy: true, qr: null, error: '', phase: 'starting' });
        try {
          if (previous) { try { await call('cancel', { flowId: previous }); } catch (_) {} }
          if (disposed || token !== generation) return;
          var result = await call('start');
          var end = expiry(result.expiresAt);
          if (!officialQr(result.qrUrl)) throw safeError('unsupported_qr_url');
          if (!FLOW.test(result.flowId || '') || !Number.isFinite(end)
              || end <= now() || end > now() + 5 * 60 * 1000) throw safeError('invalid_response');
          if (disposed || token !== generation) { bestCancel(result.flowId); return; }
          activeFlow = result.flowId; expiresAt = end;
          emit({ busy: false, phase: result.status === 'waiting_confirm' ? 'waiting_confirm' : 'waiting_scan',
            qr: { url: result.qrUrl, expiresAt: end } });
          expiryTimer = schedule(function () { expireCurrent(token); }, Math.max(0, end - now()));
          schedulePoll(token, 2000);
        } catch (error) { if (!disposed && token === generation) emit({ busy: false, phase: 'error', qr: null,
          error: safeMessage(error, '二维码生成未完成，请重试或导入 Cookie 文件。') }); }
        finally { starting.delete(token); }
      },
      cancel: async function () {
        if (disposed) return;
        var old = activeFlow; ++generation; clearQr('cancelled');
        try { var result = await call('cancel', old ? { flowId: old } : {}); emit({ auth: result, error: '' }); }
        catch (error) { emit({ error: safeMessage(error, '本页已停止轮询；服务端取消未确认。') }); }
      },
      check: async function () {
        if (disposed) return;
        emit({ busy: true, error: '' });
        try { var result = await call('check'); emit({ auth: result, busy: false }); }
        catch (error) { emit({ busy: false, error: safeMessage(error, '登录检查未完成。') }); }
      },
      importFile: async function (file) {
        if (disposed) return;
        if (!file || typeof file.size !== 'number' || file.size <= 0 || file.size > MAX_COOKIE) {
          emit({ error: '请选择不超过64 KiB的Cookie文本文件。' }); return;
        }
        var token = ++generation, previous = activeFlow;
        stopTimer(); stopExpiry(); activeFlow = null;
        emit({ busy: true, qr: null, error: '' });
        var content;
        try {
          if (previous) { try { await call('cancel', { flowId: previous }); } catch (_) {} }
          content = await file.text();
          if (disposed || token !== generation) return;
          if (new TextEncoder().encode(content).length > MAX_COOKIE) throw new Error('size_limit');
          var result = await call('import', { text: content });
          if (token === generation) emit({ auth: result, phase: 'idle', busy: false, error: '' });
        } catch (error) { emit({ busy: false, error: safeMessage(error, '导入未完成。') }); }
        finally { content = undefined; }
      },
      logout: async function () {
        if (disposed) return;
        ++generation; stopTimer(); stopExpiry(); activeFlow = null;
        emit({ busy: true, qr: null, error: '' });
        try { var result = await call('logout'); emit({ auth: result, phase: 'idle', busy: false }); }
        catch (error) { emit({ busy: false, error: safeMessage(error, '清除凭据未确认，请重试。') }); }
      },
      dispose: function () {
        if (disposed) return;
        var old = activeFlow, wasStarting = starting.size > 0;
        disposed = true; ++generation; stopTimer(); stopExpiry(); activeFlow = null;
        pending.forEach(function (controller) { controller.abort(); }); pending.clear(); listeners.clear();
        state = Object.assign({}, state, { qr: null });
        if (old || wasStarting) bestCancel(old);
      },
    };
  }
  function LoginSettings() {
    var controllerRef = React.useRef(null);
    var viewPair = React.useState({ auth: null, phase: 'loading', busy: false, qr: null, error: '' });
    var view = viewPair[0], setView = viewPair[1];
    React.useEffect(function () {
      var controller = createAuthController(); controllerRef.current = controller;
      var unsubscribe = controller.subscribe(setView); void controller.load();
      return function () { unsubscribe(); controller.dispose();
        if (controllerRef.current === controller) controllerRef.current = null; };
    }, []);
    function invoke(name) { return function () { var controller = controllerRef.current;
      if (controller) return controller[name](); }; }
    var auth = view.auth || {}, storage = auth.storage || {};
    var statusLabel = !view.auth ? (view.phase === 'loading' ? '读取中' : '未读取')
      : auth.loginStatus === 'authenticated' ? '已登录'
      : ['unverified', 'legacy_file_unchecked'].indexOf(auth.loginStatus) >= 0 ? '待检查'
      : auth.loginStatus === 'expired' ? '登录已过期' : '未登录';
    var phaseLabels = { starting: '正在生成二维码…', waiting_scan: '请用B站 App 扫码。',
      waiting_confirm: '已扫码，请在B站 App 确认。', expired: '二维码已过期。',
      cancelled: '已取消扫码。', success: '扫码已完成。' };
    var geometry;
    if (view.qr) { try { geometry = qrGeometry(view.qr.url); } catch (_) {} }
    var buttonStyle = { padding: '7px 12px', borderRadius: 6, border: '1px solid #8886', cursor: 'pointer' };
    function button(label, action, disabled) { return e('button', { type: 'button', style: buttonStyle,
      onClick: function () { void action(); }, disabled: disabled }, label); }
    return e('section', { 'aria-label': '视频学习登录设置', style: { display: 'grid', gap: 10 } },
      e('h3', { style: { margin: 0 } }, '哔哩哔哩'),
      e('p', { style: { margin: 0 } }, '哔哩哔哩下载字幕需要登录，Cookie仅供B站请求使用。'),
      e('p', { role: 'status', 'aria-live': 'polite', style: { margin: 0 } }, statusLabel),
      auth.source === 'managed' && auth.credentialAvailable && storage.persistent === false
        ? e('p', { role: 'note' }, '当前会话仅保存在内存中。') : null,
      e('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        button('扫码登录', invoke('start'), view.busy),
        view.qr || view.phase === 'starting' || auth.qr ? button('取消', invoke('cancel'), false) : null,
        button('检查', invoke('check'), view.busy), button('退出', invoke('logout'), view.busy)), 
      phaseLabels[view.phase] ? e('p', { role: 'status', 'aria-live': 'polite', style: { margin: 0 } }, phaseLabels[view.phase]) : null,
      geometry ? e('div', null,
        e('svg', { role: 'img', 'aria-label': 'B站登录二维码（仅本页）', width: 240, height: 240,
          viewBox: '0 0 ' + geometry.size + ' ' + geometry.size, shapeRendering: 'crispEdges', style: { background: '#fff' } },
          e('rect', { width: geometry.size, height: geometry.size, fill: '#fff' }), e('path', { d: geometry.path, fill: '#000' })),
        null)
        : view.qr ? e('p', { role: 'alert' }, '无法绘制二维码，请取消后重试或导入 Cookie。') : null,
      e('label', { style: { display: 'grid', gap: 6 } }, '导入 Cookie',
        e('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', disabled: view.busy,
          onChange: async function (event) { var input = event.currentTarget, file = input.files && input.files[0];
            try { if (file && controllerRef.current) await controllerRef.current.importFile(file); } finally { input.value = ''; } } })),
      view.error ? e('p', { role: 'alert' }, view.error) : null);
  }
  function VideoSettings() {
    return e('div', { style: { maxWidth: 760, padding: 20, display: 'grid', gap: 24 } },
      e('h2', { style: { margin: 0 } }, '视频学习'), e(LoginSettings), e(asr.Component));
  }
  return { inject: ['slots'], apply: function (ctx) {
    ctx.slots.inject('settings.section', function () {
      return ctx.slots.register({ name: 'settings.section', id: 'video-study', order: 30,
        label: '视频学习', inject: function () { return {}; } }, VideoSettings);
    });
  }, _testing: { createAuthController: createAuthController, qrGeometry: qrGeometry,
    LoginSettings: LoginSettings, VideoSettings: VideoSettings, asr: asr._testing, requestAction: requestAction } };
}
