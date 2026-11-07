import { inflateRawSync } from 'node:zlib';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';

// 所有公开错误只包含固定消息，不回显 URL、路径、代理或底层网络错误。
function failure(code) { return Object.assign(new Error(code), { code }); }
function check(condition, code = 'ARCHIVE_INVALID') { if (!condition) throw failure(code); }
function range(buffer, offset, length) {
  check(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= buffer.length);
  return buffer.subarray(offset, offset + length);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function validateExtra(extra) {
  for (let p = 0; p < extra.length;) {
    check(p + 4 <= extra.length);
    const id = extra.readUInt16LE(p), size = extra.readUInt16LE(p + 2);
    check(id !== 1, 'ARCHIVE_UNSUPPORTED'); // ZIP64
    check(p + 4 + size <= extra.length);
    // 不接受可覆盖文件名的 Unicode path 扩展；UTF-8 主文件名已受验证。
    check(id !== 0x7075, 'ARCHIVE_UNSUPPORTED');
    p += 4 + size;
  }
}
function safeName(bytes, flags) {
  check(bytes.length > 0, 'ARCHIVE_PATH');
  check((flags & 0x800) || bytes.every(byte => byte < 128), 'ARCHIVE_PATH');
  const name = bytes.toString('utf8');
  check(Buffer.from(name, 'utf8').equals(bytes), 'ARCHIVE_PATH');
  check(name === name.normalize('NFC') && !/[\\:\x00-\x1f\x7f-\x9f<>"|?*]/u.test(name), 'ARCHIVE_PATH');
  check(!name.startsWith('/') && name.length <= 2048, 'ARCHIVE_PATH');
  const directory = name.endsWith('/');
  const components = (directory ? name.slice(0, -1) : name).split('/');
  for (const part of components) {
    check(part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && part.length <= 255, 'ARCHIVE_PATH');
    check(!/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part), 'ARCHIVE_PATH');
  }
  return { name, directory, components };
}

/** 严格解析 ZIP；仅支持单卷、非加密、非 ZIP64 的 store/deflate。 */
export function readZipEntries(buffer, { maxFiles = 10000, maxUncompressedBytes = 256 * 1024 * 1024 } = {}) {
  check(Buffer.isBuffer(buffer) && buffer.length >= 22);
  check(Number.isSafeInteger(maxFiles) && maxFiles >= 0 && Number.isSafeInteger(maxUncompressedBytes) && maxUncompressedBytes >= 0, 'ARCHIVE_LIMIT');
  let end = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 22 - 65535); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) { end = p; break; }
  }
  check(end >= 0);
  check(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0, 'ARCHIVE_UNSUPPORTED');
  const count = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), centralOffset = buffer.readUInt32LE(end + 16);
  check(count !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, 'ARCHIVE_UNSUPPORTED');
  check(count === buffer.readUInt16LE(end + 8));
  check(count <= maxFiles, 'ARCHIVE_LIMIT');
  check(centralOffset + centralSize === end);
  const records = [], names = new Map();
  let cursor = centralOffset, total = 0;
  for (let i = 0; i < count; i++) {
    const header = range(buffer, cursor, 46);
    check(header.readUInt32LE(0) === 0x02014b50);
    const flags = header.readUInt16LE(8), method = header.readUInt16LE(10), crc = header.readUInt32LE(16);
    const compressed = header.readUInt32LE(20), uncompressed = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28), extraLength = header.readUInt16LE(30), commentLength = header.readUInt16LE(32);
    const localOffset = header.readUInt32LE(42), attrs = header.readUInt32LE(38), mode = (attrs >>> 16) & 0xf000;
    check(header.readUInt16LE(34) === 0 && compressed !== 0xffffffff && uncompressed !== 0xffffffff && localOffset !== 0xffffffff, 'ARCHIVE_UNSUPPORTED');
    check(header.readUInt16LE(6) <= 20 && (flags & ~0x80e) === 0 && (flags & 1) === 0 && (method === 0 || method === 8), 'ARCHIVE_UNSUPPORTED');
    check(method !== 0 || (flags & 6) === 0, 'ARCHIVE_UNSUPPORTED');
    check(mode === 0 || mode === 0x8000 || mode === 0x4000, 'ARCHIVE_LINK');
    check(!(attrs & 0x400), 'ARCHIVE_LINK'); // DOS reparse-point 标记
    const nameBytes = range(buffer, cursor + 46, nameLength);
    const info = safeName(nameBytes, flags);
    check(mode !== 0x4000 || info.directory, 'ARCHIVE_PATH');
    check(mode !== 0x8000 || !info.directory, 'ARCHIVE_PATH');
    check(!(attrs & 0x10) || info.directory, 'ARCHIVE_PATH');
    if (info.directory) check(uncompressed === 0, 'ARCHIVE_INVALID');
    for (let j = 0; j < info.components.length; j++) {
      // Windows 使用大写表折叠；额外转小写也覆盖 Kelvin/长 s 等 Unicode 等价。
      const key = info.components.slice(0, j + 1).join('/').toUpperCase().toLowerCase();
      const last = j === info.components.length - 1, directory = !last || info.directory;
      const existing = names.get(key);
      if (existing) {
        check(existing.directory && directory && !(last && existing.explicit), 'ARCHIVE_COLLISION');
        check(existing.spelling === info.components.slice(0, j + 1).join('/'), 'ARCHIVE_COLLISION');
        if (last) existing.explicit = true;
      } else names.set(key, { directory, explicit: last, spelling: info.components.slice(0, j + 1).join('/') });
    }
    validateExtra(range(buffer, cursor + 46 + nameLength, extraLength));
    total += uncompressed;
    check(total <= maxUncompressedBytes, 'ARCHIVE_LIMIT');
    check(method !== 0 || compressed === uncompressed);
    records.push({ ...info, nameBytes, flags, method, crc, compressed, uncompressed, localOffset, version: header.readUInt16LE(6), timestamp: header.readUInt32LE(12) });
    cursor += 46 + nameLength + extraLength + commentLength;
    check(cursor <= centralOffset + centralSize);
  }
  check(cursor === centralOffset + centralSize);
  let localCursor = 0;
  for (const entry of [...records].sort((a, b) => a.localOffset - b.localOffset)) {
    check(entry.localOffset === localCursor);
    const local = range(buffer, localCursor, 30);
    check(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(4) === entry.version && local.readUInt16LE(6) === entry.flags && local.readUInt16LE(8) === entry.method && local.readUInt32LE(10) === entry.timestamp);
    const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28);
    check(range(buffer, localCursor + 30, nameLength).equals(entry.nameBytes));
    validateExtra(range(buffer, localCursor + 30 + nameLength, extraLength));
    const values = [entry.crc, entry.compressed, entry.uncompressed];
    for (let j = 0; j < 3; j++) {
      const value = local.readUInt32LE(14 + j * 4);
      check(value === values[j] || ((entry.flags & 8) && value === 0));
    }
    const start = localCursor + 30 + nameLength + extraLength;
    entry.payload = range(buffer, start, entry.compressed);
    localCursor = start + entry.compressed;
    if (entry.flags & 8) {
      if (range(buffer, localCursor, 4).readUInt32LE(0) === 0x08074b50) localCursor += 4;
      const descriptor = range(buffer, localCursor, 12);
      check(values.every((value, i) => descriptor.readUInt32LE(i * 4) === value));
      localCursor += 12;
    }
    check(localCursor <= centralOffset);
  }
  check(localCursor === centralOffset);
  const result = [];
  for (const entry of records) {
    let data;
    try {
      if (entry.method === 0) data = Buffer.from(entry.payload);
      else {
        const inflated = inflateRawSync(entry.payload, { maxOutputLength: Math.max(1, entry.uncompressed), info: true });
        check(inflated.engine.bytesWritten === entry.compressed);
        data = inflated.buffer;
      }
    } catch (error) {
      if (error?.code?.startsWith('ARCHIVE_')) throw error;
      throw failure('ARCHIVE_INVALID');
    }
    check(data.length === entry.uncompressed, 'ARCHIVE_SIZE');
    check(crc32(data) === entry.crc, 'ARCHIVE_CRC');
    if (!entry.directory) result.push({ name: entry.name, data });
  }
  return result;
}

async function assertAncestors(directory) {
  const resolved = path.resolve(directory), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    check(!stat.isSymbolicLink() && stat.isDirectory(), 'ARCHIVE_DESTINATION');
    // 部分 Windows 宿主的 lstat 包装会跟随 junction；同时核对真实路径。
    const actual = await fs.realpath(current);
    const canonical = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
    check(canonical(actual) === canonical(current), 'ARCHIVE_DESTINATION');
  }
}
/** 创建全新目标，不删除/替换任何已有内容。调用方须拥有目标祖先，避免并发恶意重命名。 */
export async function extractZip(buffer, destination, options = {}) {
  const entries = readZipEntries(buffer, options);
  check(typeof destination === 'string' && destination.length > 0, 'ARCHIVE_DESTINATION');
  const root = path.resolve(destination);
  try {
    await assertAncestors(path.dirname(root));
    await fs.mkdir(root, { mode: 0o700 }); // 绝不使用 recursive，已有目标一律失败
    for (const entry of entries) {
      const target = path.join(root, ...entry.name.split('/'));
      const relative = path.relative(root, target);
      check(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'ARCHIVE_DESTINATION');
      let current = root;
      await assertAncestors(root);
      for (const part of entry.name.split('/').slice(0, -1)) {
        current = path.join(current, part);
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await assertAncestors(current);
      }
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(entry.data); } finally { await handle.close(); }
    }
  } catch (error) {
    if (error?.code?.startsWith('ARCHIVE_')) throw error;
    throw failure('ARCHIVE_DESTINATION');
  }
  return entries.length;
}

const HOSTS = new Set(['www.python.org', 'files.pythonhosted.org']);
function artifactUrl(artifact) {
  check(artifact && typeof artifact.url === 'string' && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(artifact.sha256) && Number.isSafeInteger(artifact.size) && artifact.size > 0, 'DOWNLOAD_MANIFEST');
  let url;
  try { url = new URL(artifact.url); } catch { throw failure('DOWNLOAD_URL'); }
  check(url.protocol === 'https:' && HOSTS.has(url.hostname) && (!url.port || url.port === '443') && !url.username && !url.password && !url.search && !url.hash, 'DOWNLOAD_URL');
  check(/^https:\/\//i.test(artifact.url) && !/^https:\/\/[^/]*@/i.test(artifact.url) && !artifact.url.includes('\\') && !/[\x00-\x20\x7f]/.test(artifact.url) && !artifact.url.includes('?') && !artifact.url.includes('#'), 'DOWNLOAD_URL');
  return url;
}
function proxyUrl(proxy) {
  if (!proxy) return null;
  check(typeof proxy === 'string' && /^http:\/\/(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]+\/?$/.test(proxy), 'DOWNLOAD_PROXY');
  let url;
  try { url = new URL(proxy); } catch { throw failure('DOWNLOAD_PROXY'); }
  check(url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && Number(url.port || 80) > 0 && Number(url.port || 80) <= 65535, 'DOWNLOAD_PROXY');
  return url;
}

/** testInjection 仅接受网络传输函数，不接受可覆盖生产 URL/TLS/请求参数的对象。 */
export async function downloadVerified(artifact, { signal, proxy = '', onProgress, timeoutMs = 120000, ...testInjection } = {}) {
  const url = artifactUrl(artifact), via = proxyUrl(proxy);
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647, 'DOWNLOAD_TIMEOUT');
  check(onProgress === undefined || typeof onProgress === 'function', 'DOWNLOAD_OPTIONS');
  check(signal === undefined || (signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function'), 'DOWNLOAD_OPTIONS');
  check(Object.keys(testInjection).every(key => ['httpsRequest', 'httpRequest', 'tlsConnect'].includes(key) && typeof testInjection[key] === 'function'), 'DOWNLOAD_OPTIONS');
  const httpsRequest = testInjection.httpsRequest || https.request;
  const httpRequest = testInjection.httpRequest || http.request;
  const tlsConnect = testInjection.tlsConnect || tls.connect;
  if (signal?.aborted) throw failure('DOWNLOAD_ABORTED');
  return new Promise((resolve, reject) => {
    let finished = false, request, connectRequest, secureSocket, tunnel, response, ownedAgent;
    const resources = () => [response, request, secureSocket, tunnel, connectRequest];
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      ownedAgent?.destroy();
      if (error) { for (const item of resources()) { try { item?.destroy(); } catch {} } reject(error); }
      else resolve(value);
    };
    const abort = () => finish(failure('DOWNLOAD_ABORTED'));
    const timer = setTimeout(() => finish(failure('DOWNLOAD_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const networkFailure = error => finish(failure(/^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(error?.code || '') ? 'DOWNLOAD_TLS' : 'DOWNLOAD_NETWORK'));
    const receive = res => {
      if (finished) { res.destroy(); return; }
      response = res;
      res.on('error', networkFailure);
      res.on('aborted', networkFailure);
      if (res.statusCode !== 200) { finish(failure('DOWNLOAD_STATUS')); return; }
      const length = res.headers['content-length'];
      if ((length !== undefined && (!/^[0-9]+$/.test(String(length)) || Number(length) !== artifact.size)) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        finish(failure('DOWNLOAD_SIZE')); return;
      }
      const hash = createHash('sha256'), chunks = [];
      let received = 0;
      res.on('data', chunk => {
        if (finished) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += data.length;
        if (received > artifact.size) { finish(failure('DOWNLOAD_SIZE')); return; }
        hash.update(data); chunks.push(data);
        if (onProgress) { try { onProgress({ received, total: artifact.size }); } catch { finish(failure('DOWNLOAD_PROGRESS')); } }
      });
      res.on('end', () => {
        if (finished) return;
        if (received !== artifact.size) { finish(failure('DOWNLOAD_SIZE')); return; }
        if (hash.digest('hex') !== artifact.sha256.toLowerCase()) { finish(failure('DOWNLOAD_HASH')); return; }
        finish(null, Buffer.concat(chunks, received));
      });
      res.on('close', () => { if (!finished) networkFailure(); });
    };
    const startHttps = socket => {
      if (finished) return;
      try {
        // agent:false 会新建默认 Agent 并忽略请求级 createConnection；CONNECT 必须使用专属 Agent。
        if (socket) {
          ownedAgent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          ownedAgent.createConnection = () => socket;
        }
        request = httpsRequest({ protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname,
          method: 'GET', agent: ownedAgent || false, rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: url.hostname,
          headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } }, receive);
        request.on('error', networkFailure);
        request.end();
      } catch { networkFailure(); }
    };
    if (!via) { startHttps(); return; }
    try {
      connectRequest = httpRequest({ protocol: 'http:', hostname: via.hostname.replace(/^\[|\]$/g, ''), port: Number(via.port || 80), method: 'CONNECT',
        path: `${url.hostname}:443`, agent: false, headers: { Host: `${url.hostname}:443` } });
      connectRequest.on('error', networkFailure);
      connectRequest.on('response', () => finish(failure('DOWNLOAD_PROXY')));
      connectRequest.on('connect', (res, socket, head) => {
        tunnel = socket;
        socket.on('error', networkFailure);
        if (finished) { socket.destroy(); return; }
        if (res.statusCode !== 200 || (head && head.length)) { finish(failure('DOWNLOAD_PROXY')); return; }
        try {
          secureSocket = tlsConnect({ socket, servername: url.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
          secureSocket.on('error', () => finish(failure('DOWNLOAD_TLS')));
          secureSocket.once('secureConnect', () => {
            if (!secureSocket.authorized) { finish(failure('DOWNLOAD_TLS')); return; }
            startHttps(secureSocket);
          });
        } catch { finish(failure('DOWNLOAD_TLS')); }
      });
      connectRequest.end();
    } catch { finish(failure('DOWNLOAD_PROXY')); }
  });
}
