import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, readZipEntries } from './portable-archive.mjs';

const VERSION = '3.14.10';
const KIND = 'dsh-video-study-portable-runtime';
const POINTER = 'active-runtime.json';
const OWNER = 'runtime-owner.json';
const MAX_JSON = 16 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MARKER_KEYS = ['schema', 'kind', 'arch', 'version', 'directory', 'lockSha256', 'installationId', 'stateRoot'];
const LOCK_PATH = fileURLToPath(new URL('./portable-runtime-lock.json', import.meta.url));
// Audited ancillary files in the hash-pinned yt-dlp wheel. These are not Python
// import data: do not install shell completions/manuals into a global prefix.
const YT_DLP_OPTIONAL_DATA = new Set([
  'yt_dlp-2026.8.19.data/data/share/bash-completion/completions/yt-dlp',
  'yt_dlp-2026.8.19.data/data/share/doc/yt_dlp/README.txt',
  'yt_dlp-2026.8.19.data/data/share/fish/vendor_completions.d/yt-dlp.fish',
  'yt_dlp-2026.8.19.data/data/share/man/man1/yt-dlp.1',
  'yt_dlp-2026.8.19.data/data/share/zsh/site-functions/_yt-dlp',
]);

function fail(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
function abort(signal) {
  if (signal?.aborted) throw fail('MANAGED_ABORTED', '私有运行环境准备已取消。');
}
function architecture(arch) {
  if (arch !== 'x64' && arch !== 'arm64') throw fail('MANAGED_UNSUPPORTED_ARCH', '私有运行环境仅支持 Windows x64 / arm64。');
}
function fold(value) { return value.toUpperCase().toLowerCase(); }
function comparable(value) { return process.platform === 'win32' ? fold(resolve(value)) : resolve(value); }
function statePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
      || /^[\\/]{2}/.test(value) || value.split(/[\\/]/).includes('..')) {
    throw fail('MANAGED_UNSAFE_PATH', '必须显式指定无链接、非 UNC 的绝对状态目录。');
  }
  const path = resolve(value);
  const parts = relative(parse(path).root, path).split(sep).filter(Boolean);
  if (parts.some(part => /[. ]$/.test(part) || /[:<>"|?*]/.test(part)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw fail('MANAGED_UNSAFE_PATH', '状态目录含不安全的 Windows 路径组件。');
  }
  return path;
}

// Checking realpath as well as lstat rejects Windows junctions on Node builds
// that expose them as directories. Missing descendants are allowed for repair.
async function directories(path, { create = false, allowMissing = false } = {}) {
  let current = parse(path).root;
  for (const part of [null, ...relative(current, path).split(sep).filter(Boolean)]) {
    if (part !== null) current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw fail('MANAGED_UNSAFE_PATH', '无法检查运行环境目录。', error);
      if (!create) {
        if (allowMissing) return false;
        throw fail('MANAGED_UNSAFE_PATH', '运行环境目录不存在。');
      }
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw fail('MANAGED_UNSAFE_PATH', '无法创建运行环境目录。', error); }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory() || comparable(await realpath(current)) !== comparable(current)) {
      throw fail('MANAGED_UNSAFE_PATH', '运行环境目录含链接或非目录祖先。');
    }
  }
  return true;
}
async function ensureDirectories(path) {
  await directories(path, { allowMissing: true });
  await directories(path, { create: true });
}
function identity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
async function regularFile(path, { optional = false, maxBytes = Infinity, contents = false } = {}) {
  if (!await directories(dirname(path), { allowMissing: optional })) return null;
  let before;
  try { before = await lstat(path); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw fail('MANAGED_INVALID_FILE', '运行环境文件缺失或不可读。', error);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maxBytes
      || comparable(await realpath(path)) !== comparable(path)) {
    throw fail('MANAGED_INVALID_FILE', '运行环境文件不是独占普通文件或超过大小限制。');
  }
  if (!contents) return before;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    if (!identity(before, actual) || !actual.isFile() || actual.nlink !== 1 || actual.size > maxBytes) {
      throw fail('MANAGED_INVALID_FILE', '读取运行环境文件时归属发生变化。');
    }
    // Read at most maxBytes+1 even if a file grows after stat.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw fail('MANAGED_INVALID_FILE', '运行环境文件超过大小限制。');
    const after = await lstat(path);
    if (!identity(actual, after) || after.isSymbolicLink() || after.nlink !== 1
        || comparable(await realpath(path)) !== comparable(path)) throw fail('MANAGED_INVALID_FILE', '运行环境文件在读取期间被替换。');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function jsonFile(path, optional = false) {
  const data = await regularFile(path, { optional, maxBytes: MAX_JSON, contents: true });
  if (data === null) return undefined;
  try { return JSON.parse(data.toString('utf8')); }
  catch (error) { throw fail('MANAGED_INVALID_POINTER', '运行环境归属文件不是有效 JSON。', error); }
}
async function lockManifest() {
  // No caller-supplied manifest, URL, version or hash overrides are accepted.
  const bytes = await readFile(LOCK_PATH);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || manifest.pythonVersion !== VERSION) throw fail('MANAGED_INVALID_MANIFEST', '固定运行环境锁文件无效。');
  return { manifest, hash: createHash('sha256').update(bytes).digest('hex') };
}
function validMarker(value, root, arch, hash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== MARKER_KEYS.length || !MARKER_KEYS.every(key => Object.hasOwn(value, key))) return false;
  return value.schema === 1 && value.kind === KIND && value.arch === arch && value.version === VERSION
    && value.lockSha256 === hash && value.stateRoot === comparable(root)
    && typeof value.installationId === 'string' && new RegExp(`^${UUID}$`).test(value.installationId)
    && value.directory === `cpython-${VERSION}-win-${arch}-${value.installationId}`;
}

/** Return only a completely owned, activated interpreter; absence is not damage. */
export async function readManagedPython(state, { arch = process.arch } = {}) {
  try { return await readManagedPythonChecked(state, arch); }
  catch (error) {
    if (error?.code?.startsWith('MANAGED_')) throw error;
    throw fail('MANAGED_READ_FAILED', '无法安全读取私有运行环境状态。', error);
  }
}
async function readManagedPythonChecked(state, arch) {
  architecture(arch);
  const root = statePath(state);
  if (!await directories(root, { allowMissing: true })) return null;
  const pointer = await jsonFile(join(root, POINTER), true);
  if (pointer === undefined) return null;
  const { hash } = await lockManifest();
  if (!validMarker(pointer, root, arch, hash)) throw fail('MANAGED_INVALID_POINTER', '运行环境指针的架构、版本或归属不匹配。');
  const directory = join(root, 'runtimes', pointer.directory);
  await directories(directory);
  const owner = await jsonFile(join(directory, OWNER));
  if (!validMarker(owner, root, arch, hash) || !MARKER_KEYS.every(key => owner[key] === pointer[key])) {
    throw fail('MANAGED_INVALID_OWNER', '运行环境归属标记与激活指针不匹配。');
  }
  const pythonPath = join(directory, 'python.exe');
  await regularFile(pythonPath);
  return pythonPath;
}

/** Recognition is intentionally independent of active state, so broken saved paths can be repaired. */
export async function isManagedPythonPath(state, value, { arch = process.arch } = {}) {
  try {
    architecture(arch);
    const root = statePath(state);
    const candidate = statePath(value);
    const old = join(root, 'venv', 'Scripts', 'python.exe');
    const newParent = join(root, 'runtimes');
    const pattern = new RegExp(`^cpython-3\\.14\\.10-win-${arch}-${UUID}$`);
    const recognized = comparable(candidate) === comparable(old)
      || (basename(candidate).toLowerCase() === 'python.exe'
        && comparable(dirname(dirname(candidate))) === comparable(newParent)
        && pattern.test(basename(dirname(candidate)).toLowerCase()));
    if (!recognized) return false;
    await directories(dirname(candidate), { allowMissing: true });
    await regularFile(candidate, { optional: true });
    return true;
  } catch { return false; }
}

async function writeExclusive(path, bytes) {
  await directories(dirname(path));
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); return await handle.stat(); }
  finally { await handle.close(); }
}
async function acquire(root) {
  const path = join(root, '.portable-install.lock');
  const token = randomUUID();
  let fileIdentity;
  try { fileIdentity = await writeExclusive(path, `${token}\n`); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('MANAGED_INSTALL_LOCKED', '已有私有运行环境准备任务；不会自动抢占锁。');
    throw error;
  }
  const validate = async () => {
    await directories(root);
    const actual = await regularFile(path, { maxBytes: 128 });
    const contents = await regularFile(path, { maxBytes: 128, contents: true });
    if (!identity(fileIdentity, actual) || contents.toString('utf8') !== `${token}\n`) {
      throw fail('MANAGED_LOCK_OWNERSHIP', '安装锁已被替换，拒绝删除。');
    }
  };
  return { validate, async release() { await validate(); await unlink(path); } };
}
function archiveName(name) {
  if (typeof name !== 'string' || !name || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/')) {
    throw fail('MANAGED_UNSAFE_ARCHIVE', '压缩包包含不安全路径。');
  }
  const directory = name.endsWith('/');
  const parts = (directory ? name.slice(0, -1) : name).split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw fail('MANAGED_UNSAFE_ARCHIVE', '压缩包包含不安全路径组件。');
  }
  return { parts, directory, key: fold(parts.join('/')) };
}
async function unpack(buffer, destination, names, { wheel = false, wheelName = '', signal } = {}) {
  abort(signal);
  const entries = readZipEntries(buffer, { maxFiles: 30000, maxUncompressedBytes: 512 * 1024 * 1024 });
  // Validate an entire wheel before writing any of it. Case-folded entries and
  // file/directory clashes are tracked across all wheels, not just one ZIP.
  const prepared = [];
  const local = new Set();
  const earlierPackages = new Set(names.keys());
  for (const entry of entries) {
    abort(signal);
    const path = archiveName(entry.name);
    // Only these five exact, pinned yt-dlp ancillary assets may be omitted.
    // All paths/CRC/limits were validated by readZipEntries before this point;
    // other .data members, scripts and .pth files remain fail-closed.
    if (wheel && wheelName === 'yt-dlp' && YT_DLP_OPTIONAL_DATA.has(entry.name)) continue;
    if (wheel && (path.parts.some(part => /\.data$/i.test(part)) || /\.pth$/i.test(path.key)
        || /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|scr|sh)$/i.test(path.key))) {
      throw fail('MANAGED_UNSAFE_WHEEL', 'wheel 含 .pth、可执行脚本或不支持的 .data。');
    }
    if (local.has(path.key)) throw fail('MANAGED_ARCHIVE_COLLISION', '压缩包路径重复。');
    local.add(path.key);
    const kind = path.directory ? 'directory' : 'file';
    if (wheel && path.parts.some((_, index) => earlierPackages.has(fold(path.parts.slice(0, index + 1).join('/'))))) {
      throw fail('MANAGED_ARCHIVE_COLLISION', 'wheel 包之间目录或文件归属重叠。');
    }
    if (names.has(path.key) && !(kind === 'directory' && names.get(path.key) === 'directory')) {
      throw fail('MANAGED_ARCHIVE_COLLISION', '运行环境包之间路径发生碰撞。');
    }
    for (let i = 1; i < path.parts.length; i++) {
      const ancestor = fold(path.parts.slice(0, i).join('/'));
      if (names.get(ancestor) === 'file') throw fail('MANAGED_ARCHIVE_COLLISION', '压缩包文件与目录发生碰撞。');
      names.set(ancestor, 'directory');
    }
    names.set(path.key, kind);
    if (!path.directory && !Buffer.isBuffer(entry.data)) throw fail('MANAGED_UNSAFE_ARCHIVE', '压缩包条目数据无效。');
    prepared.push({ ...path, data: entry.data });
  }
  for (const entry of prepared) {
    abort(signal);
    const target = join(destination, ...entry.parts);
    if (entry.directory) await ensureDirectories(target);
    else { await ensureDirectories(dirname(target)); await writeExclusive(target, entry.data); }
  }
}
function result(pythonPath) {
  return { pythonPath, dependencies: { ytDlp: true, docx: true }, runtime_managed: true };
}

/** Downloads are injectable for offline tests; the production lock is never injectable. */
export async function prepareManagedPython({ state, arch = process.arch, proxy = '', signal,
  onProgress = () => {}, verifyPython, downloadImpl = downloadVerified, ...testOptions } = {}) {
  architecture(arch);
  const root = statePath(state);
  abort(signal);
  if (typeof verifyPython !== 'function') throw fail('MANAGED_VERIFY_REQUIRED', '必须提供模块与 DOCX 回读验证。');
  if (typeof downloadImpl !== 'function') throw fail('MANAGED_INVALID_DOWNLOAD', '下载实现无效。');
  // Deliberately unused: testOptions cannot alter official artifact addresses.
  void testOptions;
  await ensureDirectories(root);
  // A damaged JSON value may be repaired; a linked, oversized, non-regular
  // pointer cannot. Check the file before creating the installation lock.
  await regularFile(join(root, POINTER), { optional: true, maxBytes: MAX_JSON });
  abort(signal);
  const lock = await acquire(root);
  let runtime;
  let committedResult;
  const verify = async pythonPath => {
    abort(signal);
    const dependencies = await verifyPython(pythonPath, { signal });
    abort(signal);
    if (dependencies?.ytDlp !== true || dependencies?.docx !== true) {
      throw fail('MANAGED_VERIFY_FAILED', '模块及 DOCX 回读验证未成功。');
    }
  };
  try {
    let existing;
    try { existing = await readManagedPython(root, { arch }); }
    catch (error) {
      if (!['MANAGED_INVALID_POINTER', 'MANAGED_INVALID_OWNER', 'MANAGED_INVALID_FILE', 'MANAGED_UNSAFE_PATH'].includes(error.code)) throw error;
      // Only the new directory will be touched; no corrupt old tree is repaired
      // in place. Recheck the active file itself before continuing.
      await regularFile(join(root, POINTER), { optional: true, maxBytes: MAX_JSON });
    }
    abort(signal);
    if (existing) {
      try {
        await verify(existing);
        committedResult = result(existing);
        return committedResult;
      }
      catch (error) {
        abort(signal);
        if (error?.name === 'AbortError' || /^(cancelled|process_not_stopped|MANAGED_ABORTED)$/i.test(error?.code || '')) throw error;
        // A failed dependency probe gets a fresh version, never an in-place fix.
      }
    }
    const { manifest, hash } = await lockManifest();
    const platform = manifest.platforms[arch];
    const installationId = randomUUID();
    const directory = `cpython-${VERSION}-win-${arch}-${installationId}`;
    runtime = join(root, 'runtimes', directory);
    await ensureDirectories(join(root, 'runtimes'));
    abort(signal);
    // Non-recursive, exclusive directory creation: never merge with an old env.
    await mkdir(runtime, { mode: 0o700 });
    await directories(runtime);
    const marker = { schema: 1, kind: KIND, arch, version: VERSION, directory,
      lockSha256: hash, installationId, stateRoot: comparable(root) };
    const fetch = async artifact => {
      abort(signal);
      const bytes = await downloadImpl(Object.freeze({ ...artifact }), { signal, proxy,
        onProgress: progress => {
          abort(signal);
          const received = Number.isSafeInteger(progress?.received) && progress.received >= 0 ? progress.received : 0;
          const total = Number.isSafeInteger(progress?.total) && progress.total >= 0 ? progress.total : artifact.size;
          onProgress(`正在下载固定运行环境文件：${received}/${total} 字节。`);
        } });
      abort(signal);
      if (!Buffer.isBuffer(bytes)) throw fail('MANAGED_INVALID_DOWNLOAD', '下载结果不是 Buffer。');
      return bytes;
    };
    onProgress('正在准备固定版本的官方私有 Python。');
    await unpack(await fetch(platform.python), runtime, new Map(), { signal });
    const pythonPath = join(runtime, 'python.exe');
    await regularFile(pythonPath);
    await regularFile(join(runtime, 'python314.zip'));
    // The official embed contains this file. Rewrite only that exact owned file.
    const pthPath = join(runtime, 'python314._pth');
    const pthIdentity = await regularFile(pthPath);
    const pth = await open(pthPath, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await pth.stat();
      const current = await regularFile(pthPath);
      if (!opened.isFile() || opened.nlink !== 1 || !identity(pthIdentity, opened) || !identity(opened, current)) {
        throw fail('MANAGED_INVALID_FILE', 'Python 路径隔离配置在打开期间被替换。');
      }
      abort(signal);
      const bytes = Buffer.from('python314.zip\n.\npackages\n');
      await pth.truncate(0); await pth.writeFile(bytes); await pth.sync();
    } finally { await pth.close(); }
    const packages = join(runtime, 'packages');
    await mkdir(packages, { mode: 0o700 });
    const names = new Map();
    for (const artifact of platform.wheels) {
      abort(signal);
      onProgress(`正在准备 ${artifact.name}。`);
      await unpack(await fetch(artifact), packages, names, { wheel: true, wheelName: artifact.name, signal });
    }
    abort(signal);
    await writeExclusive(join(runtime, OWNER), `${JSON.stringify(marker)}\n`);
    onProgress('正在验证模块导入及内存 DOCX 写入回读。');
    await verify(pythonPath);
    abort(signal);
    // Recheck every ancestor and owned file immediately before activation.
    await directories(runtime);
    await regularFile(pythonPath);
    const owner = await jsonFile(join(runtime, OWNER));
    if (!validMarker(owner, root, arch, hash) || !MARKER_KEYS.every(key => owner[key] === marker[key])) {
      throw fail('MANAGED_INVALID_OWNER', '验证期间运行环境归属标记被更改。');
    }
    const pointerPath = join(root, POINTER);
    await regularFile(pointerPath, { optional: true, maxBytes: MAX_JSON });
    const temporary = join(root, `.active-runtime-${randomUUID()}.tmp`);
    await writeExclusive(temporary, `${JSON.stringify(marker)}\n`);
    abort(signal);
    await directories(root);
    await regularFile(pointerPath, { optional: true, maxBytes: MAX_JSON });
    await regularFile(temporary, { maxBytes: MAX_JSON });
    await lock.validate();
    abort(signal);
    await rename(temporary, pointerPath);
    // Atomic rename is the commit boundary. Neither late cancellation nor a
    // lock cleanup failure may turn an activated environment into failure.
    committedResult = result(pythonPath);
    return committedResult;
  } catch (error) {
    if (runtime) {
      error.retainedRuntimePath = runtime;
      onProgress('准备失败；原激活环境未改变，本次已下载文件保留以便检查。');
    }
    if (!error.code?.startsWith('MANAGED_')) {
      throw fail('MANAGED_PREPARE_FAILED', `${error.message || '私有运行环境准备失败。'}${runtime ? ' 原环境未改变，本次文件已保留。' : ''}`, error);
    }
    throw error;
  } finally {
    try { await lock.release(); }
    catch (error) {
      if (!committedResult) throw error;
      committedResult.warnings = ['运行环境已激活，但安装锁释放未完成；未删除归属不明的锁文件。'];
    }
  }
}
