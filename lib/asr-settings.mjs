// Native host settings only. These owner-gated routes never edit profile files,
// accept client namespaces, expose secret values, install, or run extraction.
import { posix, win32 } from 'node:path';
import { isSameOriginRequest } from './request-origin.mjs';
import { PathPickerError } from './local-path-picker.mjs';

const ROOT = '/api/video-study/asr/';
const MAX_BODY = 64 * 1024;
const MESSAGES = Object.freeze({
  settings_conflict: '设置已被其它操作修改，请重新加载后再保存。',
  settings_unavailable: '当前实例的原生设置服务不可用，未使用其它存储方式。',
  invalid_input: '设置参数或请求格式无效，请检查后重试。',
  settings_save_failed: '设置未能确认保存，原始异常已隐藏，请重新加载检查。',
  picker_unavailable: '当前宿主没有原生目录选择能力，请在运行DSH的本机使用或手动填写路径。',
  picker_busy: '已有目录选择窗口尚未结束，请先完成或取消。',
  picker_failed: '目录选择未完成，请重新选择或手动填写路径。',
  python_not_found: '所选文件夹未找到Python解释器，请选择Python安装目录或虚拟环境目录。',
});
export class AsrSettingsError extends Error {
  constructor(code, status, field) {
    super(MESSAGES[code] ?? MESSAGES.settings_unavailable);
    this.name = 'AsrSettingsError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'settings_unavailable';
    this.status = status ?? ({ settings_conflict: 409, settings_unavailable: 503, invalid_input: 400, settings_save_failed: 500 }[this.code]);
    // Only a known field name may leave the server, never its rejected value.
    if (this.code === 'invalid_input' && (ALLOWED_FIELDS.has(field) || field === 'cloudApiKey')) this.field = field;
  }
}
const fail = (code, status, field) => { throw new AsrSettingsError(code, status, field); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const revision = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, maximum = 4096) => typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const path = value => text(value) && (value === '' || win32.isAbsolute(value) || posix.isAbsolute(value));
const member = choices => value => choices.includes(value);
const number = maximum => value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;
const boolean = value => typeof value === 'boolean';
function proxy(value) {
  if (value === '') return true;
  if (!text(value, 2048) || /[\s\\]/.test(value) || /[?#]/.test(value)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname
    && !url.username && !url.password && !/^https?:\/\/[^/?#]*@/i.test(value) && (!url.port || Number(url.port) >= 1) && url.pathname === '/'; } catch { return false; }
}
function endpoint(value) {
  if (value === '') return true;
  if (!text(value, 2048) || /[\s\\%?#]/.test(value)) return false;
  try {
    const url = new URL(value), rawPath = /^https?:\/\/[^/]+(\/.*)$/i.exec(value)?.[1];
    return !!url.hostname && !url.username && !url.password && !/^https?:\/\/[^/?#]*@/i.test(value) && (!url.port || Number(url.port) >= 1)
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      && !!rawPath && /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(rawPath)
      && !rawPath.split('/').some(part => part === '.' || part === '..');
  } catch { return false; }
}
const FIELDS = Object.freeze({
  mode: { default: 'captions', valid: member(['captions', 'cloud']) },
  defaultLanguage: { default: 'auto', valid: member(['en', 'zh', 'auto']) },
  pythonPath: { default: '', valid: value => text(value) },
  stateDir: { default: '', valid: path }, outputDir: { default: '', valid: path },
  documentOutputDir: { default: '', valid: value => path(value) && !/^(?:[\\/]{2}|[A-Za-z]:[\\/]\?)/.test(value)
    && !value.split(/[\\/]/).some(part => part === '..') },
  documentFormat: { default: 'docx', valid: member(['docx', 'md', 'txt']) },
  proxy: { default: '', valid: proxy },
  cloudProviderName: { default: '', valid: value => text(value, Infinity) && value.isWellFormed() },
  cloudProtocol: { default: 'auto', valid: member(['auto', 'openai', 'dashscope_paraformer', 'dashscope_qwen', 'volcengine_flash', 'tencent_rec_task']) },
  cloudResponseFormat: { default: 'verbose_json', valid: member(['verbose_json', 'json', 'provider_default']) },
  cloudAppId: { default: '', valid: value => text(value) && !/[\s\x80-\uffff]/.test(value) },
  cloudRegion: { default: '', valid: value => text(value) && !/[\s\x80-\uffff]/.test(value) },
  cloudResourceId: { default: '', valid: value => text(value) && !/[\s\x80-\uffff]/.test(value) },
  cloudEndpoint: { default: '', valid: endpoint },
  // Provider model naming is not ours to invent. The total HTTP body remains
  // bounded, but there is no model-specific length/ASCII/punctuation rule.
  cloudModel: { default: '', valid: value => text(value, Infinity) && value.isWellFormed() },
  cloudApiKeyFile: { default: '', valid: path },
  cloudUploadConsent: { default: false, valid: boolean },
  cloudMaxAudioMiB: { default: 25, valid: number(512) },
  allowInsecureLoopback: { default: false, valid: boolean },
  downloadTimeout: { default: 300, valid: number(3600) },
  asrTimeout: { default: 3600, valid: number(86400) },
  maxDuration: { default: 14400, valid: number(86400) },
});
const ALLOWED_FIELDS = new Set(Object.keys(FIELDS));
function validateSave(input) {
  if (!plain(input) || Object.keys(input).some(key => !['revision', 'patch', 'secret'].includes(key))
      || !revision(input.revision) || !plain(input.patch)) fail('invalid_input');
  const ops = [];
  for (const [key, value] of Object.entries(input.patch)) {
    if (!ALLOWED_FIELDS.has(key)) fail('invalid_input');
    if (!FIELDS[key].valid(value)) fail('invalid_input', 400, key);
    ops.push({ op: 'set', path: [key], value });
  }
  if (input.secret !== undefined) {
    const secret = input.secret;
    if (!plain(secret) || Object.keys(secret).some(key => !['action', 'value'].includes(key))
        || !['keep', 'set', 'clear'].includes(secret.action)) fail('invalid_input');
    if (secret.action === 'set') {
      if (typeof secret.value !== 'string' || !secret.value || secret.value.length > 8192 || /[^\x21-\x7e]/.test(secret.value)) fail('invalid_input', 400, 'cloudApiKey');
      ops.push({ op: 'set', path: ['cloudApiKey'], value: secret.value });
    } else {
      if (Object.hasOwn(secret, 'value')) fail('invalid_input');
      if (secret.action === 'clear') ops.push({ op: 'set', path: ['cloudApiKey'], value: '' });
    }
  }
  return ops;
}
const conflict = error => error?.name === 'SettingsConflictError' || error?.constructor?.name === 'SettingsConflictError'
  || error?.code === 'settings_conflict';

export function createAsrSettingsRepository(ctx, { ownerContext = ctx, hasSecret } = {}) {
  async function namespace() {
    const fiber = ownerContext?.fiber;
    if (!fiber) fail('settings_unavailable');
    let ns = fiber.entry?.options?.id;
    if (ns === undefined) {
      const editor = ctx?.configEditor ?? ownerContext?.configEditor;
      if (typeof editor?.entries !== 'function') fail('settings_unavailable');
      const entries = await editor.entries();
      if (!Array.isArray(entries)) fail('settings_unavailable');
      const own = entries.filter(entry => entry?.fiber === fiber);
      if (own.length !== 1) fail('settings_unavailable');
      ns = own[0]?.options?.id;
    }
    if (typeof ns !== 'string' || !ns || ns.length > 1024) fail('settings_unavailable');
    return ns;
  }
  async function descriptor() {
    if (typeof ctx?.settings?.describe !== 'function' || typeof ctx?.settings?.mutate !== 'function') fail('settings_unavailable');
    const ns = await namespace();
    const all = await ctx.settings.describe({ redactSecrets: true });
    if (!Array.isArray(all)) fail('settings_unavailable');
    const owned = all.filter(row => row?.ns === ns);
    if (owned.length !== 1 || !revision(owned[0].revision) || owned[0].applies !== 'live' || !plain(owned[0].value)) fail('settings_unavailable');
    return owned[0];
  }
  async function snapshot(row) {
    const values = {};
    for (const [key, field] of Object.entries(FIELDS)) {
      const value = row.value[key];
      values[key] = field.valid(value) ? value : field.default;
    }
    // Production supplies hasSecret: SDK sidecar set means !== undefined and
    // therefore mislabels a default empty string. The sidecar fallback is for
    // injected fixtures; neither branch reads or returns cloudApiKey itself.
    const configured = typeof hasSecret === 'function' ? await hasSecret() === true
      : Array.isArray(row.secrets) && row.secrets.some(secret => secret?.set === true
        && (secret.path === 'cloudApiKey' || Array.isArray(secret.path) && secret.path.length === 1 && secret.path[0] === 'cloudApiKey'));
    return { status: 'ok', revision: row.revision, values, secretConfigured: configured };
  }
  async function read() {
    try { return await snapshot(await descriptor()); }
    catch (error) { if (error instanceof AsrSettingsError) throw error; fail('settings_unavailable'); }
  }
  async function save(input) {
    const ops = validateSave(input);
    let row;
    try { row = await descriptor(); }
    catch (error) { if (error instanceof AsrSettingsError) throw error; fail('settings_unavailable'); }
    if (row.revision !== input.revision) fail('settings_conflict');
    const destinationChanged = ['cloudEndpoint', 'cloudProtocol', 'cloudAppId', 'cloudRegion', 'cloudResourceId']
      .some(key => Object.hasOwn(input.patch, key) && input.patch[key] !== (row.value[key] ?? FIELDS[key].default));
    if (destinationChanged) {
      // The stored key is kept: many providers show a key only once, so deleting
      // it would strand the user with no way to recover it. Sending that key to a
      // new destination stays gated by consent, which is revoked here and can only
      // be granted again by an explicit uploadConsent: true in a later or this CAS.
      if (input.patch.cloudUploadConsent !== true) {
        const consent = ops.find(op => op.path[0] === 'cloudUploadConsent');
        if (consent) consent.value = false; else ops.push({ op: 'set', path: ['cloudUploadConsent'], value: false });
      }
    }
    if (ops.length) {
      try {
        if (await namespace() !== row.ns) fail('settings_unavailable');
        await ctx.settings.mutate(row.ns, ops, input.revision);
      } catch (error) {
        if (error instanceof AsrSettingsError) throw error;
        if (conflict(error)) fail('settings_conflict');
        fail('settings_save_failed');
      }
    }
    return read();
  }
  /** 只在 Python 路径仍为空时填入托管 venv；用户显式配置的解释器不覆盖。 */
  async function fillPythonPath(value) {
    if (!path(value) || value === '') fail('invalid_input', 400, 'pythonPath');
    let row;
    try { row = await descriptor(); }
    catch (error) { if (error instanceof AsrSettingsError) throw error; fail('settings_unavailable'); }
    const current = row.value.pythonPath;
    if (typeof current === 'string' && current !== '') return { filled: false, reason: 'already_configured' };
    try {
      if (await namespace() !== row.ns) fail('settings_unavailable');
      await ctx.settings.mutate(row.ns, [{ op: 'set', path: ['pythonPath'], value }], row.revision);
    } catch (error) {
      if (error instanceof AsrSettingsError) throw error;
      if (conflict(error)) fail('settings_conflict');
      fail('settings_save_failed');
    }
    return { filled: true };
  }
  return { read, save, fillPythonPath };
}

function sameOrigin(request) {
  // The SDK bridge uses dsh.internal as a synthetic URL. The shared validator
  // checks the original, host-fenced Host header rather than trusting Forwarded.
  if (!isSameOriginRequest(request)) fail('invalid_input', 403);
}
async function readJson(request, timeoutMs) {
  if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(request.headers.get('content-type') ?? '')) fail('invalid_input', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) fail('invalid_input', 413);
  if (!request.body) fail('invalid_input');
  const reader = request.body.getReader();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new AsrSettingsError('invalid_input', 408)); }, timeoutMs);
  });
  try {
    const read = async () => {
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { void reader.cancel().catch(() => {}); fail('invalid_input', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_input'); }
      if (!plain(value)) fail('invalid_input');
      return value;
    };
    return await Promise.race([read(), timeout]);
  } finally { clearTimeout(timer); }
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
function safeRuntimeResult(raw) {
  if (!plain(raw)) fail('settings_unavailable');
  const result = JSON.parse(JSON.stringify(raw, (key, value) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)
        || /^(?:cloudApiKey|api_key|authorization|cookies?|sessdata|secrets?|qrUrl|qrkey|qrcode_key|ns)$/i.test(key)) return undefined;
    return value;
  }));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 128 * 1024) fail('settings_unavailable');
  return result;
}

export function registerAsrSettings(ctx, { runtime, pickPath, resolvePath, ownerContext = ctx, hasSecret, readTimeoutMs = 5000 } = {}) {
  if (typeof ctx?.connection?.fetch?.register !== 'function' || !Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0 || readTimeoutMs > 30000) fail('settings_unavailable');
  const repository = createAsrSettingsRepository(ctx, { ownerContext, hasSecret });
  // rc5 bridge routes are path-unique and streaming GET creates an invalid
  // Request body. Keep the read buffered and mutations on a separate, bounded
  // streaming path rather than accepting POST on the buffered read endpoint.
  return [['config', 'GET', 'buffered'], ['save', 'POST', 'streaming'],
    ['status', 'POST', 'streaming'], ['setup', 'POST', 'streaming'],
    ['setup-install', 'POST', 'streaming'], ['setup-install-status', 'GET', 'buffered'],
    ['pick-path', 'POST', 'streaming'], ['resolve-path', 'POST', 'streaming']].map(([action, method, requestBody]) =>
    ctx.connection.fetch.register({ path: ROOT + action, methods: [method], requestBody,
      async fetch(request) {
        try {
          sameOrigin(request);
          if (request.method !== method) fail('invalid_input', 405);
          const url = new URL(request.url);
          if (url.search || url.hash) fail('invalid_input');
          const body = method === 'POST' ? await readJson(request, readTimeoutMs) : undefined;
          if (action === 'config') {
            const value = await repository.read();
            if (typeof runtime?.localDefaults === 'function') {
              const defaults = runtime.localDefaults();
              if (plain(defaults) && path(defaults.stateDir) && defaults.stateDir
                  && ['win32', 'linux', 'darwin'].includes(defaults.platform))
                value.localDefaults = { stateDir: defaults.stateDir, platform: defaults.platform };
            }
            return response(value);
          }
          if (action === 'resolve-path') {
            if (Object.keys(body).length !== 2 || body.field !== 'pythonPath'
                || !Object.hasOwn(body, 'path') || !path(body.path) || !body.path || body.path.length > 4096
                || /^[\\/]{2}/.test(body.path)) fail('invalid_input');
            if (typeof resolvePath !== 'function') fail('picker_unavailable', 503);
            return response(await resolvePath(body.field, body.path, { signal: request.signal }));
          }
          if (action === 'pick-path') {
            if (Object.keys(body).length !== 1 || body.field !== 'pythonPath') fail('invalid_input');
            if (typeof pickPath !== 'function') fail('picker_unavailable', 503);
            return response(await pickPath(body.field, { signal: request.signal }));
          }
          if (action === 'setup-install-status') {
            if (typeof runtime?.setupInstallStatus !== 'function') fail('settings_unavailable');
            const result = safeRuntimeResult(runtime.setupInstallStatus());
            // 装好后自动把托管 venv 写进仍为空的 Python 路径，用户无需手填。
            if (result?.status === 'prepared' && path(result.python_path) && result.python_path) {
              try {
                const fill = await repository.fillPythonPath(result.python_path);
                result.python_path_saved = fill.filled;
                if (fill.filled) result.config = await repository.read();
              } catch { result.python_path_saved = false; }
            }
            return response({ status: 'ok', result });
          }
          if (action === 'setup-install') {
            if (typeof runtime?.setupInstall !== 'function') fail('settings_unavailable');
            return response({ status: 'ok', result: safeRuntimeResult(await runtime.setupInstall({}, { signal: request.signal })) });
          }
          if (action === 'save') return response(await repository.save(body));
          if (Object.keys(body).length || typeof runtime?.[action] !== 'function') {
            if (Object.keys(body).length) fail('invalid_input');
            fail('settings_unavailable');
          }
          const result = await runtime[action]({}, { signal: request.signal });
          return response({ status: 'ok', result: safeRuntimeResult(result) });
        } catch (error) {
          const safe = error instanceof AsrSettingsError ? error : error instanceof PathPickerError
            ? new AsrSettingsError(error.code, error.code === 'picker_unavailable' ? 503 : 400)
            : new AsrSettingsError('settings_unavailable');
          return response({ status: 'error', code: safe.code, message: safe.message,
            ...(safe.field ? { field: safe.field } : {}) }, safe.status);
        }
      },
    }));
}
