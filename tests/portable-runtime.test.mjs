import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir, unlink, symlink, link, lstat, access } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, resolve, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readManagedPython, isManagedPythonPath, prepareManagedPython } from '../lib/portable-runtime.mjs';

// Only in-memory stored ZIP fixtures. No executable, network, downloaded module,
// Python, external archiver, pip or dependency installation is ever run.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const embed = { 'python.exe': 'offline inert fixture, never execute', 'python314.zip': 'stdlib fixture',
  'python314._pth': 'python314.zip\n.\n#import site\n', 'LICENSE.txt': 'PSF license' };
const wheels = {
  'yt-dlp': { 'yt_dlp/__init__.py': '# fixture', 'yt_dlp-2026.8.19.dist-info/METADATA': 'Version: 2026.8.19',
    'yt_dlp-2026.8.19.dist-info/licenses/LICENSE': 'yt-dlp license' },
  'python-docx': { 'docx/__init__.py': '# fixture', 'python_docx-1.2.0.dist-info/METADATA': 'Version: 1.2.0' },
  lxml: { 'lxml/etree.cp314-win_amd64.pyd': 'inert fixture', 'lxml-6.0.2.dist-info/LICENSE.txt': 'lxml license' },
  typing_extensions: { 'typing_extensions.py': '# fixture', 'typing_extensions-4.15.0.dist-info/METADATA': 'Version: 4.15.0' },
};
const verified = async () => ({ ytDlp: true, docx: true });
function download(overrides = {}, calls = []) {
  return async (artifact, options) => {
    calls.push({ artifact, options });
    assert.match(artifact.url, /^https:\/\/(www\.python\.org|files\.pythonhosted\.org)\//);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.size > 0);
    options.onProgress?.({ received: 2, total: artifact.size });
    return zip(artifact.name ? overrides[artifact.name] || wheels[artifact.name] : overrides.embed || embed);
  };
}
async function fixture(t) {
  const parent = resolve('.');
  const root = await mkdtemp(join(parent, '.portable-test-'));
  const junctions = [];
  t.after(async () => {
    assert.equal(dirname(root), parent); assert.match(basename(root), /^\.portable-test-/);
    const info = await lstat(root); assert.equal(info.isSymbolicLink(), false);
    // The Windows sandbox's recursive rm follows junction metadata. Remove only
    // exact junctions this fixture created, non-recursively, before tree cleanup.
    for (const path of junctions) {
      assert.equal(dirname(path), root);
      if (process.platform === 'win32') await rmdir(path); else await unlink(path);
    }
    await rm(root, { recursive: true });
  });
  return { root, state: join(root, 'state'), junctions };
}
async function install(state, extra = {}) {
  return prepareManagedPython({ state, arch: 'x64', verifyPython: verified, downloadImpl: download(), ...extra });
}
const code = expected => error => error?.code === expected;

test('missing pointer is null; recognition permits missing legacy and strict version paths', async t => {
  const { state } = await fixture(t);
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
  assert.equal(await isManagedPythonPath(state, join(state, 'venv', 'Scripts', 'python.exe'), { arch: 'x64' }), true);
  const child = join(state, 'runtimes', `cpython-3.14.10-win-x64-${randomUUID()}`, 'python.exe');
  assert.equal(await isManagedPythonPath(state, child, { arch: 'x64' }), true);
  for (const bad of [join(state, 'python.exe'), join(state, 'venv', 'bin', 'python'),
    child.replace('3.14.10', '3.13.18'), child.replace('win-x64', 'win-arm64'), child.replace(/-[0-9a-f-]+\\python.exe$/, '-fake\\python.exe')]) {
    if (bad !== child) assert.equal(await isManagedPythonPath(state, bad, { arch: 'x64' }), false);
  }
});

test('unsupported architecture and unsafe state fail before creating anything', async t => {
  const { state, root } = await fixture(t);
  await assert.rejects(install(state, { arch: 'ia32' }), code('MANAGED_UNSUPPORTED_ARCH'));
  await assert.rejects(readManagedPython(state, { arch: 'riscv64' }), code('MANAGED_UNSUPPORTED_ARCH'));
  for (const value of ['', '.', 'relative-state', '\\\\server\\share', `${root}\\..\\bad`, `${state}\u0000`,
    `${state}.`, `${state} `, `${state}:ads`, `${state}*`, join(root, 'NUL'), join(root, 'COM¹')]) {
    await assert.rejects(install(value), code('MANAGED_UNSAFE_PATH'));
  }
  await assert.rejects(access(state), { code: 'ENOENT' });
});

test('installs fixed artifacts, preserves licenses/metadata, isolates pth, verifies before activation', async t => {
  const { state } = await fixture(t), calls = [], events = [];
  const result = await install(state, { proxy: 'http://localhost:3128', downloadImpl: download({}, calls),
    manifest: { platforms: { x64: { python: { url: 'http://malicious.invalid' } } } },
    onProgress: line => { assert.equal(typeof line, 'string'); events.push(line); },
    verifyPython: async (path, options) => {
      assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
      assert.match(path, /cpython-3\.14\.10-win-x64-/);
      assert.equal(await readFile(join(dirname(path), 'python314._pth'), 'utf8'), 'python314.zip\n.\npackages\n');
      assert.equal(options.signal, undefined);
      return verified();
    } });
  assert.deepEqual(result.dependencies, { ytDlp: true, docx: true }); assert.equal(result.runtime_managed, true);
  assert.equal(await readManagedPython(state, { arch: 'x64' }), result.pythonPath);
  assert.equal(calls.length, 5); assert.ok(calls.every(call => call.options.proxy === 'http://localhost:3128'));
  assert.equal(calls[0].artifact.url, 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip');
  assert.equal(await readFile(join(dirname(result.pythonPath), 'packages', 'yt_dlp-2026.8.19.dist-info/licenses/LICENSE'), 'utf8'), 'yt-dlp license');
  const pointer = JSON.parse(await readFile(join(state, 'active-runtime.json'), 'utf8'));
  const lock = await readFile(new URL('../lib/portable-runtime-lock.json', import.meta.url));
  assert.equal(pointer.lockSha256, createHash('sha256').update(lock).digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(join(dirname(result.pythonPath), 'runtime-owner.json'), 'utf8')), pointer);
  assert.ok(events.some(line => line.includes('字节')));
  await assert.rejects(access(join(state, '.portable-install.lock')), { code: 'ENOENT' });
});

test('arm64 uses official arm64 embed and lxml while return path is architecture-bound', async t => {
  const { state } = await fixture(t), calls = [];
  const result = await install(state, { arch: 'arm64', downloadImpl: download({}, calls) });
  assert.match(result.pythonPath, /win-arm64-/);
  assert.match(calls[0].artifact.url, /embed-arm64\.zip$/);
  assert.match(calls[3].artifact.filename, /win_arm64\.whl$/);
  await assert.rejects(readManagedPython(state, { arch: 'x64' }), code('MANAGED_INVALID_POINTER'));
});

test('healthy active environment is verified/reused without downloading or automatic updates', async t => {
  const { state } = await fixture(t), first = await install(state);
  let probes = 0;
  const second = await install(state, { downloadImpl: async () => { throw Error('must not download'); },
    verifyPython: async path => { assert.equal(path, first.pythonPath); probes++; return verified(); } });
  assert.equal(second.pythonPath, first.pythonPath); assert.equal(probes, 1);
  assert.equal((await readdir(join(state, 'runtimes'))).length, 1);
});

test('failed old dependency probe creates a unique version and never edits/deletes old environment', async t => {
  const { state } = await fixture(t), first = await install(state);
  const oldBytes = await readFile(first.pythonPath);
  let probes = 0;
  const second = await install(state, { verifyPython: async path => {
    probes++; if (path === first.pythonPath) throw Error('broken dependency'); return verified();
  } });
  assert.notEqual(second.pythonPath, first.pythonPath); assert.equal(probes, 2);
  assert.deepEqual(await readFile(first.pythonPath), oldBytes);
  assert.equal(await readManagedPython(state, { arch: 'x64' }), second.pythonPath);
  assert.equal((await readdir(join(state, 'runtimes'))).length, 2);
});

for (const damage of ['malformed', 'null', 'schema', 'architecture', 'version', 'directory', 'hash', 'owner', 'python']) {
  test(`read rejects ${damage}; prepare safely repairs with a fresh version`, async t => {
    const { state } = await fixture(t), first = await install(state);
    const path = join(state, 'active-runtime.json');
    const pointer = JSON.parse(await readFile(path, 'utf8'));
    if (damage === 'malformed') await writeFile(path, '{');
    if (damage === 'null') await writeFile(path, 'null');
    if (damage === 'schema') { pointer.schema = 9; await writeFile(path, JSON.stringify(pointer)); }
    if (damage === 'architecture') { pointer.arch = 'arm64'; await writeFile(path, JSON.stringify(pointer)); }
    if (damage === 'version') { pointer.version = '3.13.18'; await writeFile(path, JSON.stringify(pointer)); }
    if (damage === 'directory') { pointer.directory = '../escape'; await writeFile(path, JSON.stringify(pointer)); }
    if (damage === 'hash') { pointer.lockSha256 = '0'.repeat(64); await writeFile(path, JSON.stringify(pointer)); }
    if (damage === 'owner') await writeFile(join(dirname(first.pythonPath), 'runtime-owner.json'), '{}');
    if (damage === 'python') await rm(first.pythonPath);
    await assert.rejects(readManagedPython(state, { arch: 'x64' }), error => /^MANAGED_/.test(error.code));
    const second = await install(state);
    assert.notEqual(second.pythonPath, first.pythonPath);
    assert.equal(await readManagedPython(state, { arch: 'x64' }), second.pythonPath);
    assert.equal((await readdir(join(state, 'runtimes'))).length, 2);
  });
}

test('verification failure preserves old pointer byte-for-byte and retains new files', async t => {
  const { state } = await fixture(t), first = await install(state), progress = [];
  const before = await readFile(join(state, 'active-runtime.json'));
  await assert.rejects(install(state, { verifyPython: async () => { throw Error('probe failed'); },
    onProgress: line => progress.push(line) }), code('MANAGED_PREPARE_FAILED'));
  assert.deepEqual(await readFile(join(state, 'active-runtime.json')), before);
  assert.equal(await readManagedPython(state, { arch: 'x64' }), first.pythonPath);
  assert.equal((await readdir(join(state, 'runtimes'))).length, 2);
  assert.ok(progress.some(line => line.includes('保留')));
});

test('truthy/undefined verifier result cannot activate incomplete installation', async t => {
  const { state } = await fixture(t);
  await assert.rejects(install(state, { verifyPython: async () => undefined }), code('MANAGED_VERIFY_FAILED'));
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
});

for (const unsafe of ['injected.pth', 'pkg.data/scripts/tool.py', 'pkg/run.exe', 'pkg/run.cmd']) {
  test(`unsafe wheel ${unsafe} is rejected before activation`, async t => {
    const { state } = await fixture(t);
    await assert.rejects(install(state, { downloadImpl: download({ 'python-docx': { [unsafe]: 'unsafe' } }) }), code('MANAGED_UNSAFE_WHEEL'));
    assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
    assert.equal((await readdir(join(state, 'runtimes'))).length, 1);
  });
}

test('hash-pinned yt-dlp ancillary docs and completions are omitted, not installed globally', async t => {
  const { state } = await fixture(t);
  const optional = [
    'yt_dlp-2026.8.19.data/data/share/bash-completion/completions/yt-dlp',
    'yt_dlp-2026.8.19.data/data/share/doc/yt_dlp/README.txt',
    'yt_dlp-2026.8.19.data/data/share/fish/vendor_completions.d/yt-dlp.fish',
    'yt_dlp-2026.8.19.data/data/share/man/man1/yt-dlp.1',
    'yt_dlp-2026.8.19.data/data/share/zsh/site-functions/_yt-dlp',
  ];
  const payload = { ...wheels['yt-dlp'], ...Object.fromEntries(optional.map(name => [name, 'nonruntime asset'])) };
  const result = await install(state, { downloadImpl: download({ 'yt-dlp': payload }) });
  assert.equal(await readManagedPython(state, { arch: 'x64' }), result.pythonPath);
  assert.equal(await readFile(join(dirname(result.pythonPath), 'packages', 'yt_dlp/__init__.py'), 'utf8'), '# fixture');
  await assert.rejects(access(join(dirname(result.pythonPath), 'packages', 'yt_dlp-2026.8.19.data')), { code: 'ENOENT' });
});

for (const extra of ['yt_dlp-2026.8.19.data/data/share/doc/yt_dlp/other.txt',
  'yt_dlp-2026.8.19.data/purelib/injected.py', 'yt_dlp-2026.8.19.data/scripts/injected.py']) {
  test(`unlisted yt-dlp ancillary member remains forbidden: ${extra}`, async t => {
    const { state } = await fixture(t);
    await assert.rejects(install(state, { downloadImpl: download({ 'yt-dlp': { [extra]: 'unsafe' } }) }), code('MANAGED_UNSAFE_WHEEL'));
    assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
  });
}

test('yt-dlp optional-data exceptions do not apply to other wheels', async t => {
  const { state } = await fixture(t);
  await assert.rejects(install(state, { downloadImpl: download({ 'python-docx': {
    'yt_dlp-2026.8.19.data/data/share/doc/yt_dlp/README.txt': 'wrong wheel',
  } }) }), code('MANAGED_UNSAFE_WHEEL'));
});

test('wheel file collisions are rejected case-insensitively across downloads', async t => {
  const { state } = await fixture(t);
  await assert.rejects(install(state, { downloadImpl: download({ 'python-docx': { 'YT_DLP/__INIT__.PY': 'overwrite' } }) }), code('MANAGED_ARCHIVE_COLLISION'));
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
});

test('whole same-state installation lock rejects concurrent independent calls, finally releases', async t => {
  const { state } = await fixture(t);
  let releaseDownload, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const gate = new Promise(resolve => { releaseDownload = resolve; });
  const source = download();
  let first = true;
  const running = install(state, { downloadImpl: async (...args) => {
    if (first) { first = false; signalStarted(); await gate; } return source(...args);
  } });
  await started;
  // A distinct module instance cannot bypass the disk lock.
  const independent = await import(`../lib/portable-runtime.mjs?offline-instance=${randomUUID()}`);
  await assert.rejects(independent.prepareManagedPython({ state, arch: 'x64',
    verifyPython: verified, downloadImpl: download() }), code('MANAGED_INSTALL_LOCKED'));
  releaseDownload(); await running;
  await assert.rejects(access(join(state, '.portable-install.lock')), { code: 'ENOENT' });
});

test('preexisting lock is never stolen/deleted and existing dirs are never removed', async t => {
  const { state } = await fixture(t);
  await mkdir(state); const path = join(state, '.portable-install.lock'); await writeFile(path, 'someone else');
  await assert.rejects(install(state), code('MANAGED_INSTALL_LOCKED'));
  assert.equal(await readFile(path, 'utf8'), 'someone else');
});

test('lock replacement is not deleted by finally', async t => {
  const { state } = await fixture(t);
  await assert.rejects(install(state, { downloadImpl: async () => {
    await writeFile(join(state, '.portable-install.lock'), 'replacement'); throw Error('download fails');
  } }), code('MANAGED_LOCK_OWNERSHIP'));
  assert.equal(await readFile(join(state, '.portable-install.lock'), 'utf8'), 'replacement');
});

test('abort after download and abort during verification do not activate; old pointer stays intact', async t => {
  const { state } = await fixture(t), controller = new AbortController(), source = download();
  await assert.rejects(install(state, { signal: controller.signal, downloadImpl: async (...args) => {
    const bytes = await source(...args); controller.abort(); return bytes;
  } }), code('MANAGED_ABORTED'));
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
  await assert.rejects(access(join(state, '.portable-install.lock')), { code: 'ENOENT' });
  const second = new AbortController();
  await assert.rejects(install(state, { signal: second.signal, verifyPython: async () => {
    second.abort(); return verified();
  } }), code('MANAGED_ABORTED'));
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
});

for (const errorCode of ['cancelled', 'process_not_stopped']) {
  test(`old verification ${errorCode} never starts repair`, async t => {
    const { state } = await fixture(t), first = await install(state);
    await assert.rejects(install(state, { verifyPython: async () => { throw Object.assign(Error(errorCode), { code: errorCode }); },
      downloadImpl: async () => { throw Error('must not download'); } }), code('MANAGED_PREPARE_FAILED'));
    assert.equal(await readManagedPython(state, { arch: 'x64' }), first.pythonPath);
    assert.equal((await readdir(join(state, 'runtimes'))).length, 1);
  });
}

test('linked state/runtime ancestors are rejected, including legacy recognition', async t => {
  const { root, state, junctions } = await fixture(t), actual = join(root, 'actual');
  await mkdir(actual); await symlink(actual, state, process.platform === 'win32' ? 'junction' : 'dir');
  junctions.push(state);
  await assert.rejects(install(state), code('MANAGED_UNSAFE_PATH'));
  assert.equal(await isManagedPythonPath(state, join(state, 'venv', 'Scripts', 'python.exe'), { arch: 'x64' }), false);
  assert.deepEqual(await readdir(actual), []);
});

test('linked or oversized active pointer is rejected before downloading/creating runtime', async t => {
  const { root, state } = await fixture(t);
  await mkdir(state);
  const target = join(root, 'elsewhere.json'); await writeFile(target, '{}');
  await link(target, join(state, 'active-runtime.json'));
  await assert.rejects(install(state), code('MANAGED_INVALID_FILE'));
  assert.equal(await readFile(target, 'utf8'), '{}');
  await rm(join(state, 'active-runtime.json'));
  await writeFile(join(state, 'active-runtime.json'), 'x'.repeat(16385));
  await assert.rejects(install(state), code('MANAGED_INVALID_FILE'));
  await assert.rejects(access(join(state, 'runtimes')), { code: 'ENOENT' });
});

test('old owner hardlink is not trusted or modified during fresh repair', async t => {
  const { state, root } = await fixture(t), first = await install(state);
  const owner = join(dirname(first.pythonPath), 'runtime-owner.json');
  const copied = join(root, 'owner-copy.json');
  const before = await readFile(owner);
  await link(owner, copied);
  await assert.rejects(readManagedPython(state, { arch: 'x64' }), code('MANAGED_INVALID_FILE'));
  const second = await install(state);
  assert.notEqual(second.pythonPath, first.pythonPath);
  assert.deepEqual(await readFile(copied), before);
});

test('runtime junction cannot be read/recognized, but repair creates a separate safe version', async t => {
  const { state, root, junctions } = await fixture(t), first = await install(state);
  const original = dirname(first.pythonPath), renamed = join(root, 'old-runtime');
  // Move only this fixture's known runtime aside, then install an exact known junction.
  assert.equal(dirname(original), join(state, 'runtimes')); assert.equal(dirname(renamed), root);
  await fs.rename(original, renamed);
  await symlink(renamed, original, process.platform === 'win32' ? 'junction' : 'dir');
  // This junction is nested; remove it in the test itself before fixture cleanup.
  try {
    await assert.rejects(readManagedPython(state, { arch: 'x64' }), code('MANAGED_UNSAFE_PATH'));
    assert.equal(await isManagedPythonPath(state, first.pythonPath, { arch: 'x64' }), false);
    const second = await install(state);
    assert.notEqual(second.pythonPath, first.pythonPath);
    assert.equal(await readManagedPython(state, { arch: 'x64' }), second.pythonPath);
    assert.equal(await readFile(join(renamed, 'python.exe'), 'utf8'), embed['python.exe']);
  } finally {
    if (process.platform === 'win32') await rmdir(original); else await unlink(original);
  }
  assert.deepEqual(junctions, []);
});

test('cross-wheel namespace collisions are rejected, even with different file names', async t => {
  const { state } = await fixture(t);
  await assert.rejects(install(state, { downloadImpl: download({ 'python-docx': { 'yt_dlp/other.py': 'overlap' } }) }), code('MANAGED_ARCHIVE_COLLISION'));
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
});

test('cross-wheel Windows Unicode casing collision is rejected', async t => {
  const { state } = await fixture(t);
  // Capital I and dotless i share a Windows case-folded file identity.
  const source = download({ 'yt-dlp': { 'I.py': 'one' } });
  const other = download({ 'python-docx': { '\u0131.py': 'two' } });
  await assert.rejects(install(state, { downloadImpl: (artifact, options) =>
    artifact.name === 'python-docx' ? other(artifact, options) : source(artifact, options) }),
  code('MANAGED_ARCHIVE_COLLISION'));
  assert.equal(await readManagedPython(state, { arch: 'x64' }), null);
});

test('download failure during repair preserves exact previous pointer and downloaded files', async t => {
  const { state } = await fixture(t), first = await install(state);
  const before = await readFile(join(state, 'active-runtime.json'));
  const source = download(); let downloads = 0;
  await assert.rejects(install(state, { verifyPython: async () => { throw Error('old deps broken'); },
    downloadImpl: async (...args) => { if (++downloads === 2) throw Error('offline download fails'); return source(...args); } }),
  code('MANAGED_PREPARE_FAILED'));
  assert.equal(downloads, 2);
  assert.deepEqual(await readFile(join(state, 'active-runtime.json')), before);
  assert.equal(await readManagedPython(state, { arch: 'x64' }), first.pythonPath);
  const children = await readdir(join(state, 'runtimes'));
  assert.equal(children.length, 2);
  const retained = children.find(name => join(state, 'runtimes', name, 'python.exe') !== first.pythonPath);
  assert.equal(await readFile(join(state, 'runtimes', retained, 'python.exe'), 'utf8'), embed['python.exe']);
});

test('lock cleanup failure after atomic commit returns prepared with a fixed warning', async t => {
  const { state } = await fixture(t);
  const original = fs.unlink;
  t.mock.method(fs, 'unlink', async path => {
    if (basename(path) === '.portable-install.lock') throw Object.assign(Error('offline injected lock release'), { code: 'EACCES' });
    return original(path);
  });
  syncBuiltinESMExports();
  try {
    const result = await install(state);
    assert.equal(await readManagedPython(state, { arch: 'x64' }), result.pythonPath);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('已激活'));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('lock cleanup failure after a healthy reuse also returns prepared', async t => {
  const { state } = await fixture(t), first = await install(state);
  const original = fs.unlink;
  t.mock.method(fs, 'unlink', async path => {
    if (basename(path) === '.portable-install.lock') throw Error('offline release failure');
    return original(path);
  });
  syncBuiltinESMExports();
  try {
    const result = await install(state);
    assert.equal(result.pythonPath, first.pythonPath); assert.equal(result.warnings.length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('missing verifier fails closed with no filesystem changes', async t => {
  const { state } = await fixture(t);
  await assert.rejects(install(state, { verifyPython: undefined }), code('MANAGED_VERIFY_REQUIRED'));
  await assert.rejects(access(state), { code: 'ENOENT' });
});
