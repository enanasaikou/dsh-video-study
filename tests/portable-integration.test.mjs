import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { createRuntime } from '../lib/runtime.mjs';

const state = resolve('test-private-state');
const python = join(state, 'runtimes', 'cpython-3.14.10-win-x64-11111111-1111-4111-8111-111111111111', 'python.exe');
function fixture(config = {}, overrides = {}) {
  const calls = [], prepares = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    child.stdin.once('finish', () => queueMicrotask(() => {
      child.stdout.write(JSON.stringify(args.some(a => a.includes('importlib.metadata'))
        ? { ytDlp: true, docx: true } : args.includes('-c')
          ? { executable: command, version: [3, 14] }
          : { status: 'ok', network_used: false, runtime_ready: false }));
      child.emit('close', 0);
    }));
    return child;
  };
  const runtime = createRuntime({ stateDir: state, ...config }, {
    platform: 'win32', arch: 'x64', spawnImpl,
    getWorkspace: async () => resolve('test-private-workspace'),
    createScratchImpl: async base => ({ path: join(base, '.fake-scratch'), dispose: async () => {} }),
    accessImpl: async () => { throw Error('missing'); },
    readManagedPythonImpl: async () => null,
    isManagedPythonPathImpl: async (_, value) => value === python || value === join(state, 'venv', 'Scripts', 'python.exe'),
    prepareManagedPythonImpl: async options => {
      prepares.push(options);
      const dependencies = await options.verifyPython(python, { signal: options.signal });
      return { pythonPath: python, dependencies, runtime_managed: true };
    }, ...overrides,
  });
  return { runtime, calls, prepares };
}
async function settle(runtime) {
  for (let i = 0; i < 100; i++) {
    if (!runtime.setupInstallStatus().running) return runtime.setupInstallStatus();
    await new Promise(done => setImmediate(done));
  }
  assert.fail('background preparation did not finish');
}

test('Windows preparation never needs a pre-existing Python or setup CLI', async () => {
  const f = fixture();
  assert.equal((await f.runtime.setupInstall({})).status, 'setup_running');
  const result = await settle(f.runtime);
  assert.equal(result.status, 'prepared');
  assert.equal(result.runtime_managed, true);
  assert.equal(result.python_path, python);
  assert.deepEqual(result.dependencies, { ytDlp: true, docx: true });
  assert.equal(f.prepares.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, python);
  assert.match(f.calls[0].args.at(-1), /document.save\(buffer\)/);
  assert.match(f.calls[0].args.at(-1), /sys.version_info/);
  assert.equal(f.calls.some(c => c.args.some(a => a.endsWith('setup_environment.py'))), false);
});

test('custom interpreter refuses download; saved old/new managed interpreter permits repair', async () => {
  const custom = fixture({ pythonPath: resolve('custom-python.exe') });
  assert.equal((await custom.runtime.setupInstall()).status, 'custom_python_configured');
  assert.equal(custom.prepares.length, 0);
  for (const pythonPath of [python, join(state, 'venv', 'Scripts', 'python.exe')]) {
    const f = fixture({ pythonPath });
    await f.runtime.setupInstall();
    assert.equal((await settle(f.runtime)).status, 'prepared');
  }
});

test('status chooses activated interpreter instead of PATH and does not prepare anything', async () => {
  for (const pythonPath of ['', join(state, 'venv', 'Scripts', 'python.exe')]) {
    const f = fixture({ pythonPath }, { readManagedPythonImpl: async () => python });
    assert.equal((await f.runtime.status()).status, 'ok');
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every(c => c.command === python));
    assert.equal(f.prepares.length, 0);
  }
});

test('invalid active pointer reports repair without downloading or probing PATH', async () => {
  const f = fixture({}, { readManagedPythonImpl: async () => { throw Error('untrusted private text'); } });
  const value = await f.runtime.status();
  assert.equal(value.status, 'dependency_missing');
  assert.match(value.message, /修复/);
  assert.equal(f.calls.length, 0); assert.equal(f.prepares.length, 0);
  assert.equal(JSON.stringify(value).includes('untrusted private text'), false);
});

test('background preparation has one owner, dispose aborts and failure text is static', async () => {
  let count = 0;
  const f = fixture({}, { prepareManagedPythonImpl: options => new Promise((_, reject) => {
    count++;
    options.signal.addEventListener('abort', () => reject(Error('DO NOT LEAK')), { once: true });
  }) });
  await f.runtime.setupInstall(); await f.runtime.setupInstall();
  assert.equal(count, 1);
  await f.runtime.dispose();
  assert.equal(f.runtime.setupInstallStatus().status, 'setup_cancelled');
  assert.equal(JSON.stringify(f.runtime.setupInstallStatus()).includes('DO NOT LEAK'), false);
});

test('download or self-test failure is inspectable and can retry without changing settings', async () => {
  let count = 0;
  const f = fixture({}, { prepareManagedPythonImpl: async () => { count++; throw Error('FAKE SECRET'); } });
  for (let i = 0; i < 2; i++) {
    await f.runtime.setupInstall();
    const value = await settle(f.runtime);
    assert.equal(value.status, 'setup_failed');
    assert.match(value.message, /旧环境已保留/);
    assert.equal(JSON.stringify(value).includes('FAKE SECRET'), false);
  }
  assert.equal(count, 2);
});

test('two requests awaiting ownership share one background install', async () => {
  let release, calls = 0;
  const gate = new Promise(done => { release = done; });
  const f = fixture({ pythonPath: python }, {
    isManagedPythonPathImpl: async () => { await gate; return true; },
    prepareManagedPythonImpl: options => new Promise((_, reject) => {
      calls++; options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
    }),
  });
  const first = f.runtime.setupInstall(), second = f.runtime.setupInstall();
  release();
  const values = await Promise.all([first, second]);
  assert.ok(values.every(value => value.status === 'setup_running'));
  assert.equal(calls, 1);
  await f.runtime.dispose();
});

test('dispose while ownership is pending prevents later downloads', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const f = fixture({ pythonPath: python }, { isManagedPythonPathImpl: async () => { await gate; return true; } });
  const pending = f.runtime.setupInstall();
  await f.runtime.dispose(); release();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(f.prepares.length, 0);
});

test('helper commit remains prepared when dispose arrives during committed cleanup', async () => {
  let committed;
  const commit = new Promise(done => { committed = done; });
  const f = fixture({}, { prepareManagedPythonImpl: async options => {
    committed();
    await new Promise(done => options.signal.addEventListener('abort', done, { once: true }));
    return { pythonPath: python, dependencies: { ytDlp: true, docx: true }, runtime_managed: true };
  } });
  await f.runtime.setupInstall(); await commit;
  await f.runtime.dispose();
  assert.equal(f.runtime.setupInstallStatus().status, 'prepared');
});

test('committed cleanup warnings remain static and do not turn readiness into failure', async () => {
  const f = fixture({}, { prepareManagedPythonImpl: async () => ({
    pythonPath: python, dependencies: { ytDlp: true, docx: true }, runtime_managed: true,
    warnings: ['PRIVATE INTERNAL PATH'],
  }) });
  await f.runtime.setupInstall();
  const result = await settle(f.runtime);
  assert.equal(result.status, 'prepared');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /锁/);
  assert.equal(JSON.stringify(result).includes('PRIVATE INTERNAL PATH'), false);
});
