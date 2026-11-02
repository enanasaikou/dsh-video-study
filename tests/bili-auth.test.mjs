import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createBiliApi, createBiliAuth, parseImportedCookie, BiliAuthError } from '../lib/bili-auth.mjs'

const OLD = 'FAKE_OLD_SESSION_NEVER_REAL'
const NEW = 'FAKE_NEW_SESSION_NEVER_REAL'
const QRKEY = 'FAKE_QR_KEY_NEVER_REAL'
const QRURL = 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=' + QRKEY
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function safe(value) {
  const result = JSON.stringify(value)
  assert.ok(!result.includes(OLD), 'old session escaped')
  assert.ok(!result.includes(NEW), 'new session escaped')
  assert.ok(!result.includes(QRKEY), 'QR key escaped outside start result')
  return value
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BiliAuthError)
    assert.equal(error.code, code)
    safe({ message: error.message, code: error.code })
    return true
  })
}
function fixture({ initial = null, legacyCookieFile = '', persistent = true } = {}) {
  let record = initial, clock = 100000, id = 0
  const saves = [], apiCalls = []
  const store = {
    async load() { return record },
    async save(value) { saves.push(structuredClone(value)); record = structuredClone(value); return { persistent } },
    async clear() { record = null },
    capabilities() { return { encrypted: persistent, persistent } },
  }
  const api = {
    async generateQr() { apiCalls.push(['generate']); return { qrkey: QRKEY, qrUrl: QRURL } },
    async pollQr(key) { apiCalls.push(['poll', key]); return { status: 'waiting_scan' } },
    async check(value) { apiCalls.push(['check', value]); return { isLogin: true, mid: 12345 } },
    dispose() { apiCalls.push(['dispose']) },
  }
  const auth = createBiliAuth({ store, api, clock: () => clock, randomId: () => `flow_${String(++id).padStart(20, '0')}`, legacyCookieFile })
  return { auth, store, api, saves, apiCalls, get record() { return record }, setClock(value) { clock = value }, advance(value = 2000) { clock += value } }
}

test('public status is secret-free and managed unverified remains backend-private', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD }, legacyCookieFile: 'NEVER_READ' })
  assert.equal(safe(await f.auth.status()).loginStatus, 'unverified')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
  assert.deepEqual(Object.keys(f.auth).sort(), ['status','startQr','pollQr','cancelQr','check','importCookie','logout','credentialForRequest','markRejected','dispose'].sort())
  assert.equal(f.apiCalls.length, 0)
})

test('legacy source is not read or NAV-checked and anonymous marker suppresses fallback', async () => {
  const f = fixture({ legacyCookieFile: 'DO_NOT_OPEN_COOKIE_PATH' })
  const state = safe(await f.auth.check())
  assert.equal(state.source, 'legacy_file')
  assert.equal(state.notice, 'legacy_file_import_required')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'legacy_file' })
  assert.equal(f.apiCalls.length, 0)
  await f.auth.logout()
  assert.deepEqual(f.record, { source: 'anonymous' })
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'anonymous' })
  assert.equal((await f.auth.status()).source, 'anonymous')
})

test('load failure or invalid managed token never falls back to old account/file', async () => {
  for (const mode of ['invalid', 'load_error']) {
    const f = fixture({ initial: { source: 'managed', sessdata: '' }, legacyCookieFile: 'NEVER_READ' })
    if (mode === 'load_error') f.store.load = async () => { throw new Error(OLD) }
    assert.equal(safe(await f.auth.status()).loginStatus, 'invalid')
    assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed' })
    assert.equal((await f.auth.check()).source, 'managed')
    assert.equal(f.apiCalls.length, 0)
  }
})

test('QR waiting states never save and rate limit is enforced including concurrent polls', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
  const started = await f.auth.startQr()
  assert.equal(started.qrUrl, QRURL)
  assert.ok(!Object.hasOwn(started, 'qrkey'))
  assert.equal(started.expiresAt, 280000)
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
  const pending = deferred()
  f.api.pollQr = async () => { f.apiCalls.push(['poll']); return pending.promise }
  const first = f.auth.pollQr(started.flowId)
  await tick()
  const second = safe(await f.auth.pollQr(started.flowId))
  assert.ok(second.retryAfterMs > 0)
  pending.resolve({ status: 'waiting_confirm' })
  assert.equal(safe(await first).status, 'waiting_confirm')
  assert.equal((await f.auth.pollQr(started.flowId)).status, 'waiting_confirm')
  assert.equal(f.apiCalls.filter(x => x[0] === 'poll').length, 1)
  assert.equal(f.saves.length, 0)
})

test('QR confirmation requires NAV success before saving new credential', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
  const started = await f.auth.startQr()
  const nav = deferred()
  f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
  f.api.check = async value => { assert.equal(value, NEW); return nav.promise }
  const poll = f.auth.pollQr(started.flowId)
  await tick()
  assert.equal(f.saves.length, 0)
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
  nav.resolve({ isLogin: true })
  assert.equal(safe(await poll).status, 'success')
  assert.equal(safe(await f.auth.status()).loginStatus, 'authenticated')
  assert.deepEqual(f.record, { source: 'managed', sessdata: NEW })
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: NEW })
})

test('unverified or rejected QR success does not replace existing valid credential', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
  const started = await f.auth.startQr()
  f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
  f.api.check = async () => ({ isLogin: false })
  await rejectsCode(f.auth.pollQr(started.flowId), 'verification_failed')
  assert.equal(f.saves.length, 0)
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
})

for (const action of ['cancel', 'logout', 'dispose', 'new_flow']) {
  test(`${action} invalidates a pending QR success before verification/save`, async () => {
    const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
    const started = await f.auth.startQr(), pending = deferred()
    f.api.pollQr = async () => pending.promise
    const poll = f.auth.pollQr(started.flowId)
    await tick()
    if (action === 'cancel') await f.auth.cancelQr(started.flowId)
    if (action === 'logout') await f.auth.logout()
    if (action === 'dispose') await f.auth.dispose()
    if (action === 'new_flow') await f.auth.startQr()
    pending.resolve({ status: 'success', sessdata: NEW })
    assert.equal(safe(await poll).status, 'cancelled')
    assert.equal(f.saves.some(x => x.sessdata === NEW), false)
    assert.equal(f.apiCalls.filter(x => x[0] === 'check').length, 0)
    if (action === 'logout') assert.deepEqual(f.record, { source: 'anonymous' })
  })
}

test('cancel during NAV and expiry during NAV do not save the session', async () => {
  for (const cancel of [true, false]) {
    const f = fixture(), pending = deferred()
    const started = await f.auth.startQr()
    f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
    f.api.check = async () => pending.promise
    const poll = f.auth.pollQr(started.flowId)
    await tick()
    if (cancel) await f.auth.cancelQr(started.flowId)
    else f.advance(180001)
    pending.resolve({ isLogin: true })
    assert.equal((await poll).status, cancel ? 'cancelled' : 'expired')
    assert.equal(f.saves.length, 0)
  }
})

test('cancel during an already-started save compensates to old credential', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } }), gate = deferred(), saving = deferred()
  const originalSave = f.store.save
  f.store.save = async value => {
    if (value.sessdata === NEW) { saving.resolve(); await gate.promise }
    return originalSave(value)
  }
  const started = await f.auth.startQr()
  f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
  const poll = f.auth.pollQr(started.flowId)
  await saving.promise
  const cancel = f.auth.cancelQr(started.flowId)
  await tick(); gate.resolve()
  await cancel
  assert.equal((await poll).status, 'cancelled')
  assert.deepEqual(f.record, { source: 'managed', sessdata: OLD })
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
})

test('logout during pending save finishes anonymous and blocks legacy fallback', async () => {
  const f = fixture({ legacyCookieFile: 'NEVER_READ' }), gate = deferred(), saving = deferred()
  const save = f.store.save
  f.store.save = async value => { if (value.sessdata === NEW) { saving.resolve(); await gate.promise }; return save(value) }
  const started = await f.auth.startQr()
  f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
  const poll = f.auth.pollQr(started.flowId)
  await saving.promise
  const logout = f.auth.logout()
  await tick(); gate.resolve()
  await logout; assert.equal((await poll).status, 'cancelled')
  assert.deepEqual(f.record, { source: 'anonymous' })
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'anonymous' })
})

test('cancel during save with original null clears only the newly stored selection', async () => {
  const f = fixture({ legacyCookieFile: 'NEVER_READ' }), gate = deferred(), saving = deferred()
  const save = f.store.save
  f.store.save = async value => { if (value.sessdata === NEW) { saving.resolve(); await gate.promise }; return save(value) }
  const started = await f.auth.startQr()
  f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
  const poll = f.auth.pollQr(started.flowId)
  await saving.promise
  const cancel = f.auth.cancelQr(started.flowId)
  await tick(); gate.resolve()
  await cancel; await poll
  assert.equal(f.record, null)
  assert.equal((await f.auth.status()).source, 'legacy_file')
})

test('QR expires at three minutes and never automatically polls or retries', async () => {
  const f = fixture(), started = await f.auth.startQr()
  f.advance(180000)
  assert.equal(safe(await f.auth.pollQr(started.flowId)).status, 'expired')
  assert.equal(f.apiCalls.filter(x => x[0] === 'poll').length, 0)
  assert.equal(f.saves.length, 0)
})

test('flow IDs are bound and old flow cannot cancel or poll the new flow', async () => {
  const f = fixture(), old = await f.auth.startQr(), current = await f.auth.startQr()
  assert.notEqual(old.flowId, current.flowId)
  await rejectsCode(f.auth.pollQr(old.flowId), 'flow_not_found')
  await rejectsCode(f.auth.cancelQr(old.flowId), 'flow_not_found')
  assert.equal((await f.auth.status()).qr.flowId, current.flowId)
})

test('check invalid marks expired and network failure preserves valid selection', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD }, legacyCookieFile: 'NEVER_READ' })
  assert.equal((await f.auth.check()).loginStatus, 'authenticated')
  f.api.check = async () => { throw new Error(OLD + QRKEY) }
  await rejectsCode(f.auth.check(), 'network_error')
  assert.equal((await f.auth.status()).loginStatus, 'authenticated')
  f.api.check = async () => ({ isLogin: false })
  assert.equal((await f.auth.check()).loginStatus, 'expired')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed' })
  assert.equal(f.record.sessdata, OLD)
})

test('markRejected blocks private token but keeps managed selection', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD }, legacyCookieFile: 'NEVER_READ' })
  assert.equal(safe(await f.auth.markRejected()).loginStatus, 'expired')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed' })
  assert.equal(f.saves.length, 0)
})

test('import accepts only explicit JSON SESSDATA and verifies before store', async () => {
  const f = fixture()
  const state = safe(await f.auth.importCookie(JSON.stringify({ SESSDATA: NEW, uid: 123, access_token: 'IGNORED' })))
  assert.equal(state.loginStatus, 'authenticated')
  assert.deepEqual(f.saves, [{ source: 'managed', sessdata: NEW }])
  assert.deepEqual(f.apiCalls, [['check', NEW]])
  assert.equal(parseImportedCookie(JSON.stringify([{ name: 'SESSDATA', value: NEW, domain: '.bilibili.com' }])), NEW)
})

test('import invalid format/domain/control/size/duplicates never calls network or store', async () => {
  const f = fixture()
  const payloads = [OLD, '{}', JSON.stringify({ SESSDATA: ' WITH SPACE ' }), JSON.stringify({ SESSDATA: 'bad;cookie' }),
    JSON.stringify({ SESSDATA: 'bad\nvalue' }), JSON.stringify({ SESSDATA: 'x'.repeat(16001) }), ' '.repeat(65537),
    JSON.stringify([{ name: 'SESSDATA', value: NEW, domain: 'bilibili.com.evil.invalid' }]),
    JSON.stringify([{ name: 'SESSDATA', value: NEW, domain: '.bilibili.com' }, { name: 'SESSDATA', value: OLD, domain: '.bilibili.com' }])]
  for (const text of payloads) await rejectsCode(f.auth.importCookie(text), 'invalid_cookie')
  assert.equal(f.saves.length, 0); assert.equal(f.apiCalls.length, 0)
})

test('storage failure is not reported as success; memory-only status is honest', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
  const save = f.store.save
  f.store.save = async value => { if (value.sessdata === NEW) throw new Error(NEW); return save(value) }
  await rejectsCode(f.auth.importCookie(JSON.stringify({ SESSDATA: NEW })), 'storage_error')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
  const memory = fixture({ persistent: false })
  assert.equal((await memory.auth.importCookie(JSON.stringify({ SESSDATA: NEW }))).storage.persistent, false)
})

test('pending import/check results cannot resurrect state after logout/dispose', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } }), gate = deferred()
  f.api.check = async () => gate.promise
  const pending = f.auth.importCookie(JSON.stringify({ SESSDATA: NEW }))
  await tick(); await f.auth.logout(); gate.resolve({ isLogin: true })
  await rejectsCode(pending, 'flow_cancelled')
  assert.deepEqual(f.record, { source: 'anonymous' })
  await f.auth.dispose()
  await rejectsCode(f.auth.credentialForRequest(), 'disposed')
})

test('old request rejection cannot expire a newly confirmed account', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
  const oldCredential = await f.auth.credentialForRequest()
  await f.auth.importCookie(JSON.stringify({ SESSDATA: NEW }))
  assert.equal(safe(await f.auth.markRejected(oldCredential.sessdata)).loginStatus, 'authenticated')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: NEW })
  assert.equal((await f.auth.markRejected(NEW)).loginStatus, 'expired')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed' })
})

test('dispose during pending save restores old selection without activating new token', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } }), saving = deferred(), gate = deferred()
  const save = f.store.save
  f.store.save = async value => { if (value.sessdata === NEW) { saving.resolve(); await gate.promise }; return save(value) }
  const started = await f.auth.startQr()
  f.api.pollQr = async () => ({ status: 'success', sessdata: NEW })
  const poll = f.auth.pollQr(started.flowId)
  await saving.promise
  const disposed = f.auth.dispose()
  gate.resolve()
  await disposed
  assert.equal(safe(await poll).status, 'cancelled')
  assert.deepEqual(f.record, { source: 'managed', sessdata: OLD })
  await rejectsCode(f.auth.credentialForRequest(), 'disposed')
})

test('dispose during lazy loading prevents later QR requests', async () => {
  const f = fixture(), loading = deferred()
  f.store.load = async () => loading.promise
  const started = f.auth.startQr()
  await tick(); await f.auth.dispose(); loading.resolve(null)
  await rejectsCode(started, 'disposed')
  assert.equal(f.apiCalls.filter(x => x[0] !== 'dispose').length, 0)
})

test('logout storage failure remains session-anonymous and never claims persistence', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD }, legacyCookieFile: 'NEVER_READ' })
  await f.auth.status()
  f.store.save = async () => { throw new Error(OLD) }
  await rejectsCode(f.auth.logout(), 'storage_error')
  const state = safe(await f.auth.status())
  assert.equal(state.source, 'anonymous')
  assert.equal(state.storage.persistent, false)
  assert.equal(state.warning, 'storage_error')
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'anonymous' })
})

test('failed QR poll is terminal and further polls cannot retry network or storage', async () => {
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } }), started = await f.auth.startQr()
  let calls = 0
  f.api.pollQr = async () => { calls++; throw new BiliAuthError('platform_restricted') }
  await rejectsCode(f.auth.pollQr(started.flowId), 'platform_restricted')
  f.advance(2000)
  assert.equal((await f.auth.pollQr(started.flowId)).status, 'cancelled')
  assert.equal(calls, 1)
  assert.equal(f.saves.length, 0)
  assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
})

test('public operations and API errors do not log credentials or QR query values', async t => {
  const logs = []
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, name, (...args) => logs.push(args))
  const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
  safe(await f.auth.status()); safe(await f.auth.check())
  const started = await f.auth.startQr()
  f.api.pollQr = async () => { throw new Error(OLD + NEW + QRKEY) }
  await rejectsCode(f.auth.pollQr(started.flowId), 'network_error')
  await rejectsCode(f.auth.importCookie(OLD + QRKEY), 'invalid_cookie')
  safe(await f.auth.logout())
  assert.deepEqual(logs, [])
})

function mockRequests(replies) {
  const calls = []
  function requestImpl(url, options, callback) {
    const req = new EventEmitter()
    req.destroy = () => { req.destroyed = true }
    req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.onTimeout = fn }
    req.end = () => {
      const reply = replies.shift()
      queueMicrotask(() => {
        if (reply?.error) return req.emit('error', new Error(reply.error))
        if (reply?.hang) return
        const res = new EventEmitter()
        res.statusCode = reply?.status ?? 200
        res.headers = reply?.headers ?? {}
        res.destroy = () => { res.destroyed = true }
        callback(res)
        if (res.destroyed) return
        const raw = reply?.raw ?? JSON.stringify(reply?.body ?? { code: 0, data: {} })
        res.emit('data', Buffer.from(raw)); res.emit('end')
      })
    }
    calls.push({ url, options, req })
    return req
  }
  return { calls, requestImpl }
}
const apiResponse = data => ({ body: { code: 0, data } })

test('HTTP API has fixed origins and only NAV gets SESSDATA; body URL never followed', async () => {
  const mock = mockRequests([apiResponse({ url: QRURL, qrcode_key: QRKEY }), apiResponse({ code: 86101 }),
    { ...apiResponse({ code: 0, url: 'https://evil.invalid/?SESSDATA=' + OLD }), headers: { 'set-cookie': ['SESSDATA=' + NEW + '; Domain=.bilibili.com; Secure', 'DedeUserID=123'] } },
    apiResponse({ isLogin: true, mid: 123 })])
  const api = createBiliApi(mock)
  const generated = await api.generateQr(); assert.equal(generated.qrkey, QRKEY)
  assert.equal((await api.pollQr(QRKEY)).status, 'waiting_scan')
  assert.equal((await api.pollQr(QRKEY)).sessdata, NEW)
  assert.deepEqual(await api.check(NEW), { isLogin: true })
  assert.deepEqual(mock.calls.map(x => x.url.hostname), ['passport.bilibili.com','passport.bilibili.com','passport.bilibili.com','api.bilibili.com'])
  for (const call of mock.calls.slice(0, 3)) assert.equal(call.options.headers.Cookie, undefined)
  assert.equal(mock.calls[3].options.headers.Cookie, 'SESSDATA=' + NEW)
  assert.equal(mock.calls[0].options.agent.options.keepAlive, false)
  api.dispose()
})

test('API QR state mapping handles scanned/expired and rejects duplicate/missing cookie', async () => {
  for (const [code, status] of [[86090, 'waiting_confirm'], [86038, 'expired']]) {
    const api = createBiliApi(mockRequests([apiResponse({ code })]))
    assert.deepEqual(await api.pollQr(QRKEY), { status }); api.dispose()
  }
  for (const headers of [{}, { 'set-cookie': ['SESSDATA=' + OLD, 'SESSDATA=' + NEW] }, { 'set-cookie': ['SESSDATA=' + NEW + '; Domain=.evil.invalid'] }]) {
    const api = createBiliApi(mockRequests([{ ...apiResponse({ code: 0, url: 'https://evil.invalid/?SESSDATA=' + NEW }), headers }]))
    await rejectsCode(api.pollQr(QRKEY), 'invalid_cookie'); api.dispose()
  }
})

test('official account QR response shape and legacy passport both pass without changing API origin', async () => {
  const urls = [
    'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=' + QRKEY,
    QRURL,
    'https://account.bilibili.com:443/h5/account-h5/auth/scan-web?qrcode_key=' + QRKEY,
  ]
  for (const url of urls) {
    const mock = mockRequests([{ body: { code: 0, message: '0', ttl: 1, data: { url, qrcode_key: QRKEY } } }])
    const api = createBiliApi(mock)
    const generated = await api.generateQr()
    assert.equal(generated.qrUrl, url)
    assert.equal(mock.calls[0].url.hostname, 'passport.bilibili.com')
    assert.equal(mock.calls[0].options.headers.Cookie, undefined)
    const f = fixture({ initial: { source: 'managed', sessdata: OLD } })
    f.api.generateQr = async () => generated
    const started = await f.auth.startQr()
    assert.equal(started.qrUrl, url)
    const { qrUrl, ...publicFields } = started
    safe(publicFields); safe(await f.auth.status())
    assert.equal(f.saves.length, 0)
    assert.deepEqual(await f.auth.credentialForRequest(), { source: 'managed', sessdata: OLD })
    api.dispose()
  }
})

test('QR URLs reject lookalikes, subdomains, insecure ports, userinfo, fragments and controls safely', async () => {
  const urls = ['http://passport.bilibili.com/scan', 'http://account.bilibili.com/scan',
    'https://evil.invalid/scan', 'https://account.bilibili.com.evil.invalid/scan',
    'https://passport.bilibili.com.evil.invalid/scan', 'https://x.account.bilibili.com/scan',
    'https://x.passport.bilibili.com/scan', 'https://bilibili.com/scan',
    'https://account.bilibili.com:8443/scan', 'https://passport.bilibili.com:80/scan',
    'https://user:pass@account.bilibili.com/scan', 'https://user:pass@passport.bilibili.com/scan',
    'https://@account.bilibili.com/scan', 'https://account.bilibili.com/scan#' + QRKEY,
    'https://passport.bilibili.com/scan#', 'https://account.bilibili.com/scan\u0000',
    'https://account.bilibili.com/scan\u007f', 'https://account.bilibili.com/scan\n',
    'https://account.bilibili.com\\evil.invalid/scan']
  for (const url of urls) {
    const mock = mockRequests([apiResponse({ url, qrcode_key: QRKEY })])
    const api = createBiliApi(mock)
    await rejectsCode(api.generateQr(), 'unsupported_qr_url')
    assert.equal(mock.calls.length, 1)
    const f = fixture()
    f.api.generateQr = async () => ({ qrkey: QRKEY, qrUrl: url })
    await rejectsCode(f.auth.startQr(), 'unsupported_qr_url')
    assert.equal((await f.auth.status()).qr, null)
    assert.equal(f.saves.length, 0)
    api.dispose()
  }
})

test('API refuses proxy explicitly and does not consult environment proxy', async () => {
  assert.throws(() => createBiliApi({ proxy: 'http://127.0.0.1:7897' }), error => error.code === 'unsupported_proxy')
  const previous = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://evil.invalid:9999'
  try {
    const mock = mockRequests([apiResponse({ isLogin: true })]), api = createBiliApi(mock)
    await api.check(OLD)
    assert.equal(mock.calls[0].url.hostname, 'api.bilibili.com')
    assert.equal(Object.hasOwn(mock.calls[0].options, 'proxy'), false)
    api.dispose()
  } finally { if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous }
})

test('API redirects, risk and network errors are safe and never retried', async () => {
  for (const [reply, code] of [[{ status: 302, headers: { location: 'https://evil.invalid/?secret=' + OLD } }, 'redirect_rejected'],
    [{ status: 429 }, 'rate_limited'], [{ status: 403 }, 'platform_restricted'], [{ error: OLD + QRKEY }, 'network_error'],
    [{ raw: OLD + QRKEY }, 'invalid_response']]) {
    const mock = mockRequests([reply]), api = createBiliApi(mock)
    await rejectsCode(api.generateQr(), code)
    assert.equal(mock.calls.length, 1); api.dispose()
  }
})

test('API body size/content-length limit and socket/total timeouts are bounded', async () => {
  for (const reply of [{ raw: 'x'.repeat(100) }, { headers: { 'content-length': '100' } }]) {
    const api = createBiliApi({ ...mockRequests([reply]), maxResponseBytes: 50 })
    await rejectsCode(api.generateQr(), 'response_too_large'); api.dispose()
  }
  const mock = mockRequests([{ hang: true }]), api = createBiliApi({ ...mock, timeoutMs: 100 })
  const pending = api.generateQr(); mock.calls[0].req.onTimeout()
  await rejectsCode(pending, 'timeout'); assert.equal(mock.calls[0].req.destroyed, true); api.dispose()
  const timed = createBiliApi({ ...mockRequests([{ hang: true }]), timeoutMs: 5 })
  const total = timed.generateQr()
  await Promise.all([rejectsCode(total, 'timeout'), new Promise(resolve => setTimeout(resolve, 15))]); timed.dispose()
})
