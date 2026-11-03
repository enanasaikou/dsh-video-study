#!/usr/bin/env node
// Development-only transport probe. SDK source stays in memory; no HTTP server,
// sockets, real profile/credentials, QR, Python, installation or ASR is used.
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { PassThrough, Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Socket } from 'node:net';
import vm from 'node:vm';
import { openAsarSdk } from '../tests/support/asar-sdk.mjs';
import { registerAuthSettings } from '../lib/auth-settings.mjs';
import { registerAsrSettings } from '../lib/asr-settings.mjs';
import { createConfig, createToolDefinitions } from '../lib/adapter.mjs';
import { createRuntime } from '../lib/runtime.mjs';

let stage = 'arguments', checks = 0, sdk, controller, reportPath, result, diagnostic, fixtureRuntime;

const check = (condition, name) => { stage = name; if (!condition) throw new Error('probe assertion'); checks++; };
const oldConnect = Socket.prototype.connect, oldFetch = globalThis.fetch;
Socket.prototype.connect = function () { throw new Error('offline probe forbids network'); };
globalThis.fetch = async () => { throw new Error('offline probe forbids fetch'); };
try {
  const { values } = parseArgs({ options: { archive: { type: 'string' }, report: { type: 'string' } }, allowPositionals: false });
  if (!values.archive || values.report && !isAbsolute(values.report)) throw new Error('absolute paths required');
  reportPath = values.report;
  stage = 'sdk_read_bridge';
  sdk = openAsarSdk(values.archive);
  const connectionPackage = '@deepseek-ai/dsh-client-connection';
  const source = sdk.readPackageFile(connectionPackage, 'lib/index.js');
  const begin = source.indexOf('const DEFAULT_MAX_REQUEST_BODY_BYTES =');
  const end = source.indexOf('//#endregion', begin);
  check(begin >= 0 && end > begin, 'original_bridge_section_found');
  // Visibility instrumentation ONLY: evaluate the entire original SDK section
  // verbatim and return its otherwise-private bridge binding. No logic rewrite.
  const bridge = Function('Readable', source.slice(begin, end) + '\nreturn bridge;')(Readable);
  const peer = { principal: { kind: 'owner' } }, host = '127.0.0.1:1180', origin = 'http://' + host;
  const exchanges = [], callbacks = [];
  async function exchange(handler, { path, method = 'GET', headers = {}, body, chunks, stalled = false,
    principal = 'owner' } = {}) {
    const incoming = stalled ? new Readable({ read() {} })
      : Readable.from(chunks ?? (body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]));
    incoming.method = method; incoming.url = path;
    // IncomingMessage lowercases header names. Normalize frontend HeadersInit
    // before the original bridge reads it; otherwise mixed-case duplicates merge.
    incoming.headers = { host, origin, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) delete incoming.headers[key.toLowerCase()];
      else incoming.headers[key.toLowerCase()] = value;
    }
    incoming.on('error', () => {});
    if (stalled) incoming.push(Buffer.from('{'));
    const captured = [];
    const outgoing = new Writable({ write(chunk, encoding, done) { captured.push(Buffer.from(chunk)); done(); } });
    outgoing.writeHead = (status, responseHeaders = {}) => { outgoing.statusCode = status; outgoing.responseHeaders = responseHeaders; };
    let errorType;
    try {
      await bridge(incoming, outgoing, handler, { principal: { kind: principal } });
      await finished(outgoing);
    } catch (error) { errorType = error?.constructor?.name; }
    finally { incoming.destroy(); if (!outgoing.writableEnded) outgoing.destroy(); }
    const text = Buffer.concat(captured).toString('utf8');
    let json; try { json = JSON.parse(text); } catch {}
    const value = { status: outgoing.statusCode, headers: outgoing.responseHeaders ?? {}, text, json, errorType };
    exchanges.push({ method, path, status: value.status, field: value.json?.field, errorType });
    return value;
  }
  stage = 'legacy_get_negative';
  let oldCallbacks = 0;
  const legacy = await exchange({ requestBodyMode: () => 'streaming', fetch() { oldCallbacks++; return new Response(null, { status: 204 }); } },
    { path: '/api/legacy-fixture' });
  check(legacy.errorType === 'TypeError' && oldCallbacks === 0, 'legacy_streaming_get_fails_before_callback');
  const buffered = await exchange({ requestBodyMode: () => 'buffered', fetch() { oldCallbacks++; return new Response(null, { status: 204 }); } },
    { path: '/api/buffered-fixture' });
  check(buffered.status === 204 && oldCallbacks === 1 && !buffered.errorType, 'buffered_get_reaches_callback');

  stage = 'native_services_import';
  const [{ HostConnectionService }, { default: z }, { SettingsForms }] = await Promise.all([
    sdk.importPackage(connectionPackage), sdk.importPackage('@deepseek-ai/schemastery'), sdk.importPackage('@deepseek-ai/dsh-settings'),
  ]);
  const connection = Object.create(HostConnectionService.prototype);
  connection.fetchRoutes = new Map(); connection.interceptors = new Map();
  const disposers = [], registered = [];
  const owner = { effect(effect) { const dispose = effect(); disposers.push(dispose); return dispose; } };
  const Config = createConfig(z), fakeKey = 'FAKE_HTTP_KEY_NOT_A_REAL_CREDENTIAL';
  let raw = { mode: 'captions', cloudApiKey: fakeKey, registerSkill: true }, mutations = 0;
  const entry = { id: 'http-fixture', options: { id: 'video-http-fixture', config: raw },
    fiber: { uid: 1, state: 2, runtime: { Config }, config: Config(raw), ctx: {} } };
  const editor = { configuration: () => [{ entry, inherited: {}, override: raw }], entries: () => [entry],
    async edit(target, transform) {
      if (target !== entry) throw new Error('wrong fixture entry');
      const next = transform(raw, {}), parsed = Config(next);
      raw = next; entry.options.config = raw; entry.fiber.config = parsed; mutations++;
    } };
  const settings = Object.create(SettingsForms.prototype);
  settings.ownerContext = { configEditor: editor, emit() {} }; settings.revisions = new Map(); settings.presentations = new Map();
  const ctx = { fiber: entry.fiber, configEditor: editor, settings, connection: { fetch: {
    register(route) {
      registered.push({ path: route.path, methods: route.methods, requestBody: route.requestBody });
      return connection.registerFetchRoute(owner, { ...route, fetch(request) {
        callbacks.push({ actualRequest: request instanceof Request, origin: new URL(request.url).origin,
          host: request.headers.get('host'), path: new URL(request.url).pathname, bodyNull: request.body === null, method: request.method });
        return route.fetch(request); // actual native callback ABI: Request, not { request }
      } });
    },
  } } };
  let authChecks = 0, statusChecks = 0, setupChecks = 0;
  const account = { source: 'anonymous', loginStatus: 'anonymous', credentialAvailable: false,
    storage: { encrypted: true, persistent: true }, lastCheckedAt: null };
  const auth = { status: async () => ({ ...account }), check: async () => { authChecks++; return { ...account }; },
    startQr() { throw new Error('QR not permitted in probe'); }, pollQr() { throw new Error('QR not permitted in probe'); },
    cancelQr: async () => ({ ...account }), importCookie() { throw new Error('cookies not permitted in probe'); }, logout: async () => ({ ...account }) };
  const runnerCalls = [], fixtureWorkspace = resolve('http-fixture-workspace');
  let runtimeConfigReads = 0, runtimeWorkspaceReads = 0;
  const dynamicConfig = new Proxy({}, { get(_target, key) { runtimeConfigReads++; return entry.fiber.config[key]; } });
  fixtureRuntime = createRuntime(dynamicConfig, {
    getWorkspace: async () => { runtimeWorkspaceReads++; return fixtureWorkspace; },
    createScratchImpl: async () => { throw new Error('status and setup must not create scratch'); },
    accessImpl: async () => { throw new Error('no managed fixture'); },
    homedirImpl: () => resolve('http-fixture-home'),
    tmpdirImpl: () => { throw new Error('global temp fallback forbidden'); },
    spawnImpl(command, args, options) {
      runnerCalls.push({ command, args, options });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
      child.stdin.resume();
      child.stdin.once('finish', () => queueMicrotask(() => {
        child.stdout.write(JSON.stringify(args.includes('-c')
          ? { executable: resolve('http-fixture-python.exe'), version: [3, 13] }
          : { status: 'ok', network_used: false, runtime_ready: false }));
        child.emit('close', 0);
      }));
      return child;
    },
  });
  const choiceSchema = createToolDefinitions({}, fixtureRuntime)[1].parameters.outputStyle;
  check(choiceSchema?.required === true && JSON.stringify(choiceSchema.enum) === JSON.stringify(['verbatim', 'concise', 'summary']),
    'extract_style_required_schema_in_native_fixture');
  const missingChoice = await fixtureRuntime.extract({ target: 'abcdefghijk' });
  check(missingChoice.status === 'output_style_required' && missingChoice.success === false
    && missingChoice.question === '本次转写以什么简略度输出？' && missingChoice.choices.length === 3
    && runtimeConfigReads === 0 && runtimeWorkspaceReads === 0 && runnerCalls.length === 0,
    'missing_style_does_not_read_native_refs_workspace_or_spawn');
  const runtime = { async status(...args) { statusChecks++; return fixtureRuntime.status(...args); },
    async setup(...args) { setupChecks++; return fixtureRuntime.setup(...args); } };
  registerAuthSettings(ctx, auth, { readTimeoutMs: 30 });
  registerAsrSettings(ctx, { runtime, ownerContext: ctx, hasSecret: () => !!entry.fiber.config.cloudApiKey.get(), readTimeoutMs: 30,
    resolvePath: async (field, directory) => ({ status: 'ok', cancelled: false,
      path: field === 'pythonPath' ? directory + '/python.exe' : directory }) });
  const handler = connection.createSharedFetchHandler('/api');
  check(registered.length === 15 && new Set(registered.map(route => route.path)).size === 15, 'all_paths_registered_once');
  for (const route of registered) {
    const get = route.path.endsWith('/auth/status') || route.path.endsWith('/asr/config') || route.path.endsWith('/asr/setup-install-status');
    check(route.methods.length === 1 && route.methods[0] === (get ? 'GET' : 'POST')
      && route.requestBody === (get ? 'buffered' : 'streaming'), 'route_method_body_mode_' + route.path.split('/').slice(-2).join('_'));
    check(handler.requestBodyMode({ method: route.methods[0], url: new URL(route.path, 'http://dsh.internal') }) === route.requestBody,
      'native_body_mode_' + route.path.split('/').slice(-2).join('_'));
  }
  let duplicateRejected = false;
  try { connection.registerFetchRoute(owner, { path: registered[0].path, methods: ['GET'], requestBody: 'buffered', fetch: () => new Response() }); }
  catch { duplicateRejected = true; }
  check(duplicateRejected, 'native_duplicate_path_registration_rejected');
  const authGet = await exchange(handler, { path: '/api/video-study/auth/status' });
  check(authGet.status === 200 && authGet.json?.status === 'ok', 'auth_status_get_real_bridge_success');
  const configGet = await exchange(handler, { path: '/api/video-study/asr/config' });
  check(configGet.status === 200 && configGet.json?.values?.mode === 'captions', 'asr_config_get_real_bridge_success');
  check(callbacks.length === 2 && callbacks.every(call => call.actualRequest && call.origin === 'http://dsh.internal'
    && call.host === host && call.bodyNull && call.method === 'GET'), 'both_gets_actual_synthetic_request_and_host');
  check(!configGet.text.includes(fakeKey) && !Object.hasOwn(configGet.json.values, 'cloudApiKey'), 'http_config_secret_write_only');
  const checkAuth = await exchange(handler, { path: '/api/video-study/auth/check', method: 'POST', body: {} });
  check(checkAuth.status === 200 && authChecks === 1, 'auth_check_post_synthetic_host_origin_success');
  const save = await exchange(handler, { path: '/api/video-study/asr/save', method: 'POST', body: {
    revision: configGet.json.revision, patch: { mode: 'cloud', cloudEndpoint: 'https://asr.example.invalid/audio/transcriptions',
      cloudModel: 'fake-model', cloudUploadConsent: true }, secret: { action: 'keep' } } });
  check(save.status === 200 && save.json?.values?.mode === 'cloud' && raw.mode === 'cloud', 'asr_save_post_synthetic_host_origin_success');
  check(!save.text.includes(fakeKey), 'http_save_secret_free');

  const beforeRemovedSettings = JSON.stringify(raw), mutationsBeforeRemovedSettings = mutations;
  for (const patch of [{ mode: 'local' }, { localModel: 'small' }, { localModelDir: 'D:/model' },
    { localDevice: 'cpu' }, { localComputeType: 'int8' }]) {
    const rejected = await exchange(handler, { path: '/api/video-study/asr/save', method: 'POST', body: {
      revision: save.json.revision, patch } });
    check(rejected.status === 400 && rejected.json?.code === 'invalid_input'
      && JSON.stringify(raw) === beforeRemovedSettings && mutations === mutationsBeforeRemovedSettings,
      'removed_local_setting_rejected_' + Object.keys(patch)[0]);
  }

  stage = 'frontend_controller_bridge';
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let frontendRequests = 0, clientModule;
  const frontendFetch = async (url, options) => {
    frontendRequests++;
    const response = await exchange(handler, { path: '/' + url.replace(/^\/+/, ''), method: options.method,
      headers: options.headers ?? {}, body: options.body });
    if (response.errorType) throw new Error('bridge fixture failed');
    return new Response(response.text, { status: response.status, headers: response.headers });
  };
  vm.runInNewContext(clientSource, { window: { fetch: frontendFetch,
    __ModuleLoader__: { load(module) { clientModule = module; } } },
    URL, AbortController, TextEncoder, setTimeout, clearTimeout, Date }, { timeout: 3000 });
  check(typeof clientModule?.factory === 'function', 'frontend_bundle_native_moduleloader_contract');
  const frontend = clientModule.factory(name => {
    if (name !== 'react') throw new Error('unexpected frontend dependency');
    return { createElement() {} };
  });
  controller = frontend._testing.asr.createController();
  check(controller.snapshot().values === null && controller.update('mode', 'cloud') === false
    && await controller.save() === false && frontendRequests === 0, 'frontend_before_load_stays_disabled');
  check(await controller.load() === true && controller.snapshot().values?.mode === 'cloud', 'frontend_real_bridge_load_unlocks');
  for (const mode of ['captions', 'cloud']) {
    check(controller.update('mode', mode) === true && controller.snapshot().dirty, 'frontend_can_edit_' + mode);
    const saved = await controller.save();
    diagnostic = { saved, httpStatus: exchanges.at(-1)?.status, dirty: controller.snapshot().dirty,
      busy: controller.snapshot().busy, errorPresent: !!controller.snapshot().error, correctMode: raw.mode === mode };
    check(saved === true && !controller.snapshot().dirty && !controller.snapshot().busy
      && controller.snapshot().values.mode === mode && raw.mode === mode, 'frontend_bridge_save_' + mode);
    diagnostic = undefined;
  }
  check(frontendRequests === 3, 'frontend_only_one_get_and_two_saves');
  check(!JSON.stringify(controller.snapshot()).includes(fakeKey), 'frontend_snapshot_secret_free');
  check(await controller.check() === true && statusChecks === 1, 'frontend_status_streaming_post_success');
  check(await controller.setup() === true && setupChecks === 1, 'frontend_setup_streaming_post_success');
  check(runnerCalls.length === 3 && runnerCalls.every(call => call.options.cwd === fixtureWorkspace),
    'native_settings_workspace_reaches_probes_and_status_without_disk_writes');
  check(runnerCalls.every(call => !call.args.some(arg => arg.includes('http-fixture-workspace'))), 'workspace_context_not_added_to_argv');

  stage = 'ali_native_save_and_error_fields';
  const aliEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
  controller.update('cloudEndpoint', aliEndpoint); controller.update('cloudModel', 'paraformer-v2');
  check(await controller.save() === true && raw.cloudEndpoint === aliEndpoint && raw.cloudModel === 'paraformer-v2',
    'frontend_native_ali_endpoint_saved_through_real_bridge');
  const longModel = '自定义 model [v2] ' + 'x'.repeat(6000);
  controller.update('cloudModel', longModel);
  check(await controller.save() === true && raw.cloudModel === longModel && controller.snapshot().values.cloudModel === longModel,
    'native_model_name_not_ascii_pattern_limited_or_truncated');
  controller.update('cloudEndpoint', 'https://asr.example.invalid/v1/asr?key=leak');
  check(await controller.save() === false && controller.snapshot().error.includes('API地址') && raw.cloudEndpoint === aliEndpoint,
    'frontend_safe_endpoint_field_error_through_real_bridge');
  check(!JSON.stringify(controller.snapshot()).includes(fakeKey) && exchanges.at(-1).field === 'cloudEndpoint',
    'native_field_error_reveals_only_known_name_not_key');
  controller.update('cloudEndpoint', 'https://custom-gateway.example.invalid/any/path/v2/asr');
  controller.update('cloudProtocol', 'openai'); controller.update('cloudModel', '自定义 model v2');
  check(await controller.save() === true && raw.cloudEndpoint === 'https://custom-gateway.example.invalid/any/path/v2/asr'
    && raw.cloudProtocol === 'openai' && raw.cloudModel === '自定义 model v2',
    'frontend_custom_vendor_endpoint_and_protocol_saved_without_vendor_allowlist');
  controller.update('cloudEndpoint', aliEndpoint); controller.update('cloudModel', 'paraformer-v2');
  controller.update('cloudProtocol', 'dashscope_paraformer');
  check(await controller.save() === true, 'frontend_recovers_after_field_validation_without_reload');

  stage = 'desktop_path_resolution';
  const mutationsBeforeResolve = mutations;
  const resolvedPath = await exchange(handler, { path: '/api/video-study/asr/resolve-path', method: 'POST',
    body: { field: 'pythonPath', path: 'D:/fixture-python' } });
  check(resolvedPath.status === 200 && resolvedPath.json?.path === 'D:/fixture-python/python.exe'
    && mutations === mutationsBeforeResolve, 'desktop_resolve_real_bridge_without_saving');
  const badPath = await exchange(handler, { path: '/api/video-study/asr/resolve-path', method: 'POST',
    body: { field: 'cloudApiKeyFile', path: 'D:/fixture-python' } });
  check(badPath.status === 400 && badPath.json?.code === 'invalid_input', 'desktop_resolve_field_whitelist');

  for (const action of ['pick-path', 'resolve-path']) {
    const rejected = await exchange(handler, { path: '/api/video-study/asr/' + action, method: 'POST',
      body: { field: 'localModelDir', ...(action === 'resolve-path' ? { path: 'D:/model' } : {}) } });
    check(rejected.status === 400 && rejected.json?.code === 'invalid_input' && mutations === mutationsBeforeResolve,
      'removed_model_' + action + '_rejected');
  }

  stage = 'security_negatives';
  const protectedRoutes = [
    ['/api/video-study/auth/status', 'GET'], ['/api/video-study/asr/config', 'GET'],
    ['/api/video-study/auth/check', 'POST'], ['/api/video-study/asr/save', 'POST'],
  ];
  const baseline = { mutations, authChecks, statusChecks, setupChecks };
  for (const [path, method] of protectedRoutes) {
    for (const [name, headers] of [
      ['external_origin', { origin: 'https://foreign.example.invalid' }],
      ['cross_site', { 'sec-fetch-site': 'cross-site' }], ['missing_host', { host: undefined }],
    ]) {
      const rejected = await exchange(handler, { path, method, headers, ...(method === 'POST' ? { body: {} } : {}) });
      check(rejected.status === 403 && !rejected.errorType, 'origin_rejected_' + path.split('/').slice(-2).join('_') + '_' + name);
    }
    const guest = await exchange(handler, { path, method, principal: 'guest', ...(method === 'POST' ? { body: {} } : {}) });
    check(guest.status === 403 && !guest.errorType, 'native_guest_owner_gate_' + path.split('/').slice(-2).join('_'));
  }
  check(mutations === baseline.mutations && authChecks === baseline.authChecks, 'security_rejections_have_no_mutation_or_fake_api');
  const beforeRejectedWrites = JSON.stringify(raw), revision = settings.describe({ redactSecrets: true })[0].revision;
  const stale = await exchange(handler, { path: '/api/video-study/asr/save', method: 'POST', body: { revision: 0, patch: { mode: 'captions' } } });
  check(stale.status === 409 && JSON.stringify(raw) === beforeRejectedWrites, 'http_stale_revision_preserves_state');
  const overLimit = await exchange(handler, { path: '/api/video-study/asr/save', method: 'POST', chunks: [Buffer.alloc(32768, 32), Buffer.alloc(32769, 32)] });
  check(overLimit.status === 413 && JSON.stringify(raw) === beforeRejectedWrites, 'streaming_save_64k_chunk_cap_preserved');
  const declaredLimit = await exchange(handler, { path: '/api/video-study/asr/save', method: 'POST', headers: { 'content-length': '65537' }, body: '{}' });
  check(declaredLimit.status === 413 && JSON.stringify(raw) === beforeRejectedWrites, 'streaming_save_64k_declared_cap_preserved');
  const started = performance.now();
  const slow = await exchange(handler, { path: '/api/video-study/asr/save', method: 'POST', stalled: true });
  check(slow.status === 408 && performance.now() - started < 2000 && JSON.stringify(raw) === beforeRejectedWrites, 'streaming_save_slow_read_deadline_preserved');
  const removedPost = await exchange(handler, { path: '/api/video-study/asr/config', method: 'POST', body: { revision, patch: { mode: 'captions' } } });
  check(removedPost.status === 404 && JSON.stringify(raw) === beforeRejectedWrites, 'old_post_config_not_registered');
  const invalidGet = await exchange(handler, { path: '/api/video-study/asr/save' });
  check(invalidGet.status === 404 && !invalidGet.errorType, 'wrong_method_buffered_404_not_get_typeerror');
  check(callbacks.every(call => call.actualRequest && call.origin === 'http://dsh.internal'), 'all_registered_callbacks_use_actual_sdk_request');
  for (const dispose of disposers) dispose?.();
  check(connection.fetchRoutes.size === 0, 'native_route_disposal_removes_all');
  result = { status: 'passed', checks, sdk: { connection: sdk.packageVersion(connectionPackage),
    settings: sdk.packageVersion('@deepseek-ai/dsh-settings') },
    legacyStreamingGetReproduced: true, realBridge: true, realRouteDispatcher: true,
    actualSyntheticRequests: true, frontendControllerBridged: true, frontendBundle: true,
    registeredPaths: registered.length, exchanges: exchanges.length, networkUsed: false, profileWritten: false,
    notVerified: ['real socket admission', 'real profile persistence', 'browser DOM rendering', 'real credentials or ASR'] };
} catch {
  result = { status: 'failed', stage, checks, ...(diagnostic ? { diagnostic } : {}), networkUsed: false, profileWritten: false,
    note: 'Raw exceptions, bodies, configuration and keys are intentionally not printed.' };
  process.exitCode = 1;
} finally {
  controller?.dispose(); await fixtureRuntime?.dispose(); sdk?.close(); Socket.prototype.connect = oldConnect; globalThis.fetch = oldFetch;
}
if (reportPath) {
  try { await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
  catch { result = { status: 'failed', stage: 'report_output', checks, networkUsed: false, profileWritten: false }; process.exitCode = 1; }
}
console.log(JSON.stringify(result));
