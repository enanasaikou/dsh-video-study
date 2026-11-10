/* User-initiated Bilibili QR login; no discovery, OAuth, retries or third-party QR. */
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'

const MESSAGES = Object.freeze({
  invalid_cookie: '凭据无效；仅接受明确上传的本站会话凭据。',
  invalid_response: '登录服务响应无效。',
  unsupported_qr_url: '扫码链接不在支持范围内；请更新插件后重试。',
  unsupported_proxy: '代理地址无效；登录仅支持不带账号密码的 http://主机:端口。',
  proxy_error: '代理连接失败；未转发凭据，也未降级直连。',
  network_error: '登录服务网络或加密连接失败。',
  timeout: '登录服务请求超时。',
  rate_limited: '登录服务请求被限流。',
  platform_restricted: '登录服务拒绝访问或要求验证。',
  redirect_rejected: '登录服务返回重定向，未转发凭据。',
  response_too_large: '登录服务响应超过大小限制。',
  storage_error: '凭据存储不可用。',
  verification_failed: '平台未确认登录有效。',
  flow_not_found: '扫码流程不存在或不属于当前流程。',
  flow_cancelled: '扫码或导入流程已取消。',
  disposed: '登录服务已关闭。',
  invalid_config: '登录服务配置无效。',
})
export class BiliAuthError extends Error {
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.invalid_response); this.name = 'BiliAuthError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'invalid_response' }
}
const fail = code => { throw new BiliAuthError(code) }
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 16000 && /^[\x21-\x7e]+$/.test(value) && !value.includes(';')
const cookieDomain = domain => typeof domain === 'string' && ['bilibili.com', 'www.bilibili.com', 'api.bilibili.com'].includes(domain.replace(/^\./, '').toLowerCase())
const safeError = error => error instanceof BiliAuthError ? error : new BiliAuthError('network_error')
const BODY_ERRORS = new Map([[-412, 'rate_limited'], [-509, 'rate_limited'], [-403, 'platform_restricted'], [-101, 'platform_restricted'], [401, 'platform_restricted'], [352, 'platform_restricted']])

export function parseImportedCookie(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 65536) fail('invalid_cookie')
  let parsed
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { fail('invalid_cookie') }
  let value
  if (Array.isArray(parsed)) {
    const matches = parsed.filter(entry => entry && typeof entry === 'object' && entry.name === 'SESSDATA')
    if (matches.length !== 1 || !cookieDomain(matches[0].domain)) fail('invalid_cookie')
    value = matches[0].value
  } else if (parsed && typeof parsed === 'object') value = parsed.SESSDATA
  if (!token(value)) fail('invalid_cookie')
  return value
}

function qrKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(value)) fail('invalid_response')
  return value
}
function qrUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\s\\]/.test(value) || value.includes('#')) fail('unsupported_qr_url')
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['passport.bilibili.com', 'account.bilibili.com'].includes(url.hostname) || url.username || url.password || /^https:\/\/[^/?#]*@/i.test(value) || url.hash || url.port && url.port !== '443') fail('unsupported_qr_url')
    return value
  } catch { fail('unsupported_qr_url') }
}
function sessdataFromHeaders(headers) {
  const values = headers?.['set-cookie']
  const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : []
  const found = []
  for (const line of list) {
    if (typeof line !== 'string') continue
    const parts = line.split(';')
    const match = /^SESSDATA=(.*)$/.exec(parts[0].trim())
    if (!match) continue
    for (const attribute of parts.slice(1)) {
      const domain = /^\s*domain=(.*?)\s*$/i.exec(attribute)
      if (domain && !['bilibili.com', 'passport.bilibili.com'].includes(domain[1].replace(/^\./, '').toLowerCase())) fail('invalid_cookie')
    }
    if (!token(match[1])) fail('invalid_cookie')
    found.push(match[1])
  }
  if (found.length !== 1) fail('invalid_cookie')
  return found[0]
}

// Explicit proxy only: http://host:port, never credentials/path/query, never env proxy.
// A tunnelled request stays HTTPS to the fixed Bilibili origin; a failed tunnel is reported,
// not retried and not downgraded to a direct connection.
function proxyAddress(proxy) {
  if (proxy === undefined || proxy === null || proxy === '') return null
  if (typeof proxy !== 'string' || !/^http:\/\/(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]+\/?$/.test(proxy)) fail('unsupported_proxy')
  let url
  try { url = new URL(proxy) } catch { fail('unsupported_proxy') }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !Number(url.port)) fail('unsupported_proxy')
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) }
}

export function createBiliApi({ proxy, requestImpl = https.request, httpRequest = http.request, tlsConnect = tls.connect,
  timeoutMs = 15000, socketTimeoutMs = 10000, maxResponseBytes = 1024 * 1024 } = {}) {
  const via = proxyAddress(proxy)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000 || !Number.isFinite(socketTimeoutMs) || socketTimeoutMs <= 0 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4 * 1024 * 1024) fail('invalid_config')
  const agent = new https.Agent({ keepAlive: false })
  let disposed = false
  function get(host, path, sessdata) {
    if (disposed) return Promise.reject(new BiliAuthError('disposed'))
    return new Promise((resolve, reject) => {
      let request, response, timer, settled = false, connectRequest, tunnel, secureSocket, ownedAgent
      const resources = () => [response, request, secureSocket, tunnel, connectRequest]
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ownedAgent?.destroy?.() } catch {}
        if (error) {
          for (const item of resources()) { try { item?.destroy?.() } catch {} }
          reject(error instanceof Error ? error : new BiliAuthError(error))
        } else resolve(result)
      }
      timer = setTimeout(() => finish('timeout'), timeoutMs)
      timer.unref?.()
      const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'DSH-Video-Study/1' }
      const socketTimeout = Math.min(socketTimeoutMs, timeoutMs)
      const receive = res => {
        response = res
        res.on('error', () => finish('network_error'))
        res.on('aborted', () => finish('network_error'))
        const status = res.statusCode
        if (status >= 300 && status < 400) return finish('redirect_rejected')
        if (status === 429) return finish('rate_limited')
        if ([401, 403, 412].includes(status)) return finish('platform_restricted')
        if (status !== 200) return finish('network_error')
        const length = res.headers?.['content-length']
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxResponseBytes)) return finish('response_too_large')
        if (res.headers?.['content-encoding'] && res.headers['content-encoding'] !== 'identity') return finish('invalid_response')
        let total = 0
        const chunks = []
        res.on('data', chunk => {
          if (settled) return
          total += Buffer.byteLength(chunk)
          if (total > maxResponseBytes) return finish('response_too_large')
          chunks.push(Buffer.from(chunk))
        })
        res.on('end', () => {
          if (settled) return
          if (length !== undefined && total !== Number(length)) return finish('invalid_response')
          let body
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return finish('invalid_response') }
          finish(null, { body, headers: res.headers })
        })
      }
      const send = connectionAgent => {
        try {
          request = requestImpl(new URL('https://' + host + path), { method: 'GET', headers, agent: connectionAgent }, receive)
          request.on('error', () => finish('network_error'))
          request.setTimeout?.(socketTimeout, () => finish('timeout'))
          request.end()
        } catch (error) { finish(safeError(error)) }
      }
      try {
        if (sessdata !== undefined) {
          if (host !== 'api.bilibili.com' || path !== '/x/web-interface/nav' || !token(sessdata)) fail('invalid_cookie')
          headers.Cookie = 'SESSDATA=' + sessdata
        }
      } catch (error) { finish(safeError(error)); return }
      if (!via) { send(agent); return }
      try {
        connectRequest = httpRequest({ protocol: 'http:', hostname: via.hostname, port: via.port, method: 'CONNECT',
          path: host + ':443', agent: false, headers: { Host: host + ':443' } })
        connectRequest.on('error', () => finish('proxy_error'))
        connectRequest.on('response', () => finish('proxy_error'))
        connectRequest.setTimeout?.(socketTimeout, () => finish('timeout'))
        connectRequest.on('connect', (res, socket, head) => {
          tunnel = socket
          socket.on('error', () => finish('proxy_error'))
          if (settled) { try { socket.destroy() } catch {} ; return }
          if (res.statusCode !== 200 || (head && head.length)) { finish('proxy_error'); return }
          try {
            secureSocket = tlsConnect({ socket, servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
            secureSocket.on('error', () => finish('network_error'))
            secureSocket.once('secureConnect', () => {
              if (settled) return
              if (!secureSocket.authorized) { finish('network_error'); return }
              // A request-level createConnection is ignored by the default agent; the tunnel needs its own agent.
              ownedAgent = new https.Agent({ keepAlive: false, maxSockets: 1 })
              ownedAgent.createConnection = () => secureSocket
              send(ownedAgent)
            })
          } catch { finish('network_error') }
        })
        connectRequest.end()
      } catch { finish('proxy_error') }
    })
  }
  const data = body => {
    if (body && typeof body === 'object' && body.code === 0 && body.data && typeof body.data === 'object') return body.data
    fail(BODY_ERRORS.get(body?.code) ?? 'invalid_response')
  }
  return {
    async generateQr() {
      const result = await get('passport.bilibili.com', '/x/passport-login/web/qrcode/generate')
      const value = data(result.body)
      return { qrkey: qrKey(value.qrcode_key), qrUrl: qrUrl(value.url) }
    },
    async pollQr(key) {
      const result = await get('passport.bilibili.com', '/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(qrKey(key)))
      const value = data(result.body)
      const status = new Map([[86101, 'waiting_scan'], [86090, 'waiting_confirm'], [86038, 'expired'], [0, 'success']]).get(value.code)
      if (!status) fail('invalid_response')
      return status === 'success' ? { status, sessdata: sessdataFromHeaders(result.headers) } : { status }
    },
    async check(sessdata) {
      const result = await get('api.bilibili.com', '/x/web-interface/nav', sessdata)
      if (result.body?.code === -101) return { isLogin: false }
      const value = data(result.body)
      if (typeof value.isLogin !== 'boolean') fail('invalid_response')
      return { isLogin: value.isLogin }
    },
    dispose() { disposed = true; agent.destroy() },
  }
}

export function createBiliAuth({ store, api = createBiliApi(), clock = Date.now, randomId = () => randomBytes(18).toString('hex'), legacyCookieFile = '' } = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.capabilities !== 'function') fail('invalid_config')
  let record = null, loaded, loginStatus = 'anonymous', lastCheckedAt = null, storageWarning = null
  let generation = 0, credentialVersion = 0, flow = null, disposed = false, persistentOverride
  let mutations = Promise.resolve()
  const active = () => { if (disposed) fail('disposed') }
  const now = () => { const value = clock(); if (!Number.isFinite(value) || value < 0) fail('invalid_config'); return value }
  const stamp = () => new Date(now()).toISOString()
  const source = () => record === null ? (legacyCookieFile ? 'legacy_file' : 'anonymous') : record.source
  const publicFlow = current => current ? { flowId: current.flowId, status: current.status, expiresAt: current.expiresAt, pollIntervalMs: 2000 } : null
  const cancelled = current => ({ ...publicFlow(current), status: 'cancelled' })
  const serial = operation => {
    const next = mutations.then(operation)
    mutations = next.catch(() => {})
    return next
  }
  async function load() {
    if (!loaded) loaded = (async () => {
      try {
        const value = await store.load()
        if (value == null) { record = null; loginStatus = legacyCookieFile ? 'legacy_file_unchecked' : 'anonymous' }
        else if (value.source === 'anonymous') { record = { source: 'anonymous' }; loginStatus = 'anonymous' }
        else { record = { source: 'managed', ...(token(value.sessdata) ? { sessdata: value.sessdata } : {}) }; loginStatus = record.sessdata ? 'unverified' : 'invalid' }
      } catch { record = { source: 'managed' }; loginStatus = 'invalid'; storageWarning = 'storage_error' }
    })()
    await loaded
  }
  async function status() {
    active(); await load(); active()
    if (flow && ['waiting_scan', 'waiting_confirm'].includes(flow.status) && now() >= flow.expiresAt) flow.status = 'expired'
    let capabilities = {}
    try { capabilities = await store.capabilities() } catch { storageWarning = 'storage_error' }
    return { source: source(), loginStatus, storage: { encrypted: capabilities?.encrypted === true, persistent: persistentOverride ?? capabilities?.persistent === true },
      lastCheckedAt, credentialAvailable: source() === 'managed' && !!record?.sessdata && !['expired', 'invalid'].includes(loginStatus),
      qr: publicFlow(flow), ...(storageWarning ? { warning: storageWarning } : {}),
      ...(source() === 'legacy_file' ? { notice: 'legacy_file_import_required' } : {}) }
  }
  async function restoreSelection() {
    if (record === null && typeof store.clear === 'function') { await store.clear(); persistentOverride = undefined; return }
    if (record?.source === 'managed' && token(record.sessdata)) {
      const restored = await store.save({ source: 'managed', sessdata: record.sessdata })
      persistentOverride = restored?.persistent === true
      return
    }
    const restored = await store.save({ source: 'anonymous' })
    persistentOverride = restored?.persistent === true
    if (record === null || record.source !== 'anonymous') { record = { source: 'anonymous' }; loginStatus = 'anonymous'; credentialVersion++ }
  }
  async function commit(sessdata, fresh) {
    return serial(async () => {
      if (!fresh()) return false
      let saved
      try { saved = await store.save({ source: 'managed', sessdata }) }
      catch {
        storageWarning = 'storage_error'
        try { await restoreSelection() } catch { persistentOverride = false }
        fail('storage_error')
      }
      if (!fresh()) {
        try { await restoreSelection() } catch { persistentOverride = false; storageWarning = 'storage_error'; fail('storage_error') }
        return false
      }
      record = { source: 'managed', sessdata }; loginStatus = 'authenticated'; lastCheckedAt = stamp(); credentialVersion++
      persistentOverride = saved?.persistent === true; storageWarning = null
      return true
    })
  }
  async function startQr() {
    active(); await load(); active()
    const ticket = ++generation, startedAt = now()
    if (flow) flow.status = 'cancelled'
    const result = await Promise.resolve().then(() => api.generateQr()).catch(error => { throw safeError(error) })
    if (disposed || ticket !== generation) fail('flow_cancelled')
    const verifiedUrl = qrUrl(result?.qrUrl)
    const flowId = randomId()
    if (typeof flowId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(flowId)) fail('invalid_config')
    flow = { flowId, qrkey: qrKey(result?.qrkey), expiresAt: startedAt + 180000, status: 'waiting_scan', nextPollAt: 0, inFlight: false, ticket }
    if (now() >= flow.expiresAt) { flow.status = 'expired'; return publicFlow(flow) }
    return { ...publicFlow(flow), qrUrl: verifiedUrl }
  }
  async function pollQr(flowId) {
    active(); await load(); active()
    const current = flow
    if (!current || current.flowId !== flowId) fail('flow_not_found')
    if (['success', 'expired', 'cancelled'].includes(current.status)) return publicFlow(current)
    if (now() >= current.expiresAt) { current.status = 'expired'; return publicFlow(current) }
    if (current.inFlight || now() < current.nextPollAt) return { ...publicFlow(current), retryAfterMs: Math.max(1, current.nextPollAt - now()) }
    current.nextPollAt = now() + 2000; current.inFlight = true
    const same = () => !disposed && generation === current.ticket && flow === current
    const fresh = () => same() && now() < current.expiresAt
    try {
      const result = await api.pollQr(current.qrkey)
      if (!same()) return cancelled(current)
      if (!fresh()) { current.status = 'expired'; return publicFlow(current) }
      if (!['waiting_scan', 'waiting_confirm', 'expired', 'success'].includes(result?.status)) fail('invalid_response')
      if (result.status !== 'success') { current.status = result.status; return publicFlow(current) }
      if (!token(result.sessdata)) fail('invalid_cookie')
      const checked = await api.check(result.sessdata)
      if (!same()) return cancelled(current)
      if (!fresh()) { current.status = 'expired'; return publicFlow(current) }
      if (checked?.isLogin !== true) { current.status = 'expired'; fail('verification_failed') }
      if (!await commit(result.sessdata, fresh)) {
        current.status = same() ? 'expired' : 'cancelled'
        return publicFlow(current)
      }
      current.status = 'success'
      return publicFlow(current)
    } catch (error) {
      if (same() && current.status !== 'expired') current.status = 'cancelled' // terminal: no retry
      throw safeError(error)
    } finally { current.inFlight = false }
  }
  async function cancelQr(flowId) {
    active(); await load(); active()
    if (flowId !== undefined && flowId !== null && (!flow || flow.flowId !== flowId)) fail('flow_not_found')
    generation++
    if (flow) flow.status = 'cancelled'
    await mutations
    return { ...await status(), status: 'cancelled' }
  }
  async function check() {
    active(); await load(); active()
    if (source() !== 'managed' || !token(record?.sessdata)) return status()
    const version = credentialVersion, value = record.sessdata
    let result
    try { result = await api.check(value) } catch (error) { throw safeError(error) }
    if (!disposed && credentialVersion === version && record?.sessdata === value) {
      if (typeof result?.isLogin !== 'boolean') fail('invalid_response')
      loginStatus = result.isLogin ? 'authenticated' : 'expired'; lastCheckedAt = stamp(); credentialVersion++
    }
    return disposed ? { source: 'anonymous', loginStatus: 'anonymous', disposed: true } : status()
  }
  async function importCookie(text) {
    active()
    const value = parseImportedCookie(text)
    await load(); active()
    const ticket = ++generation
    if (flow) flow.status = 'cancelled'
    const fresh = () => !disposed && generation === ticket
    let result
    try { result = await api.check(value) } catch (error) { throw safeError(error) }
    if (!fresh()) fail('flow_cancelled')
    if (result?.isLogin !== true) fail('verification_failed')
    if (!await commit(value, fresh)) fail('flow_cancelled')
    return status()
  }
  async function logout() {
    active(); generation++
    if (flow) flow.status = 'cancelled'
    await load(); active()
    record = { source: 'anonymous' }; loginStatus = 'anonymous'; lastCheckedAt = null; credentialVersion++
    return serial(async () => {
      try { const saved = await store.save({ source: 'anonymous' }); persistentOverride = saved?.persistent === true; storageWarning = null }
      catch { persistentOverride = false; storageWarning = 'storage_error'; fail('storage_error') }
      return status()
    })
  }
  async function credentialForRequest() {
    active(); await load(); active()
    const selected = source()
    return selected === 'managed' && record?.sessdata && !['expired', 'invalid'].includes(loginStatus)
      ? { source: 'managed', sessdata: record.sessdata } : { source: selected }
  }
  async function markRejected(expectedSessdata) {
    active(); await load(); active()
    if (source() === 'managed' && (expectedSessdata === undefined || record?.sessdata === expectedSessdata)) {
      loginStatus = 'expired'; lastCheckedAt = stamp(); credentialVersion++
    }
    return status()
  }
  async function dispose() {
    if (disposed) return
    disposed = true; generation++
    if (flow) flow.status = 'cancelled'
    try { api.dispose?.() } catch {}
    await mutations
  }
  return { status, startQr, pollQr, cancelQr, check, importCookie, logout, credentialForRequest, markRejected, dispose }
}
