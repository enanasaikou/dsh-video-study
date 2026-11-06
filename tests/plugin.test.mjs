import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRuntime, DEFAULTS, extractionBudgetMs, sanitizeResult, terminateProcessTree } from '../lib/runtime.mjs';
import { applyPlugin, createConfig, createSkillProvider, createToolDefinitions } from '../lib/adapter.mjs';

const KEY = 'unit-test-key-DO-NOT-LEAK';
const executable = resolve('fake-python.exe');
const root = resolve('packages/dsh-video-study');
const workspace = resolve('fake-video-study-workspace');
const home = resolve('fake-home');
const workspaceState = base => join(base, '.dsh-video-study', 'state');
const exportArgs = { title: '工作区测试', markdown: '## 正文\n\n只导出已整理正文。' };

function harness(config = {}, options = {}) {
  const calls = [], scratches = [], workspaceCalls = [], accessCalls = [];
  let counter = 0;
  const createScratchImpl = async base => {
    const record = { base, path: join(base, `.fake-scratch-${scratches.length + 1}`), disposals: 0 };
    scratches.push(record);
    return { path: record.path, dispose: async () => { record.disposals++; } };
  };
  const spawnImpl = (command, args, spawnOptions) => {
    const record = { command, args, options: spawnOptions, stdin: '', kills: [], request: undefined };
    calls.push(record);
    if (options.spawnError) throw Object.assign(new Error('sensitive dependency diagnostic'), { code: options.spawnError });
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    record.child = child;
    child.stdin.on('data', data => { record.stdin += data; });
    child.kill = signal => {
      record.kills.push(signal);
      if (!options.neverExit) queueMicrotask(() => child.emit('close', null));
      return true;
    };
    child.stdin.once('finish', () => {
      queueMicrotask(async () => {
        if (args.includes('-c')) {
          if (options.badProbe) {
            child.stdout.write('invalid probe'); child.emit('close', 1); return;
          }
          child.stdout.write(JSON.stringify({ executable, version: [3, 13] }));
          child.emit('close', 0);
          return;
        }
        record.request = JSON.parse(record.stdin);
        await options.onRequest?.(record.request, record);
        if (options.hang) return;
        const response = options.response ?? (record.request.operation === 'status'
          ? { status: 'dependency_missing', network_used: false, runtime_ready: false }
          : record.request.directory
            ? { status: 'ok', document_file: join(record.request.directory, 'safe.' + record.request.format), warnings: [] }
            : { status: 'ok', output: record.request.out, caption_kind: 'manual', warnings: [] });
        child.stdout.write(options.rawStdout ?? JSON.stringify(response));
        child.emit('close', options.exitCode ?? (response.status === 'ok' ? 0 : 2));
      });
    });
    return child;
  };
  const runtime = createRuntime(config, { spawnImpl, root,
    accessImpl: async path => { accessCalls.push(path); throw new Error('not installed'); },
    getWorkspace: async execution => { workspaceCalls.push(execution); return workspace; },
    createScratchImpl,
    // 宿主托管的状态目录允许落在用户主目录；任务产物仍不得使用它。
    homedirImpl: () => home,
    tmpdirImpl: () => { throw Error('must not use global temp fallback'); },
    uuidImpl: () => `test-uuid-${++counter}`,
    platform: process.platform, terminateImpl: async child => { child.kill('SIGTERM'); return true; },
    ...options.dependencies });
  // Legacy cases exercise their original backend/auth/path behavior. New choice
  // gate cases instantiate createRuntime directly, without this fixture default.
  const extract = runtime.extract;
  runtime.extract = (args = {}, execution) => extract({ outputStyle: 'verbatim', ...args }, execution);
  return { runtime, calls, scratches, workspaceCalls, accessCalls, home,
    requests: () => calls.filter(call => !call.args.includes('-c')).map(call => call.request) };
}

function unavailableCloudConfig(mode = 'captions') {
  const config = { mode };
  for (const key of ['cloudEndpoint', 'cloudApiKey', 'cloudApiKeyFile', 'cloudModel', 'cloudUploadConsent', 'cloudMaxAudioMiB']) {
    Object.defineProperty(config, key, { enumerable: true, get() { throw new Error(`must not read ${key}`); } });
  }
  return config;
}

// A tiny schema recorder checks use of the native ABI without installing an SDK.
function fakeSchemastery() {
  const make = (kind, choices) => ({ kind, choices, default(value) { this.defaultValue = value; return this; },
    role(value) { this.roleValue = value; return this; },
    volatile() { this.live = true; return this; },
    description(value) { this.descriptionValue = value; return this; } });
  return { object: shape => ({ shape }), string: () => make('string'), boolean: () => make('boolean'),
    number: () => make('number'), union: choices => make('union', choices) };
}

const BILI_URL = 'https://www.bilibili.com/video/BV17K411P7hC/?p=28';
const SESSION = 'FAKE_MANAGED_BILI_SESSION_ONLY';
const ref = initial => ({ value: initial, get() { return this.value; }, set(value) { this.value = value; } });

test('native live refs change the next extraction without recreating runtime', async () => {
  const mode = ref('captions'), endpoint = ref('https://asr.example/v1/audio/transcriptions');
  const key = ref(KEY), consent = ref(false);
  const h = harness({ mode, cloudEndpoint: endpoint, cloudApiKey: key, cloudModel: ref('model'),
    cloudUploadConsent: consent });
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[0].config.mode, 'captions');
  assert.equal('cloudApiKey' in h.requests()[0].config, false);
  mode.set('cloud'); consent.set(true);
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[1].config.mode, 'cloud');
  assert.equal(h.requests()[1].config.cloudApiKey, KEY);
  assert.equal(h.requests()[1].config.cloudUploadConsent, true);
  assert.equal(h.requests()[1].config.cloudEndpoint, endpoint.value);
  mode.set('captions');
  key.get = () => { throw Error('captions must not read cloud key'); };
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[2].config.mode, 'captions');
  assert.equal('cloudApiKey' in h.requests()[2].config, false);
});

test('caption-only with volatile config never dereferences unselected ASR secrets or limits', async () => {
  const config = { mode: ref('cloud') };
  for (const field of ['cloudApiKey', 'cloudEndpoint', 'cloudUploadConsent', 'asrTimeout', 'localModelDir'])
    config[field] = { get() { throw Error('must not read ' + field); } };
  const h = harness(config);
  assert.equal((await h.runtime.extract({ target: 'abcdefghijk', captionsOnly: true })).status, 'ok');
  assert.equal(h.requests()[0].config.mode, 'captions');
});

test('an in-flight extraction keeps one settings snapshot while the next uses the saved values', async () => {
  const mode = ref('cloud'), key = ref(KEY), endpoint = ref('https://old.example/v1/audio/transcriptions');
  const pythonPath = ref(resolve('old-python.exe')), outputDir = ref(resolve('old-output'));
  let release;
  const gate = new Promise(resolveDone => { release = resolveDone; });
  const h = harness({ mode, cloudApiKey: key, cloudEndpoint: endpoint, cloudModel: ref('model'),
    pythonPath, outputDir }, { dependencies: { getBiliCredential: async () => { await gate; return { source: 'anonymous' }; } } });
  const pending = h.runtime.extract({ target: BILI_URL });
  mode.set('captions'); pythonPath.set(resolve('new-python.exe')); outputDir.set(resolve('new-output'));
  endpoint.set('https://new.example/v1/audio/transcriptions');
  release(); await pending;
  assert.equal(h.requests()[0].config.mode, 'cloud');
  assert.equal(h.requests()[0].config.cloudEndpoint, 'https://old.example/v1/audio/transcriptions');
  assert.ok(h.requests()[0].out.startsWith(resolve('old-output')));
  assert.equal(h.calls[0].command, resolve('old-python.exe'));
  await h.runtime.extract({ target: 'abcdefghijk' });
  assert.equal(h.requests()[1].config.mode, 'captions');
  assert.ok(h.requests()[1].out.startsWith(resolve('new-output')));
  assert.equal(h.calls[2].command, resolve('new-python.exe'));
});

test('setup snapshots live backend, state and proxy before asynchronous probing', async () => {
  const mode = ref('cloud'), state = ref(resolve('old-state')), proxy = ref('');
  const h = harness({ mode, stateDir: state, proxy });
  const pending = h.runtime.setup();
  mode.set('captions'); state.set(resolve('new-state')); proxy.set('http://127.0.0.1:8080');
  const first = await pending;
  assert.equal(first.status, 'setup_command_prepared');
  assert.equal(first.backend, 'cloud');
  assert.equal(first.state_dir, resolve('old-state'));
  assert.equal('local_model_dir' in first, false);
  assert.equal(first.command.includes('--model'), false);
  assert.equal(first.command.includes('--proxy'), false);
  const second = await h.runtime.setup();
  assert.equal(second.backend, 'captions');
  assert.equal(second.state_dir, resolve('new-state'));
  assert.equal('local_model_dir' in second, false);
  assert.equal(second.command.includes('--model'), false);
  assert.equal(second.command.includes('--proxy'), true);
});

test('volatile update refreshes declared tool timeout without disposing the active runtime', async () => {
  const mode = ref('captions'), listeners = {}, effects = [], active = new Map();
  let disposed = false, registrations = 0;
  const runtime = { status: async () => ({ status: 'test' }), extract: async () => ({ status: 'test' }),
    setup: async () => ({ status: 'test' }), dispose: async () => { disposed = true; } };
  const ctx = { tools: { register(definition) { registrations++; active.set(definition.name, definition);
    return () => { if (active.get(definition.name) === definition) active.delete(definition.name); }; } },
    on(name, callback) { listeners[name] = callback; }, effect(callback) { effects.push(callback()); },
    inject() {} };
  applyPlugin(ctx, { mode, registerSkill: false }, { defineTool: value => value, runtimeFactory: () => runtime });
  assert.equal(active.get('video_study_extract').timeoutMs, extractionBudgetMs({ mode: 'captions' }, 150));
  mode.set('cloud'); listeners['loader/volatile-update'](['mode']);
  assert.equal(active.get('video_study_extract').timeoutMs, extractionBudgetMs({ mode: 'cloud' }, 150));
  assert.equal(registrations, 8); assert.equal(active.size, 4); assert.equal(disposed, false);
  await effects[0](); assert.equal(disposed, true); assert.equal(active.size, 0);
});

test('managed Bilibili session travels only in private stdin, not argv or a cookie file', async () => {
  const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: {
    getBiliCredential: async () => ({ source: 'managed', sessdata: SESSION }) },
    response: { status: 'ok', echo: SESSION, sessdata: SESSION, qrUrl: 'private' } });
  const result = await h.runtime.extract({ target: BILI_URL, captionsOnly: true });
  assert.equal(result.status, 'ok');
  assert.equal(h.requests()[0].config.biliSessdata, SESSION);
  assert.equal(h.requests()[0].config.biliCookieFile, '');
  assert.ok(h.calls.every(call => !JSON.stringify(call.args).includes(SESSION)));
  assert.ok(!JSON.stringify(result).includes(SESSION));
  assert.equal('sessdata' in result, false); assert.equal('qrUrl' in result, false);
});

test('YouTube, status and setup do not ask for managed Bilibili credentials', async () => {
  const h = harness({}, { dependencies: { getBiliCredential: async () => { throw Error('must not read'); } } });
  assert.equal((await h.runtime.extract({ target: 'https://www.youtube.com/watch?v=abcdefghijk' })).status, 'ok');
  await h.runtime.status(); await h.runtime.setup();
  assert.ok(h.requests().every(request => !('biliSessdata' in request.config)));
});

test('logout anonymous selection disables configured old cookie file without another account fallback', async () => {
  const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: {
    getBiliCredential: async () => ({ source: 'anonymous' }) } });
  assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'ok');
  assert.equal(h.requests()[0].config.biliCookieFile, '');
  assert.equal('biliSessdata' in h.requests()[0].config, false);
});

test('legacy explicit file remains available only when auth service selects it', async () => {
  const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: {
    getBiliCredential: async () => ({ source: 'legacy_file' }) } });
  await h.runtime.extract({ target: BILI_URL });
  assert.equal(h.requests()[0].config.biliCookieFile, 'explicit-old-file.json');
});

test('expired managed or invalid credentials fail before Python without fallback', async () => {
  for (const credential of [{ source: 'managed' }, { source: 'managed', sessdata: 'bad;injected' }, { source: 'unexpected' }]) {
    const h = harness({ biliCookieFile: 'explicit-old-file.json' }, { dependencies: { getBiliCredential: async () => credential } });
    assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'login_required');
    assert.equal(h.calls.length, 0);
  }
});

test('private credential provider errors and timeouts do not expose raw text', async () => {
  for (const callback of [async () => { throw Error(SESSION); }, () => new Promise(() => {})]) {
    const h = harness({}, { dependencies: { getBiliCredential: callback, authTimeoutMs: 5 } });
    const result = await h.runtime.extract({ target: BILI_URL });
    assert.equal(result.status, 'login_required'); assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes(SESSION));
  }
});

test('lookalike Bilibili host does not obtain managed credentials', async () => {
  const h = harness({}, { dependencies: { getBiliCredential: async () => { throw Error('must not read'); } } });
  await h.runtime.extract({ target: 'https://www.bilibili.com.evil.example/video/BV17K411P7hC/' });
  assert.equal('biliSessdata' in h.requests()[0].config, false);
});

test('rejected request reports the exact old session privately for race-safe invalidation', async () => {
  const rejected = [];
  const h = harness({}, { dependencies: { getBiliCredential: async () => ({ source: 'managed', sessdata: SESSION }),
    onBiliRejected: async expected => rejected.push(expected) }, response: { status: 'login_required' } });
  assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'login_required');
  assert.deepEqual(rejected, [SESSION]);
});

test('tool parameters cannot supply managed sessions or drive login flows', async () => {
  for (const key of ['biliSessdata', 'flowId', 'qrUrl']) {
    const h = harness();
    assert.equal((await h.runtime.extract({ target: BILI_URL, [key]: SESSION })).status, 'invalid_input');
    assert.equal(h.calls.length, 0);
  }
});

test('host adapter resolves workspace only through execution agent and signal, never process cwd', async () => {
  let dependencies;
  const ensured = [], effects = [];
  const ctx = { workingDirectory: { async ensure(agent, signal) { ensured.push({ agent, signal }); return workspace; } },
    tools: { register() {} }, inject() {}, effect(callback) { effects.push(callback()); } };
  const runtime = { dispose: async () => {} };
  applyPlugin(ctx, { registerSkill: false }, { defineTool: value => value,
    storeFactory: () => ({}), authFactory: () => ({ dispose: async () => {} }),
    runtimeFactory(_config, deps) { dependencies = deps; return runtime; } });
  try {
    assert.equal(typeof dependencies.getWorkspace, 'function');
    const agent = { id: 'session-specific-agent' }, controller = new AbortController();
    assert.equal(await dependencies.getWorkspace({ agent, signal: controller.signal }), workspace);
    assert.deepEqual(ensured, [{ agent, signal: controller.signal }]);
    assert.equal(await dependencies.getWorkspace({}), null);
    assert.equal(ensured.length, 1);
  } finally { await effects[0](); }
});

test('workspace defaults are request-local for transcripts and documents, while the environment stays hosted', async () => {
  const execution = { agent: { id: 'workspace-agent' } };
  const h = harness();
  assert.equal((await h.runtime.extract({ target: 'abcdefghijk' }, execution)).status, 'ok');
  assert.equal((await h.runtime.exportDocument(exportArgs, execution)).status, 'ok');
  const setup = await h.runtime.setup({}, execution);
  assert.equal(setup.state_dir, hostedState);
  assert.equal(h.requests()[0].out, join(workspace, 'video-study', 'transcripts', 'dsh-video-study-test-uuid-1'));
  assert.equal(h.requests()[1].directory, join(workspace, 'video-study', 'documents'));
  assert.deepEqual(h.scratches.map(value => value.base), [join(workspace, 'video-study', 'transcripts'), join(workspace, 'video-study', 'documents')]);
  assert.ok(h.workspaceCalls.every(value => value === execution));
  assert.ok(h.accessCalls.every(value => value.startsWith(hostedState)));
  assert.ok(h.calls.every(value => value.options.cwd === workspace));
  assert.ok(h.scratches.every(value => value.disposals === 1));
});

test('two concurrent workspaces keep separate output, probe environment and cleanup', async () => {
  const a = resolve('workspace-A'), b = resolve('workspace-B');
  let releaseA, enteredA;
  const gateA = new Promise(done => { releaseA = done; });
  const startedA = new Promise(done => { enteredA = done; });
  const h = harness({}, { dependencies: { getWorkspace: async execution => execution.workspace },
    onRequest: async request => { if (request.target === 'aaaaaaaaaaa') { enteredA(); await gateA; } } });
  const first = h.runtime.extract({ target: 'aaaaaaaaaaa' }, { workspace: a });
  await startedA;
  try {
    assert.equal(h.scratches[0].disposals, 0);
    assert.equal((await h.runtime.extract({ target: 'bbbbbbbbbbb' }, { workspace: b })).status, 'ok');
    assert.equal(h.scratches[0].disposals, 0);
    assert.equal(h.scratches[1].disposals, 1);
    const [one, two] = h.requests();
    assert.equal(one.out.startsWith(join(a, 'video-study', 'transcripts')), true);
    assert.equal(two.out.startsWith(join(b, 'video-study', 'transcripts')), true);
    for (const base of [a, b]) {
      const scratch = h.scratches.find(value => value.base.startsWith(base));
      const calls = h.calls.filter(value => value.options.cwd === base);
      assert.equal(calls.length, 2);
      for (const call of calls) for (const key of ['TMP', 'TEMP', 'TMPDIR']) assert.equal(call.options.env[key], scratch.path);
    }
  } finally { releaseA(); await first; }
  assert.ok(h.scratches.every(value => value.disposals === 1));
});

test('switching workspaces on the same runtime updates all default paths on the next request', async () => {
  let selected = resolve('workspace-first');
  const h = harness({}, { dependencies: { getWorkspace: async () => selected } });
  for (const base of [resolve('workspace-first'), resolve('workspace-second')]) {
    selected = base;
    assert.equal((await h.runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
    assert.equal((await h.runtime.exportDocument(exportArgs)).status, 'ok');
    assert.equal((await h.runtime.setup()).state_dir, hostedState);
  }
  assert.deepEqual(h.requests().map(value => value.directory ?? resolve(value.out, '..')), [
    join(resolve('workspace-first'), 'video-study', 'transcripts'), join(resolve('workspace-first'), 'video-study', 'documents'),
    join(resolve('workspace-second'), 'video-study', 'transcripts'), join(resolve('workspace-second'), 'video-study', 'documents'),
  ]);
});

test('explicit output, document and state paths override workspace defaults independently', async () => {
  const outputDir = resolve('explicit-transcripts'), documentOutputDir = resolve('explicit-documents'), stateDir = resolve('explicit-state');
  const h = harness({ outputDir, documentOutputDir, stateDir });
  await h.runtime.extract({ target: 'abcdefghijk' }); await h.runtime.exportDocument(exportArgs);
  assert.equal((await h.runtime.setup()).state_dir, stateDir);
  assert.equal(resolve(h.requests()[0].out, '..'), outputDir);
  assert.equal(h.requests()[1].directory, documentOutputDir);
  assert.deepEqual(h.scratches.map(value => value.base), [outputDir, documentOutputDir]);
  assert.ok(h.accessCalls.every(value => value.startsWith(stateDir)));
  assert.ok(h.calls.every(value => value.options.cwd === workspace));
});

test('explicit paths work without session and use the selected base as child cwd', async () => {
  const outputDir = resolve('headless-transcripts'), documentOutputDir = resolve('headless-documents'), stateDir = resolve('headless-state');
  const h = harness({ outputDir, documentOutputDir, stateDir }, { dependencies: { getWorkspace: async () => null } });
  assert.equal((await h.runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal((await h.runtime.exportDocument(exportArgs)).status, 'ok');
  assert.equal((await h.runtime.setup()).state_dir, stateDir);
  assert.ok(h.calls.slice(0, 2).every(value => value.options.cwd === outputDir));
  assert.ok(h.calls.slice(2, 4).every(value => value.options.cwd === documentOutputDir));
  assert.equal(h.calls[4].args.includes('-c'), true);
});

test('missing workspace fails closed for task outputs but setup still prepares a command', async () => {
  const config = { mode: 'cloud' };
  for (const field of ['cloudApiKey', 'cloudApiKeyFile', 'cloudEndpoint', 'cloudUploadConsent', 'youtubeCookieFile', 'biliCookieFile'])
    Object.defineProperty(config, field, { get() { assert.fail('must not read ' + field); } });
  const h = harness(config, { dependencies: { getWorkspace: async () => null,
    getBiliCredential: async () => { assert.fail('must not read auth'); } } });
  assert.equal((await h.runtime.extract({ target: BILI_URL })).status, 'workspace_required');
  assert.equal((await h.runtime.exportDocument(exportArgs)).status, 'workspace_required');
  assert.equal(h.calls.length, 0); assert.equal(h.scratches.length, 0); assert.equal(h.accessCalls.length, 0);
  // 运行环境属于宿主安装而非任务产物，设置页没有会话也要能生成部署命令。
  const prepared = await h.runtime.setup();
  assert.equal(prepared.status, 'setup_command_prepared');
  assert.ok(isAbsolute(prepared.state_dir));
  assert.equal(h.scratches.length, 0);
});

test('unrelated explicit setting cannot authorize another operation default without workspace', async () => {
  for (const [operation, config, args] of [
    ['extract', { stateDir: resolve('explicit-state'), documentOutputDir: resolve('explicit-documents') }, { target: 'abcdefghijk' }],
    ['exportDocument', { stateDir: resolve('explicit-state'), outputDir: resolve('explicit-transcripts') }, exportArgs],
  ]) {
    const h = harness(config, { dependencies: { getWorkspace: async () => null } });
    assert.equal((await h.runtime[operation](args)).status, 'workspace_required');
    assert.equal(h.calls.length, 0); assert.equal(h.scratches.length, 0);
  }
  const h = harness({ outputDir: resolve('explicit-transcripts') }, { dependencies: { getWorkspace: async () => null } });
  assert.equal((await h.runtime.setup()).status, 'setup_command_prepared');
});

test('missing workspace provider, failed provider and relative provider result never fall back', async () => {
  for (const getWorkspace of [undefined, async () => { throw Error('PRIVATE_WORKSPACE_FAILURE'); }, async () => 'relative-workspace']) {
    const h = harness({}, { dependencies: { getWorkspace } });
    const result = await h.runtime.extract({ target: 'abcdefghijk' });
    assert.notEqual(result.status, 'ok');
    assert.equal(h.calls.length, 0); assert.equal(h.scratches.length, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE_WORKSPACE_FAILURE'), false);
  }
});

test('status without a session is offline, write-free and probes only the hosted managed venv', async () => {
  const h = harness(unavailableCloudConfig(), { dependencies: { getWorkspace: async () => null } });
  assert.equal((await h.runtime.status()).status, 'dependency_missing');
  assert.equal(h.scratches.length, 0);
  // 没有会话时状态目录回落到托管位置：只读探测该处解释器，找到就优先使用。
  assert.equal(h.accessCalls.length, 1); assert.ok(h.accessCalls[0].startsWith(hostedState));
  assert.equal(h.calls[0].command, process.platform === 'win32' ? 'python' : 'python3');
  const explicitState = resolve('headless-managed-state'), accessed = [];
  const configured = harness({ stateDir: explicitState }, { dependencies: { getWorkspace: async () => null,
    accessImpl: async path => { accessed.push(path); } } });
  await configured.runtime.status();
  assert.equal(accessed.length, 1); assert.ok(accessed[0].startsWith(explicitState));
  assert.equal(configured.calls[0].command, accessed[0]); assert.equal(configured.scratches.length, 0);
});

test('request-local temp env applies to probes and runner without changing global TMP settings', async () => {
  const before = Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(key => [key, process.env[key]]));
  const h = harness();
  for (const [operation, args] of [['extract', { target: 'abcdefghijk' }], ['exportDocument', exportArgs]]) {
    const start = h.calls.length;
    assert.equal((await h.runtime[operation](args)).status, 'ok');
    const scratch = h.scratches.at(-1);
    for (const call of h.calls.slice(start)) {
      assert.notEqual(call.options.env, process.env);
      for (const key of ['TMP', 'TEMP', 'TMPDIR']) assert.equal(call.options.env[key], scratch.path);
      const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
      if (pathKey) assert.equal(call.options.env[pathKey], process.env[pathKey]);
    }
    assert.equal(scratch.disposals, 1);
  }
  assert.deepEqual(Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(key => [key, process.env[key]])), before);
});

test('scratch write denial never retries in home, global temp or another output base', async () => {
  for (const operation of ['extract', 'exportDocument']) {
    const attempted = [];
    const h = harness({}, { dependencies: { createScratchImpl: async base => {
      attempted.push(base); throw Object.assign(Error('PRIVATE_SCRATCH_FAILURE'), { code: 'EACCES' });
    } } });
    const result = await h.runtime[operation](operation === 'extract' ? { target: 'abcdefghijk' } : exportArgs);
    assert.notEqual(result.status, 'ok'); assert.equal(h.calls.length, 0);
    assert.deepEqual(attempted, [join(workspace, 'video-study', operation === 'extract' ? 'transcripts' : 'documents')]);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SCRATCH_FAILURE'), false);
  }
});

test('scratch is disposed on bad probe, spawn errors, bad JSON and runner failures', async () => {
  for (const options of [{ badProbe: true }, { spawnError: 'EACCES' }, { rawStdout: 'invalid JSON' },
    { response: { status: 'network_error' } }, { response: { status: 'ok' }, exitCode: 1 }]) {
    for (const [operation, args] of [['extract', { target: 'abcdefghijk' }], ['exportDocument', exportArgs]]) {
      const h = harness({}, options);
      assert.notEqual((await h.runtime[operation](args)).status, 'ok');
      assert.equal(h.scratches.length, 1); assert.equal(h.scratches[0].disposals, 1);
    }
  }
});

test('confirmed extraction and export cancellation disposes only after tree termination', async () => {
  for (const [operation, args] of [['extract', { target: 'abcdefghijk' }], ['exportDocument', exportArgs]]) {
    const controller = new AbortController();
    let started, release;
    const terminating = new Promise(done => { started = done; });
    const gate = new Promise(done => { release = done; });
    const h = harness({}, { hang: true, onRequest() { controller.abort(); }, dependencies: {
      terminateImpl: async child => { child.kill('SIGTERM'); started(); await gate; return true; },
    } });
    const pending = h.runtime[operation](args, { signal: controller.signal });
    await terminating;
    try { assert.equal(h.scratches[0].disposals, 0); }
    finally { release(); }
    assert.equal((await pending).status, 'cancelled'); assert.equal(h.scratches[0].disposals, 1);
  }
});

test('unconfirmed parent or descendant termination retains scratch and warns for both operations', async () => {
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    for (const neverExit of [false, true]) for (const [operation, args] of [['extract', { target: 'abcdefghijk' }], ['exportDocument', exportArgs]]) {
      const controller = new AbortController();
      const h = harness({}, { hang: true, neverExit, onRequest() { controller.abort(); }, dependencies: {
        timeoutScale: 0.0001, terminateImpl: async child => { child.kill('SIGTERM'); return false; },
      } });
      const result = await h.runtime[operation](args, { signal: controller.signal });
      assert.equal(result.status, 'cancelled'); assert.equal(h.scratches.length, 1);
      assert.equal(h.scratches[0].disposals, 0);
      assert.ok(result.warnings?.some(value => /临时|scratch/i.test(value)));
    }
  } finally { clearTimeout(keepAlive); }
});

test('setup never creates scratch or writes temp environment, even with explicit headless state', async () => {
  for (const getWorkspace of [async () => workspace, async () => null]) {
    const h = harness({ stateDir: resolve('manual-setup-state') }, { dependencies: { getWorkspace,
      createScratchImpl: async () => { assert.fail('setup must not create scratch'); } } });
    assert.equal((await h.runtime.setup()).status, 'setup_command_prepared');
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args.includes('-c'), true);
  }
});

test('defaults are portable, captions-only and do not authorize upload', () => {
  assert.equal(DEFAULTS.mode, 'captions');
  assert.equal(DEFAULTS.cloudUploadConsent, false);
  for (const field of ['localModel', 'localModelDir', 'localDevice', 'localComputeType'])
    assert.equal(field in DEFAULTS, false);
  assert.equal(DEFAULTS.defaultLanguage, 'auto');
  assert.equal(JSON.stringify(DEFAULTS).includes('enana'), false);
});

test('native Config exposes live mode and secret fields without losing the secret UI role', () => {
  const schema = createConfig(fakeSchemastery()).shape;
  assert.deepEqual(schema.mode.choices, ['captions', 'cloud']);
  for (const field of ['localModel', 'localModelDir', 'localDevice', 'localComputeType'])
    assert.equal(field in schema, false);
  assert.equal(schema.mode.defaultValue, 'captions');
  assert.equal(schema.cloudApiKey.roleValue, 'secret');
  for (const name of ['mode', 'defaultLanguage', 'cloudApiKey', 'cloudUploadConsent', 'pythonPath'])
    assert.equal(schema[name].live, true);
  assert.equal(schema.cloudUploadConsent.defaultValue, false);
  for (const field of ['pythonPath', 'stateDir', 'outputDir', 'cloudEndpoint', 'cloudApiKeyFile', 'proxy'])
    assert.equal(schema[field].defaultValue, '');
  assert.equal(schema.defaultLanguage.defaultValue, 'auto');
  for (const name of ['mode', 'cloudEndpoint', 'cloudUploadConsent'])
    assert.equal(typeof schema[name].descriptionValue, 'string');
});

test('status is an offline runner request without cloud credential access in captions mode', async () => {
  const { runtime, calls, requests } = harness(unavailableCloudConfig());
  const result = await runtime.status({});
  assert.equal(result.status, 'dependency_missing');
  assert.equal(result.network_used, false);
  assert.equal(result.runtime_ready, false);
  const request = requests()[0];
  assert.equal(request.operation, 'status');
  assert.equal(request.config.mode, 'captions');
  assert.equal('cloudApiKey' in request.config, false);
  assert.equal('localModelDir' in request.config, false);
  assert.equal('target' in request, false);
  assert.equal('out' in request, false);
  assert.equal(calls.every(call => call.options.shell === false), true);
  assert.equal(calls.every(call => call.options.stdio[2] === 'ignore'), true);
});

test('captionsOnly is a one-way restriction and never reads cloud getters', async () => {
  const { runtime, requests } = harness(unavailableCloudConfig('cloud'));
  const result = await runtime.extract({ target: 'abcdefghijk', captionsOnly: true });
  assert.equal(result.status, 'ok');
  assert.equal(requests()[0].config.mode, 'captions');
  assert.equal(requests()[0].captionsOnly, true);
});

test('local backend is rejected before Python or cloud credential access', async () => {
  for (const operation of ['extract', 'status', 'setup']) {
    const { runtime, calls } = harness(unavailableCloudConfig('local'));
    const result = await runtime[operation](operation === 'extract' ? { target: 'abcdefghijk' } : {});
    assert.equal(result.status, 'invalid_config');
    assert.equal(calls.length, 0);
  }
});

test('no tool argument can opt into cloud or provide a secret/output override', async () => {
  for (const extra of [{ mode: 'cloud' }, { cloudApiKey: KEY }, { out: resolve('bad-output') }, { config: { mode: 'cloud' } }]) {
    const { runtime, calls } = harness();
    const result = await runtime.extract({ target: 'abcdefghijk', ...extra });
    assert.equal(result.status, 'invalid_input');
    assert.equal(calls.length, 0);
  }
});

test('forceAsr in captions mode is rejected before Python/network activity', async () => {
  const { runtime, calls } = harness();
  assert.equal((await runtime.extract({ target: 'abcdefghijk', forceAsr: true })).status, 'mode_restricted');
  assert.equal(calls.length, 0);
});

test('captionsOnly plus forceAsr cannot escape configured ASR restrictions', async () => {
  const { runtime, calls } = harness({ mode: 'cloud' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk', forceAsr: true, captionsOnly: true })).status, 'mode_restricted');
  assert.equal(calls.length, 0);
});

test('cloud forced ASR requires consent independently of mode', async () => {
  const { runtime, calls } = harness({ mode: 'cloud', cloudApiKey: KEY, cloudUploadConsent: false });
  const result = await runtime.extract({ target: 'abcdefghijk', forceAsr: true });
  assert.equal(result.status, 'upload_consent_required');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('cloud without consent still permits ordinary existing-caption extraction', async () => {
  const { runtime, requests } = harness({ mode: 'cloud', cloudUploadConsent: false });
  const result = await runtime.extract({ target: 'abcdefghijk' });
  assert.equal(result.status, 'ok');
  assert.equal(requests()[0].config.cloudUploadConsent, false);
  assert.equal(requests()[0].forceAsr, false);
});

test('unconfigured cloud backend does not preflight models/endpoints before valid captions', async () => {
  for (const config of [
    { mode: 'cloud', cloudEndpoint: 'not-a-usable-endpoint', cloudModel: '', cloudApiKeyFile: 'missing-keyfile', cloudUploadConsent: false },
  ]) {
    const { runtime, requests } = harness(config);
    assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
    assert.equal(requests().length, 1);
    assert.equal(requests()[0].operation, 'extract');
    assert.equal(requests()[0].forceAsr, false);
  }
});

test('cloud audio size is preserved for Python fallback validation, not enforced before captions', async () => {
  const accepted = harness({ mode: 'cloud', cloudMaxAudioMiB: 512 });
  assert.equal((await accepted.runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal(accepted.requests()[0].config.cloudMaxAudioMiB, 512);
  const caption = harness({ mode: 'cloud', cloudMaxAudioMiB: 513 });
  assert.equal((await caption.runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal(caption.requests()[0].config.cloudMaxAudioMiB, 513);
  const denied = harness({ mode: 'cloud', cloudMaxAudioMiB: 513 }, { response: { status: 'invalid_input', success: false } });
  assert.equal((await denied.runtime.status({})).status, 'invalid_input');
  assert.equal(denied.requests()[0].config.cloudMaxAudioMiB, 513);
});

test('zero, negative and relative-state ASR settings cannot block existing captions', async () => {
  const fixtures = [
    { mode: 'captions', asrTimeout: 0, downloadTimeout: -1, maxDuration: -1,
      stateDir: 'relative-state', cloudMaxAudioMiB: 0 },
    { mode: 'cloud', asrTimeout: 0, downloadTimeout: -1, maxDuration: 0,
      stateDir: 'relative-state', cloudMaxAudioMiB: -1, cloudEndpoint: null, cloudModel: null },
  ];
  for (const config of fixtures) {
    const { runtime, requests } = harness(config);
    const result = await runtime.extract({ target: 'abcdefghijk' });
    assert.equal(result.status, 'ok', JSON.stringify(config));
    assert.equal(result.caption_kind, 'manual');
    const forwarded = requests()[0].config;
    if (config.mode === 'captions') {
      for (const field of ['asrTimeout', 'downloadTimeout', 'maxDuration', 'localModel', 'cloudMaxAudioMiB'])
        assert.equal(field in forwarded, false);
    } else {
      for (const field of ['asrTimeout', 'downloadTimeout', 'maxDuration'])
        assert.equal(forwarded[field], config[field]);
      assert.equal(forwarded.cloudMaxAudioMiB, -1);
    }
  }
});

test('caption-only ignores backend-only limit/model getters and unusable managed state', async () => {
  const config = unavailableCloudConfig();
  for (const key of ['asrTimeout', 'downloadTimeout', 'maxDuration', 'localModel', 'localModelDir', 'localDevice', 'localComputeType', 'stateDir'])
    Object.defineProperty(config, key, { get() { throw new Error(`must not read backend setting ${key}`); } });
  const { runtime, requests } = harness(config);
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.deepEqual(Object.keys(requests()[0].config).sort(), ['mode', 'proxy', 'youtubeCookieFile', 'biliCookieFile'].sort());
});

test('safe default scheduling does not validate ASR or read it for caption-only', () => {
  assert.equal(extractionBudgetMs({ mode: 'cloud', downloadTimeout: -1, asrTimeout: 0 }), 7620000);
  assert.equal(extractionBudgetMs({ mode: 'cloud', downloadTimeout: NaN, asrTimeout: 'bad' }), 7620000);
  const captions = { mode: 'captions', get asrTimeout() { throw new Error('unrelated'); },
    get downloadTimeout() { throw new Error('unrelated'); } };
  assert.equal(extractionBudgetMs(captions), 420000);
  assert.equal(createToolDefinitions(captions, {})[1].timeoutMs, 450000);
  assert.equal(createToolDefinitions({ mode: 'cloud', asrTimeout: 0, downloadTimeout: -1 }, {})[1].timeoutMs, 7650000);
});

test('relative stateDir skips only managed discovery, while setup remains strict', async () => {
  const { runtime, calls } = harness({ stateDir: 'relative-state' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'ok');
  assert.equal(calls[0].command, process.platform === 'win32' ? 'python' : 'python3');
  assert.equal((await runtime.setup({})).status, 'invalid_config');
});

test('backend invalid settings are forwarded unmodified and Python failures pass through', async () => {
  const { runtime, requests } = harness({ mode: 'cloud', cloudUploadConsent: true,
    asrTimeout: 0, maxDuration: -1, cloudMaxAudioMiB: 0 }, { response: { status: 'invalid_input', success: false } });
  const result = await runtime.extract({ target: 'abcdefghijk', forceAsr: true });
  assert.equal(result.status, 'invalid_input');
  assert.equal(requests()[0].config.asrTimeout, 0);
  assert.equal(requests()[0].config.cloudMaxAudioMiB, 0);
  assert.equal(requests()[0].forceAsr, true);
});

test('cloud secret is stdin-only; keyfile is forwarded as path without being read', async () => {
  const { runtime, calls, requests } = harness({ mode: 'cloud', cloudApiKey: KEY,
    cloudApiKeyFile: resolve('explicit-nonexistent-keyfile'), cloudUploadConsent: true,
    cloudEndpoint: 'https://api.example.invalid/v1', cloudModel: 'whisper-1' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk', forceAsr: true })).status, 'ok');
  const request = requests()[0];
  assert.equal(request.config.cloudApiKey, KEY);
  assert.equal(request.config.cloudApiKeyFile, resolve('explicit-nonexistent-keyfile'));
  assert.equal(calls.some(call => call.args.join(' ').includes(KEY)), false);
  assert.equal(calls.some(call => call.args.join(' ').includes('api.example.invalid')), false);
  assert.equal(calls[1].args[0], '-B');
  assert.equal(calls[1].args[1], join(root, 'python', 'runner.py'));
  assert.equal(calls[1].args.length, 2);
});

test('runner result cannot expose key or signed URLs, even in nested errors', async () => {
  const response = { status: 'network_error', api_key: KEY,
    message: `failure ${KEY} at https://cdn.example.invalid/media?signature=SENSITIVE`,
    source_url: 'https://www.youtube.com/watch?v=abcdefghijk&signature=SENSITIVE',
    nested: { authorization: `Bearer ${KEY}`, raw: KEY, signature: 'SENSITIVE' } };
  const { runtime } = harness({ mode: 'cloud', cloudApiKey: KEY }, { response });
  const result = await runtime.extract({ target: 'abcdefghijk' });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes('SENSITIVE'), false);
  assert.equal(serialized.includes('cdn.example.invalid'), false);
  assert.equal(result.source_url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal('authorization' in result.nested, false);
});

test('new absolute unique output names are generated without mkdir/overwriting', async () => {
  const base = join(tmpdir(), `video-study-test-${Date.now()}`);
  const { runtime, requests } = harness({ outputDir: base });
  await runtime.extract({ target: 'abcdefghijk' });
  await runtime.extract({ target: 'abcdefghijk' });
  const [first, second] = requests();
  assert.equal(isAbsolute(first.out), true);
  assert.equal(first.out, join(base, 'dsh-video-study-test-uuid-1'));
  assert.notEqual(first.out, second.out);
  await assert.rejects(access(base));
  assert.equal(first.language, 'auto');
});

test('configured default language is honored, explicit selection overrides it', async () => {
  const { runtime, requests } = harness({ defaultLanguage: 'en' });
  await runtime.extract({ target: 'abcdefghijk' });
  await runtime.extract({ target: 'abcdefghijk', language: 'zh' });
  assert.deepEqual(requests().map(request => request.language), ['en', 'zh']);
});

test('relative outputDir is refused without running the runner', async () => {
  const { runtime, requests } = harness({ outputDir: 'relative-output' });
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'invalid_config');
  assert.equal(requests().length, 0);
});

test('automatic Python discovery never binds to the original D drive venv', async () => {
  const { runtime, calls } = harness();
  await runtime.status({});
  assert.equal(calls[0].args.includes('-c'), true);
  assert.equal(calls[1].command, executable);
  assert.equal(JSON.stringify(calls.map(({ command, args }) => ({ command, args }))).includes('D:\\project'), false);
});

test('explicit Python path with spaces stays a single executable, no shell parsing', async () => {
  const custom = join(tmpdir(), 'Python with spaces', 'python.exe');
  const { runtime, calls } = harness({ pythonPath: custom });
  await runtime.status({});
  assert.equal(calls[0].command, custom);
  assert.equal(calls[0].options.shell, false);
});

test('py -3 compatibility uses separate argv rather than a shell command', async () => {
  const { runtime, calls } = harness({ pythonPath: 'py -3' });
  await runtime.status({});
  assert.equal(calls[0].command, 'py');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-3', '-B', '-c']);
});

test('managed environment is probed before system executables', async () => {
  const managed = process.platform === 'win32'
    ? join(hostedState, 'venv', 'Scripts', 'python.exe')
    : join(hostedState, 'venv', 'bin', 'python');
  const { runtime, calls } = harness({}, { dependencies: { accessImpl: async () => {} } });
  await runtime.status({});
  assert.equal(calls[0].command, managed);
});

test('missing Python returns dependency_missing and never installs anything', async () => {
  const { runtime, calls } = harness({}, { spawnError: 'ENOENT' });
  const result = await runtime.status({});
  assert.equal(result.status, 'dependency_missing');
  assert.equal(calls.length, 3);
  assert.equal(calls.every(call => call.args.includes('-c')), true);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('explicit missing Python does not silently switch interpreters', async () => {
  const { runtime, calls } = harness({ pythonPath: 'custom-python' }, { spawnError: 'ENOENT' });
  assert.equal((await runtime.status({})).status, 'dependency_missing');
  assert.equal(calls.length, 1);
});

test('invalid stdout is not exposed and cannot be treated as successful extraction', async () => {
  const { runtime } = harness({}, { rawStdout: `debug ${KEY} https://bad.invalid/?signature=SECRET` });
  const result = await runtime.extract({ target: 'abcdefghijk' });
  assert.equal(result.status, 'runner_failed');
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('nonzero runner exit cannot return a success marker', async () => {
  const { runtime } = harness({}, { response: { status: 'ok' }, exitCode: 1 });
  assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, 'runner_failed');
});

test('network and permission errors pass through without retry or backend switch', async () => {
  for (const status of ['network_error', 'login_required', 'rate_limited', 'platform_restricted']) {
    const { runtime, requests } = harness({ mode: 'cloud' }, { response: { status, success: false } });
    assert.equal((await runtime.extract({ target: 'abcdefghijk' })).status, status);
    assert.equal(requests().length, 1);
    assert.equal(requests()[0].config.mode, 'cloud');
  }
});

test('pre-aborted tool calls never spawn', async () => {
  const controller = new AbortController(); controller.abort();
  const { runtime, calls } = harness();
  assert.equal((await runtime.status({}, { signal: controller.signal })).status, 'cancelled');
  assert.equal(calls.length, 0);
});

test('cancellation terminates child and waits for close rather than exposing partial output', async () => {
  const controller = new AbortController();
  const { runtime, calls } = harness({}, { hang: true, onRequest() { controller.abort(); } });
  const result = await runtime.status({}, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(calls[1].kills, ['SIGTERM']);
  assert.equal(result.success, false);
});

test('parent close does not finish cancellation before process-tree termination completes', async () => {
  const controller = new AbortController();
  let release;
  let killStarted;
  const started = new Promise(resolveDone => { killStarted = resolveDone; });
  const gate = new Promise(resolveDone => { release = resolveDone; });
  const { runtime } = harness({}, { hang: true, onRequest() { controller.abort(); },
    dependencies: { terminateImpl: async child => { child.kill('SIGTERM'); killStarted(); await gate; return true; } } });
  let settled = false;
  const pending = runtime.status({}, { signal: controller.signal }).then(result => { settled = true; return result; });
  await started;
  await new Promise(resolveDone => setImmediate(resolveDone));
  assert.equal(settled, false);
  release();
  assert.equal((await pending).status, 'cancelled');
});

test('hard process deadline covers a hung runner', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const { runtime, calls } = harness({}, { hang: true, dependencies: { timeoutScale: 0.0001 } });
    const result = await runtime.status({});
    assert.equal(result.status, 'timeout');
    assert.deepEqual(calls[1].kills, ['SIGTERM']);
  } finally { clearTimeout(keepAlive); }
});

test('unconfirmed child exit is an explicit failure, never a cleanup claim', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const { runtime, calls } = harness({}, { hang: true, neverExit: true, dependencies: { timeoutScale: 0.0001 } });
    const result = await runtime.status({});
    assert.equal(result.status, 'timeout');
    assert.equal(result.success, false);
    assert.equal(result.warnings.some(warning => warning.includes('退出未确认')), true);
    assert.equal(result.warnings.some(warning => warning.includes('finally')), true);
    assert.deepEqual(calls[1].kills, ['SIGTERM', 'SIGKILL']);
  } finally { clearTimeout(keepAlive); }
});

test('stdout size limit terminates process rather than leaking arbitrary child logs', async () => {
  const { runtime, calls } = harness({}, { rawStdout: 'x'.repeat(4 * 1024 * 1024 + 1) });
  const result = await runtime.status({});
  assert.equal(result.status, 'output_limit');
  assert.deepEqual(calls[1].kills, ['SIGTERM']);
});

test('dispose cancels every active Python operation', async () => {
  let entered;
  const pending = new Promise(resolveDone => { entered = resolveDone; });
  const { runtime } = harness({}, { hang: true, onRequest() { entered(); } });
  const work = runtime.status({});
  await pending;
  await runtime.dispose();
  assert.equal((await work).status, 'cancelled');
});

test('setup returns only an explicit manual command, never invokes setup script', async () => {
  const { runtime, calls } = harness({ mode: 'cloud', proxy: 'http://127.0.0.1:7897' });
  const result = await runtime.setup({ backend: 'cloud' });
  assert.equal(result.status, 'setup_command_prepared');
  assert.equal(result.executed, false);
  assert.match(result.command, /--allow-downloads/);
  assert.match(result.command, /setup_environment\.py/);
  assert.match(result.command, /--backend/);
  assert.equal(result.command.includes('--model'), false);
  assert.equal(result.backend, 'cloud');
  assert.match(result.command, /http:\/\/127\.0\.0\.1:7897/);
  assert.equal(result.state_dir, hostedState);
  assert.equal('local_model_dir' in result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('-c'), true);
  assert.equal(result.command.includes(KEY), false);
});

test('localDefaults exposes only platform and the hosted install location without probing', () => {
  const config = unavailableCloudConfig('cloud');
  for (const field of ['localModel', 'localModelDir', 'localDevice', 'localComputeType'])
    Object.defineProperty(config, field, { enumerable: true, get() { throw new Error('removed setting read'); } });
  const { runtime, calls } = harness(config);
  assert.deepEqual(runtime.localDefaults(), { platform: process.platform, stateDir: hostedState });
  assert.equal(calls.length, 0);
});

test('setup rejects local backend and every model argument before probing', async () => {
  for (const args of [{ backend: 'local' }, { model: 'tiny' }, { backend: 'cloud', model: 'small' }]) {
    const { runtime, calls } = harness(unavailableCloudConfig('cloud'));
    const result = await runtime.setup(args);
    assert.equal(result.status, 'invalid_input');
    assert.equal('command' in result, false);
    assert.equal('local_model_dir' in result, false);
    assert.equal(calls.length, 0);
  }
});

test('setup never reads cloud credentials and refuses credentialed/socks proxy commands', async () => {
  assert.equal((await harness(unavailableCloudConfig()).runtime.setup({ backend: 'cloud' })).status, 'setup_command_prepared');
  for (const proxy of ['socks5://127.0.0.1:9', 'http://user:password@127.0.0.1:9', 'http://127.0.0.1:9/?secret=x']) {
    const { runtime } = harness({ proxy });
    const result = await runtime.setup({});
    assert.equal(result.status, 'invalid_config');
    assert.equal('command' in result, false);
  }
});

test('Windows tree termination uses fixed argv and no shell', async () => {
  const calls = [];
  const child = { pid: 42, kill() {} };
  await terminateProcessTree(child, 'win32', (command, args, options) => {
    calls.push({ command, args, options });
    const killer = new EventEmitter(); killer.kill = () => {};
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  });
  assert.equal(calls[0].command, 'taskkill.exe');
  assert.deepEqual(calls[0].args, ['/PID', '42', '/T', '/F']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, 'ignore');
});

test('real process cancellation reaps the runner and its spawned descendant offline', { timeout: 15000 }, async t => {
  // Real OS processes, but a Node protocol fixture substitutes for Python. No
  // package setup, model, media, cloud call or temporary fixture file is needed.
  const controller = new AbortController();
  let runner;
  let descendantPid;
  const adapterSpawn = (command, args, spawnOptions) => {
    if (command === 'taskkill.exe') return realSpawn(command, args, spawnOptions);
    const probe = args.includes('-c');
    const code = probe
      ? `process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({executable:process.execPath,version:[3,13]})))`
      : `const {spawn}=require('node:child_process'); process.stdin.resume(); process.stdin.on('end',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({descendantPid:child.pid})); setInterval(()=>{},1000);});`;
    const child = realSpawn(process.execPath, ['-e', code], spawnOptions);
    if (!probe) {
      runner = child;
      child.stdout.once('data', chunk => {
        descendantPid = JSON.parse(chunk.toString()).descendantPid;
        controller.abort();
      });
    }
    return child;
  };
  t.after(async () => {
    if (runner && runner.exitCode === null && runner.signalCode === null)
      await terminateProcessTree(runner, process.platform, realSpawn);
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
  });
  const runtime = createRuntime({}, { spawnImpl: adapterSpawn,
    getWorkspace: async () => null,
    createScratchImpl: async () => { throw Error('status must not create scratch'); },
    accessImpl: async () => { throw new Error('no managed fixture'); } });
  const result = await runtime.status({}, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(Number.isInteger(descendantPid), true);
  assert.notEqual(runner.exitCode === null && runner.signalCode === null, true);
  assert.throws(() => process.kill(descendantPid, 0));
  assert.equal(result.warnings.some(warning => warning.includes('finally')), true);
});

test('registration exposes four focused tools and no API key schema input', async () => {
  const registered = [];
  let dispose;
  let provider;
  const runtime = { status: async () => ({ status: 'test' }), extract: async () => ({ status: 'test' }),
    setup: async () => ({ status: 'test' }), dispose: async () => { dispose = true; } };
  const effects = [];
  const ctx = { tools: { register(tool) { registered.push(tool); } },
    effect(callback) { effects.push(callback()); },
    inject(names, callback) {
      if (names[0] === 'directoryPicker') return; // optional on headless/CLI hosts
      if (names[0] === 'connection') { callback({}); return; }
      assert.deepEqual(names, ['skills']); callback({ skills: { registerProvider(getter) { provider = getter(); } } });
    } };
  applyPlugin(ctx, {}, { defineTool: value => value, runtimeFactory: () => runtime, rank: 600 });
  assert.deepEqual(registered.map(tool => tool.name), ['video_study_status', 'video_study_extract', 'video_study_export', 'video_study_setup']);
  assert.equal(registered.some(tool => JSON.stringify(tool.parameters).includes('ApiKey')), false);
  assert.equal((await provider.list())[0].name, 'video-study');
  assert.equal((await provider.list())[0].rank, 600);
  assert.equal((await registered[0].execute({}, {})).status, 'test');
  await effects[0]();
  assert.equal(dispose, true);
});

test('skill provider refers only to the package-relative skill, avoiding old global names', async () => {
  const provider = createSkillProvider();
  const [candidate] = await provider.list();
  assert.equal(candidate.name, 'video-study');
  assert.equal(candidate.provider, 'dsh-video-study');
  assert.equal(basename(candidate.resourceBase.path), 'video-study');
  assert.match(candidate.locator.pathname, /skills\/video-study\/SKILL\.md$/);
});

test('tool schema describes disabling-only captionsOnly and safe setup', () => {
  const definitions = createToolDefinitions({}, {});
  const extract = definitions[1];
  assert.equal('mode' in extract.parameters, false);
  assert.equal('cloudUploadConsent' in extract.parameters, false);
  assert.equal('out' in extract.parameters, false);
  assert.deepEqual(extract.parameters.language.enum, ['en', 'zh', 'auto']);
  assert.equal(definitions[2].name, 'video_study_export');
  assert.match(definitions[2].description, /一个最终文件/);
  assert.match(definitions[2].description, /识别字幕→改正字幕/);
  assert.match(definitions[2].parameters.markdown.description, /不写补全理论或防御性长备注/);
  assert.deepEqual(Object.keys(definitions[2].parameters), ['title', 'markdown', 'sourceUrl']);
  assert.equal(definitions[3].name, 'video_study_setup');
  assert.deepEqual(Object.keys(definitions[3].parameters), ['backend']);
  assert.deepEqual(definitions[3].parameters.backend.enum, ['captions', 'cloud']);
  assert.equal(definitions[0].timeoutMs, 45000);
});

test('native SDK entry remains a thin import adapter, not a runtime installer', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /@deepseek-ai\/schemastery/);
  assert.match(source, /@deepseek-ai\/dsh-tools/);
  assert.match(source, /@deepseek-ai\/dsh-skill/);
  assert.match(source, /export const name = 'video-study'/);
  assert.equal(source.includes('npm install'), false);
});

test('sanitizer ignores prototype-shaped fields in untrusted runner data', () => {
  const result = sanitizeResult(JSON.parse('{"status":"ok","__proto__":{"polluted":true},"constructor":{"secret":"bad"}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.polluted, undefined);
  assert.equal(Object.hasOwn(result, 'constructor'), false);
});

test('recursive sanitizer drops credential-shaped keys, keeps public Bilibili identity', () => {
  const result = sanitizeResult({ nested: { cloudApiKeyFile: 'private', signed_url: 'bad', value: KEY },
    source_url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&token=SECRET' }, [KEY]);
  assert.equal(result.nested.value, '[redacted]');
  assert.equal('cloudApiKeyFile' in result.nested, false);
  assert.equal(result.source_url, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
});

const hostedState = join(home, '.dsh', 'state', 'dsh-video-study');
const venvPython = join(hostedState, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function installHarness(options = {}) {
  const calls = [], scratch = { path: join(workspace, '.fake-install-scratch'), bases: [], disposals: 0 };
  const spawnImpl = (command, args, spawnOptions) => {
    const record = { command, args, options: spawnOptions };
    calls.push(record);
    const child = new EventEmitter();
    child.pid = 4321; child.stdout = new PassThrough(); child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.once('finish', () => queueMicrotask(async () => {
      if (args.some(arg => arg.includes('importlib'))) {
        const probe = options.dependencies ?? { ytDlp: true, docx: true };
        child.stdout.write(JSON.stringify(probe)); child.emit('close', 0); return;
      }
      if (args.includes('-c')) {
        child.stdout.write(JSON.stringify({ executable, version: [3, 13] })); child.emit('close', 0); return;
      }
      if (options.progress) child.stderr.write(options.progress);
      if (options.hold) await options.hold;
      const script = options.scriptResult ?? { status: 'prepared_not_runtime_verified', python: venvPython,
        state_dir: hostedState };
      child.stdout.write(typeof script === 'string' ? script : JSON.stringify(script));
      child.emit('close', options.exitCode ?? 0);
    }));
    return child;
  };
  const runtime = createRuntime({ mode: 'cloud', ...options.config }, { spawnImpl, root,
    accessImpl: async () => { throw new Error('not installed'); },
    getWorkspace: async () => workspace,
    createScratchImpl: async base => { scratch.bases.push(base);
      return { path: scratch.path, dispose: async () => { scratch.disposals += 1; } }; },
    homedirImpl: () => home,
    tmpdirImpl: () => { throw Error('must not use global temp fallback'); },
    uuidImpl: () => 'install-uuid', platform: process.platform,
    terminateImpl: async child => { child.kill('SIGTERM'); return true; }, ...options.dependencies });
  return { runtime, calls, scratch, home,
    scripts: () => calls.filter(record => record.args.some(arg => arg.endsWith(join('python', 'setup_environment.py')))) };
}

async function settled(runtime) {
  for (let step = 0; step < 400; step += 1) {
    const status = runtime.setupInstallStatus();
    if (status.status !== 'setup_running') return status;
    await new Promise(resolveDone => setImmediate(resolveDone));
  }
  return runtime.setupInstallStatus();
}

test('one click install refuses a custom interpreter before any process or write', async () => {
  const f = installHarness({ config: { pythonPath: '/custom/python3' } });
  const result = await f.runtime.setupInstall({}, {});
  assert.equal(result.status, 'custom_python_configured');
  assert.match(result.message, /自定义 Python/);
  assert.equal(f.calls.length, 0); assert.equal(f.scratch.bases.length, 0);
  assert.equal(f.runtime.setupInstallStatus().status, 'idle');
});

test('one click install runs the plugin setup CLI against the hosted state without a scratch dir', async () => {
  const f = installHarness();
  const started = await f.runtime.setupInstall({}, {});
  assert.equal(started.status, 'setup_running'); assert.equal(started.running, true);
  assert.match(started.progress, /^正在检查本机 Python…（已用 \d+ 秒）$/);
  assert.equal(started.state_dir, hostedState);
  const script = f.scripts()[0];
  assert.deepEqual(script.args.slice(-5), ['--backend', 'cloud', '--state-dir', hostedState, '--allow-downloads']);
  assert.equal(script.args.includes('--model'), false);
  assert.equal(script.options.cwd, workspace);
  assert.equal(script.options.shell, false);
  assert.equal(script.args.some(value => /key|token|password/i.test(value)), false);
  assert.equal(f.scratch.bases.length, 0);
  const finished = await settled(f.runtime);
  assert.equal(finished.status, 'prepared');
  assert.equal(finished.python_path, venvPython);
  assert.equal(finished.progress, undefined);
  assert.deepEqual(finished.dependencies, { ytDlp: true, docx: true });
  assert.equal(f.scripts().length, 1);
  assert.equal(f.runtime.setupInstallStatus().status, 'prepared');
});

test('install reports an incomplete environment when the transcript dependency is missing', async () => {
  const f = installHarness({ dependencies: { ytDlp: false, docx: true } });
  await f.runtime.setupInstall({}, {});
  const finished = await settled(f.runtime);
  assert.equal(finished.status, 'setup_incomplete');
  assert.deepEqual(finished.dependencies, { ytDlp: false, docx: true });
  assert.match(finished.message, /yt-dlp/);
});

test('install failures stay static, keep the job inspectable and never echo third-party output', async () => {
  const f = installHarness({ scriptResult: 'not json at all ' + KEY, exitCode: 1 });
  await f.runtime.setupInstall({}, {});
  const finished = await settled(f.runtime);
  assert.equal(finished.status, 'setup_failed');
  assert.equal(JSON.stringify(finished).includes(KEY), false);
  const second = installHarness({ scriptResult: { status: 'setup_failed', message: '准备步骤失败；未显示第三方错误，目录保留。' } });
  await second.runtime.setupInstall({}, {});
  const failed = await settled(second.runtime);
  assert.equal(failed.status, 'setup_failed');
  assert.match(failed.message, /准备步骤失败/);
});

test('saved managed interpreter permits repair and retries without clearing settings', async () => {
  const f = installHarness({ config: { pythonPath: venvPython } });
  assert.equal((await f.runtime.setupInstall({})).status, 'setup_running');
  assert.equal((await settled(f.runtime)).status, 'prepared');
  assert.equal((await f.runtime.setupInstall({})).status, 'setup_running');
  assert.equal((await settled(f.runtime)).status, 'prepared');
  assert.equal(f.scripts().length, 2);
  assert.ok(f.calls.filter(c => c.args.includes('-c') && !c.args.some(a => a.includes('importlib')))
    .every(c => c.command !== venvPython));
});

test('install progress is one bounded readable line with elapsed time, without raw stderr', async () => {
  let release;
  const hold = new Promise(done => { release = done; });
  const f = installHarness({ hold, progress: `ignored ${KEY}\nDSH_STEP 依赖${String.fromCharCode(0xfffd, 7)} ${'中'.repeat(250)}\n` });
  try {
    await f.runtime.setupInstall({});
    await new Promise(done => setImmediate(done));
    const { progress } = f.runtime.setupInstallStatus();
    assert.match(progress, /^依赖/);
    assert.match(progress, /（已用 \d+ 秒）$/);
    assert.ok(progress.length <= 200);
    assert.doesNotMatch(progress, /[\u0000-\u001f\ufffd]/);
    assert.equal(progress.includes(KEY), false);
  } finally { release(); await settled(f.runtime); }
});

test('install errors strip encoding damage and controls and bound the message', async () => {
  const f = installHarness({ exitCode: 1, scriptResult: { status: 'setup_failed',
    message: `venv${String.fromCharCode(0xfffd, 7)}失败 ${'长'.repeat(500)}` } });
  await f.runtime.setupInstall({});
  const value = await settled(f.runtime);
  assert.equal(value.status, 'setup_failed');
  assert.match(value.message, /失败/);
  assert.ok(value.message.length <= 400);
  assert.doesNotMatch(value.message, /[\u0000-\u001f\ufffd]/);
});

test('install success requires zero exit and the exact managed destination', async () => {
  for (const options of [
    { exitCode: 1 },
    { scriptResult: { status: 'prepared_not_runtime_verified', python: executable } },
  ]) {
    const f = installHarness(options);
    await f.runtime.setupInstall({});
    assert.equal((await settled(f.runtime)).status, 'setup_failed');
    assert.equal(f.calls.some(c => c.args.some(a => a.includes('importlib'))), false);
  }
});

test('install missing Word dependency is incomplete rather than a ready environment', async () => {
  const f = installHarness({ dependencies: { ytDlp: true, docx: false } });
  await f.runtime.setupInstall({});
  const value = await settled(f.runtime);
  assert.equal(value.status, 'setup_incomplete');
  assert.match(value.message, /python-docx/);
});

test('repeated install clicks do not spawn a second installer while one is preparing', async () => {
  let release;
  const hold = new Promise(resolveDone => { release = resolveDone; });
  const f = installHarness({ hold });
  await f.runtime.setupInstall({}, {});
  const again = await f.runtime.setupInstall({}, {});
  assert.equal(again.status, 'setup_running');
  assert.equal(f.scripts().length, 1);
  release(); await settled(f.runtime);
  assert.equal(f.scripts().length, 1);
  assert.equal((await f.runtime.setupInstall({ invalid: true }, {})).status, 'invalid_input');
  assert.equal((await f.runtime.setupInstall({}, { signal: AbortSignal.abort() })).status, 'cancelled');
});
