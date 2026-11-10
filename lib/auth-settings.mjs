// Owner gate is ctx.connection.fetch; never expose these handlers through webServer or an LLM tool.
import { isSameOriginRequest } from './request-origin.mjs';
const ROOT = '/api/video-study/auth/';
const ACTIONS = ['status', 'start', 'poll', 'cancel', 'check', 'import', 'logout'];
const MAX_BODY = 128 * 1024;
const MAX_COOKIE = 64 * 1024;
const FLOW = /^[A-Za-z0-9_-]{8,128}$/;
const QR_STATES = new Set(['waiting_scan', 'waiting_confirm', 'expired', 'success', 'cancelled']);
const LOGIN = new Set(['anonymous', 'legacy_file_unchecked', 'unverified', 'authenticated', 'expired', 'invalid']);
const SOURCES = new Set(['anonymous', 'legacy_file', 'managed']);
const UPSTREAM_CODES = ['network_error', 'timeout', 'invalid_response', 'unsupported_qr_url'];
const AUTH_CODES = new Set([...UPSTREAM_CODES, 'unsupported_proxy', 'proxy_error', 'invalid_cookie', 'storage_error', 'rate_limited',
  'platform_restricted', 'flow_not_found', 'flow_cancelled', 'verification_failed', 'disposed']);
class RouteError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
function sameOrigin(request) {
  if (!isSameOriginRequest(request)) throw new RouteError('origin_rejected', 403);
}
function flow(value, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !FLOW.test(value)) throw new RouteError('invalid_input');
  return value;
}
function expiry(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))) return value;
  throw new RouteError('invalid_response', 502);
}
function publicStatus(raw) {
  if (!raw || typeof raw !== 'object') throw new RouteError('invalid_response', 502);
  const value = { status: 'ok' };
  if (SOURCES.has(raw.source)) value.source = raw.source;
  if (LOGIN.has(raw.loginStatus)) value.loginStatus = raw.loginStatus;
  if (raw.storage && typeof raw.storage === 'object') value.storage = {
    encrypted: raw.storage.encrypted === true, persistent: raw.storage.persistent === true,
  };
  value.credentialAvailable = raw.credentialAvailable === true;
  value.lastCheckedAt = typeof raw.lastCheckedAt === 'string' && raw.lastCheckedAt.length <= 64 && Number.isFinite(Date.parse(raw.lastCheckedAt)) ? raw.lastCheckedAt : null;
  if (QR_STATES.has(raw.status)) value.status = raw.status;
  if (raw.flowId !== undefined) value.flowId = flow(raw.flowId);
  if (raw.expiresAt !== undefined) value.expiresAt = expiry(raw.expiresAt);
  if (Number.isFinite(raw.retryAfterMs)) value.retryAfterMs = Math.max(0, Math.min(5000, raw.retryAfterMs));
  if (raw.qr && typeof raw.qr === 'object') value.qr = {
    flowId: flow(raw.qr.flowId), status: QR_STATES.has(raw.qr.status) ? raw.qr.status : 'expired',
    expiresAt: expiry(raw.qr.expiresAt), pollIntervalMs: 2000,
  }; else value.qr = null;
  if (value.storage && (!value.storage.encrypted || !value.storage.persistent))
    value.warnings = ['安全持久化不可用，仅保留内存会话。'];
  return value;
}
function startResult(raw) {
  const value = publicStatus(raw);
  const unsafe = () => { throw new RouteError('unsupported_qr_url', 502); };
  if (typeof raw.qrUrl !== 'string' || raw.qrUrl.length > 4096
      || /[\x00-\x20\x7f\s\\]/.test(raw.qrUrl) || raw.qrUrl.includes('#')) unsafe();
  let url;
  try { url = new URL(raw.qrUrl); } catch { unsafe(); }
  if (url.protocol !== 'https:' || !['passport.bilibili.com', 'account.bilibili.com'].includes(url.hostname)
      || url.port || url.username || url.password || /^https:\/\/[^/?#]*@/i.test(raw.qrUrl) || url.hash) unsafe();
  return { ...value, flowId: flow(raw.flowId), qrUrl: raw.qrUrl,
    expiresAt: expiry(raw.expiresAt), pollIntervalMs: 2000,
    status: QR_STATES.has(raw.status) ? raw.status : 'waiting_scan' };
}
async function readJson(request, timeoutMs) {
  if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new RouteError('json_required', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new RouteError('body_too_large', 413);
  if (!request.body) throw new RouteError('invalid_json');
  const reader = request.body.getReader();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { reject(new RouteError('request_timeout', 408)); void reader.cancel().catch(() => {}); }, timeoutMs);
  });
  try {
    const read = async () => {
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { void reader.cancel().catch(() => {}); throw new RouteError('body_too_large', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new RouteError('invalid_json'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RouteError('invalid_json');
      return data;
    };
    return await Promise.race([read(), timeout]);
  } finally { clearTimeout(timer); }
}
function validateBody(action, data) {
  const allowed = action === 'import' ? ['text'] : ['poll', 'cancel'].includes(action) ? ['flowId'] : [];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new RouteError('invalid_input');
  if (action === 'poll') flow(data.flowId);
  if (action === 'cancel') flow(data.flowId, true);
  if (action === 'import' && (typeof data.text !== 'string' || !data.text || new TextEncoder().encode(data.text).length > MAX_COOKIE))
    throw new RouteError('invalid_cookie_size', 413);
}

export function registerAuthSettings(ctx, auth, { readTimeoutMs = 5000 } = {}) {
  const handlers = {
    status: () => auth.status(), start: () => auth.startQr(), check: () => auth.check(),
    poll: data => auth.pollQr(data.flowId), cancel: data => auth.cancelQr(data.flowId),
    import: data => auth.importCookie(data.text), logout: () => auth.logout(),
  };
  const registrations = [];
  for (const action of ACTIONS) {
    const method = action === 'status' ? 'GET' : 'POST';
    registrations.push(ctx.connection.fetch.register({ path: ROOT + action,
      methods: [method], requestBody: method === 'GET' ? 'buffered' : 'streaming',
      async fetch(request) {
        try {
          sameOrigin(request);
          if (request.method !== method) throw new RouteError('method_not_allowed', 405);
          if (new URL(request.url).search) throw new RouteError('invalid_input');
          const data = method === 'POST' ? await readJson(request, readTimeoutMs) : {};
          validateBody(action, data);
          let result = await handlers[action](data);
          // Merge offline account state so a completed scan needs no extra check.
          if (action === 'start' || action === 'poll') result = { ...await auth.status(), ...result };
          return response(action === 'start' ? startResult(result) : publicStatus(result));
        } catch (error) {
          const code = error instanceof RouteError ? error.code : AUTH_CODES.has(error?.code) ? error.code : 'auth_failed';
          const status = error instanceof RouteError ? error.status : UPSTREAM_CODES.includes(code) ? 502 : 400;
          return response({ status: 'error', code, message: '登录操作未完成；请检查设置后重试。' }, status);
        }
      },
    }));
  }
  return registrations;
}
