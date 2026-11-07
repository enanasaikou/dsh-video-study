import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readZipEntries, extractZip, downloadVerified } from '../lib/portable-archive.mjs';

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function zip(files, { comment = '', descriptor = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.data || '');
    const method = file.method ?? 8, compressed = file.payload ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = crc32(data), flags = file.flags ?? (0x800 | (descriptor ? 8 : 0));
    const extra = file.extra || Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    let desc = Buffer.alloc(0);
    if (descriptor) {
      desc = Buffer.alloc(16); desc.writeUInt32LE(0x08074b50);
      desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(compressed.length, 8); desc.writeUInt32LE(data.length, 12);
    }
    locals.push(local, name, extra, compressed, desc);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(file.attrs ?? ((file.name.endsWith('/') ? 0x41ed0010 : 0x81a40000) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + compressed.length + desc.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22), commentBytes = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, central, end, commentBytes]);
}
function centralOffset(buffer) { return buffer.readUInt32LE(buffer.length - 6); }
const code = expected => error => error.code === expected && error.message === expected;

for (const method of [0, 8]) {
  test(`ZIP store/deflate ${method}、UTF8、目录与顺序`, () => {
    const entries = readZipEntries(zip([{ name: '包/', method }, { name: '包/file.txt', data: '你好', method }, { name: 'empty', method }]));
    assert.deepEqual(entries.map(entry => [entry.name, entry.data.toString()]), [['包/file.txt', '你好'], ['empty', '']]);
  });
}
test('ZIP 数据描述符与归档注释', () => {
  assert.equal(readZipEntries(zip([{ name: 'a', data: 'abc' }], { descriptor: true, comment: 'comment' }))[0].data.toString(), 'abc');
  assert.deepEqual(readZipEntries(zip([])), []);
});
test('ZIP 隐式目录允许后续同拼写显式目录', () => {
  assert.equal(readZipEntries(zip([{ name: 'a/b' }, { name: 'a/' }])).length, 1);
});
for (const name of ['../x', '/x', 'C:/x', 'a\\b', 'a:b', 'a//b', 'a/./b', 'a/../b', 'a.', 'a ', 'CON', 'con.txt', 'LPT1', 'COM9.zip', 'AUX', 'nul', 'CONIN$', 'COM¹', 'a\0b', 'a?b', 'a\nb', 'e\u0301']) {
  test(`ZIP Windows/穿越路径拒绝 ${JSON.stringify(name)}`, () => assert.throws(() => readZipEntries(zip([{ name }])), code('ARCHIVE_PATH')));
}
for (const names of [['a', 'a'], ['a', 'A'], ['I', 'ı'], ['S', 'ſ'], ['a', 'a/b'], ['a/b', 'a'], ['a/', 'A/'], ['a/x', 'A/y'], ['a/', 'a/']]) {
  test(`ZIP 重复/前缀/大小写碰撞 ${names.join(',')}`, () => assert.throws(() => readZipEntries(zip(names.map(name => ({ name })))), code('ARCHIVE_COLLISION')));
}
for (const attrs of [0xa1ff0000, 0x61ff0000, 0x81a40400]) {
  test(`ZIP 链接/特殊文件拒绝 ${attrs}`, () => assert.throws(() => readZipEntries(zip([{ name: 'a', attrs }])), code('ARCHIVE_LINK')));
}
test('ZIP 加密/不支持算法/ZIP64/多磁盘拒绝', () => {
  for (const file of [{ flags: 0x801 }, { method: 99 }, { extra: Buffer.from([1, 0, 0, 0]) }]) assert.throws(() => readZipEntries(zip([{ name: 'a', ...file }])), code('ARCHIVE_UNSUPPORTED'));
  const disks = zip([{ name: 'a' }]); disks.writeUInt16LE(1, disks.length - 18);
  assert.throws(() => readZipEntries(disks), code('ARCHIVE_UNSUPPORTED'));
  const zip64 = zip([{ name: 'a' }]); zip64.writeUInt32LE(0xffffffff, centralOffset(zip64) + 24);
  assert.throws(() => readZipEntries(zip64), code('ARCHIVE_UNSUPPORTED'));
});
test('ZIP 中央/本地头各关键字段必须一致', () => {
  for (const offset of [4, 6, 8, 10, 12, 14, 18, 22, 30]) {
    const data = zip([{ name: 'a', data: 'abc' }]); data[offset] ^= 1;
    assert.throws(() => readZipEntries(data), error => error.code.startsWith('ARCHIVE_'));
  }
});
test('ZIP CRC、实际大小、截断、尾随垃圾、重复local offset、坏extra', () => {
  const crc = zip([{ name: 'a', data: 'abc', method: 0 }]); crc[31] ^= 1;
  assert.throws(() => readZipEntries(crc), code('ARCHIVE_CRC'));
  const size = zip([{ name: 'a', data: 'abc' }]); size.writeUInt32LE(4, 22); size.writeUInt32LE(4, centralOffset(size) + 24);
  assert.throws(() => readZipEntries(size), code('ARCHIVE_SIZE'));
  const valid = zip([{ name: 'a' }]);
  for (let n = 0; n < valid.length; n++) assert.throws(() => readZipEntries(valid.subarray(0, n)), error => error.code.startsWith('ARCHIVE_'));
  assert.throws(() => readZipEntries(Buffer.concat([valid, Buffer.from('x')])), code('ARCHIVE_INVALID'));
  const offsets = zip([{ name: 'a' }, { name: 'b' }]); offsets.writeUInt32LE(0, centralOffset(offsets) + 47 + 42);
  assert.throws(() => readZipEntries(offsets), code('ARCHIVE_INVALID'));
  assert.throws(() => readZipEntries(zip([{ name: 'a', extra: Buffer.from([2, 0, 1, 0]) }])), code('ARCHIVE_INVALID'));
});
test('ZIP 配额和高压缩率压缩炸弹在解压前受限', () => {
  const bomb = zip([{ name: 'a', data: 'x'.repeat(1024 * 1024) }]);
  assert.throws(() => readZipEntries(bomb, { maxUncompressedBytes: 100 }), code('ARCHIVE_LIMIT'));
  assert.throws(() => readZipEntries(zip([{ name: 'a' }]), { maxFiles: 0 }), code('ARCHIVE_LIMIT'));
  const lie = Buffer.from(bomb); lie.writeUInt32LE(1, 22); lie.writeUInt32LE(1, centralOffset(lie) + 24);
  assert.throws(() => readZipEntries(lie), code('ARCHIVE_INVALID'));
});
test('ZIP deflate尾随垃圾和错误压缩流拒绝', () => {
  const data = Buffer.from('abc');
  for (const payload of [Buffer.concat([deflateRawSync(data), Buffer.from('garbage')]), Buffer.from('not deflate')]) {
    assert.throws(() => readZipEntries(zip([{ name: 'a', data, payload }])), code('ARCHIVE_INVALID'));
  }
});
test('ZIP 非UTF8和Unicode覆盖扩展拒绝', () => {
  const bad = zip([{ name: 'é', flags: 0 }]);
  assert.throws(() => readZipEntries(bad), code('ARCHIVE_PATH'));
  assert.throws(() => readZipEntries(zip([{ name: 'a', extra: Buffer.from([0x75, 0x70, 0, 0]) }])), code('ARCHIVE_UNSUPPORTED'));
});
test('ZIP 独占新目标、安全嵌套写入、不删除已有目录', async () => {
  const parent = await fs.mkdtemp(path.resolve('tests/.portable-archive-'));
  const target = path.join(parent, 'new');
  try {
    const buffer = zip([{ name: 'a/b.txt', data: 'data' }]);
    assert.equal(await extractZip(buffer, target), 1);
    assert.equal(await fs.readFile(path.join(target, 'a', 'b.txt'), 'utf8'), 'data');
    await assert.rejects(extractZip(buffer, target), code('ARCHIVE_DESTINATION'));
    assert.equal(await fs.readFile(path.join(target, 'a', 'b.txt'), 'utf8'), 'data');
    await assert.rejects(extractZip(zip([{ name: '../bad' }]), path.join(parent, 'unsafe')), code('ARCHIVE_PATH'));
    await assert.rejects(fs.stat(path.join(parent, 'unsafe')), { code: 'ENOENT' });
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
test('ZIP 祖先链接/Windows junction拒绝', async t => {
  const parent = await fs.mkdtemp(path.resolve('tests/.portable-archive-'));
  try {
    const real = path.join(parent, 'real'), link = path.join(parent, 'link');
    await fs.mkdir(real);
    try { await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前沙箱不允许创建链接'); return; } throw error; }
    await assert.rejects(extractZip(zip([{ name: 'a' }]), path.join(link, 'new')), code('ARCHIVE_DESTINATION'));
    assert.deepEqual(await fs.readdir(real), []);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

const content = Buffer.from('verified offline artifact');
function manifest(overrides = {}) { return { url: 'https://www.python.org/ftp/python/test.zip', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), ...overrides }; }
function emitter() { const value = new EventEmitter(); value.destroyed = false; value.destroy = () => { value.destroyed = true; }; return value; }
function transport({ chunks = [content], statusCode = 200, headers = {}, error, hang = false } = {}) {
  const calls = [];
  const httpsRequest = (options, callback) => {
    const req = emitter(); calls.push({ options, req });
    req.end = () => queueMicrotask(() => {
      if (error) { req.emit('error', error); return; }
      if (hang) return;
      const res = emitter(); res.statusCode = statusCode; res.headers = headers; calls.at(-1).res = res;
      callback(res);
      for (const chunk of chunks) if (!res.destroyed) res.emit('data', chunk);
      if (!res.destroyed) res.emit('end');
    });
    return req;
  };
  return { calls, httpsRequest };
}
test('下载仅显式 HTTPS，固定 TLS，无环境代理/cookie/netrc', async () => {
  const fake = transport({ headers: { 'content-length': String(content.length) }, chunks: [content.subarray(0, 3), content.subarray(3)] });
  const progress = [];
  const old = process.env.HTTPS_PROXY; process.env.HTTPS_PROXY = 'http://forbidden.invalid:9876';
  try {
    assert.deepEqual(await downloadVerified(manifest(), { httpsRequest: fake.httpsRequest, onProgress: value => progress.push(value) }), content);
    const opts = fake.calls[0].options;
    assert.equal(opts.hostname, 'www.python.org'); assert.equal(opts.port, 443); assert.equal(opts.agent, false);
    assert.equal(opts.rejectUnauthorized, true); assert.equal(opts.minVersion, 'TLSv1.2'); assert.equal(opts.servername, opts.hostname);
    assert.equal(opts.method, 'GET'); assert.equal(opts.headers['Accept-Encoding'], 'identity');
    assert.equal(opts.headers.Cookie, undefined); assert.equal(opts.auth, undefined);
    assert.deepEqual(progress, [{ received: 3, total: content.length }, { received: content.length, total: content.length }]);
  } finally { if (old === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = old; }
});
for (const url of ['http://www.python.org/a', 'https://python.org/a', 'https://evil.invalid/a', 'https://www.python.org.evil.invalid/a', 'https://files.pythonhosted.org:444/a', 'https://u:p@www.python.org/a', 'https://@www.python.org/a', 'https://:@www.python.org/a', 'https:/www.python.org/a', 'https://www.python.org/a?token=x', 'https://www.python.org/a#x', 'https://www.python.org/a?', 'https://www.python.org/a#', 'https://www.python.org\\a', 'https://www.python.org/\na']) {
  test(`下载拒绝 URL ${JSON.stringify(url)}`, async () => {
    const fake = transport();
    await assert.rejects(downloadVerified(manifest({ url }), { httpsRequest: fake.httpsRequest }), code('DOWNLOAD_URL'));
    assert.equal(fake.calls.length, 0);
  });
}
test('下载允许另一个固定主机以及显式443端口', async () => {
  const fake = transport();
  await downloadVerified(manifest({ url: 'https://files.pythonhosted.org:443/packages/a.whl' }), { httpsRequest: fake.httpsRequest });
  assert.equal(fake.calls[0].options.hostname, 'files.pythonhosted.org');
});
test('下载拒绝无效manifest、非法预算、额外可覆盖选项', async () => {
  for (const override of [{ sha256: 'bad' }, { size: -1 }, { size: 0 }, { size: 1.5 }]) await assert.rejects(downloadVerified(manifest(override)), code('DOWNLOAD_MANIFEST'));
  await assert.rejects(downloadVerified(manifest(), { timeoutMs: 0 }), code('DOWNLOAD_TIMEOUT'));
  await assert.rejects(downloadVerified(manifest(), { rejectUnauthorized: false }), code('DOWNLOAD_OPTIONS'));
  await assert.rejects(downloadVerified(manifest(), { signal: {} }), code('DOWNLOAD_OPTIONS'));
  await assert.rejects(downloadVerified(manifest(), { httpsRequest: 'not a function' }), code('DOWNLOAD_OPTIONS'));
});
for (const statusCode of [201, 301, 302, 307, 308, 401, 404, 500]) {
  test(`下载响应状态/重定向 ${statusCode} 拒绝且不跟随`, async () => {
    const fake = transport({ statusCode, headers: { location: 'https://evil.invalid/' } });
    await assert.rejects(downloadVerified(manifest(), { httpsRequest: fake.httpsRequest }), code('DOWNLOAD_STATUS'));
    assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].req.destroyed, true);
  });
}
test('下载字节数、声明长度、压缩编码和哈希验证', async () => {
  for (const scenario of [{ chunks: [] }, { chunks: [Buffer.concat([content, content])] }, { headers: { 'content-length': '999' } }, { headers: { 'content-length': 'abc' } }, { headers: { 'content-encoding': 'gzip' } }]) {
    const fake = transport(scenario);
    await assert.rejects(downloadVerified(manifest(), { httpsRequest: fake.httpsRequest }), code('DOWNLOAD_SIZE'));
  }
  const fake = transport();
  await assert.rejects(downloadVerified(manifest({ sha256: '0'.repeat(64) }), { httpsRequest: fake.httpsRequest }), code('DOWNLOAD_HASH'));
});
test('下载响应中止、提前close和流错误均静态拒绝', async () => {
  for (const event of ['aborted', 'close', 'error']) {
    const httpsRequest = (options, callback) => {
      const req = emitter();
      req.end = () => queueMicrotask(() => {
        const res = emitter(); res.statusCode = 200; res.headers = {};
        callback(res); res.emit(event, new Error('private endpoint'));
      });
      return req;
    };
    await assert.rejects(downloadVerified(manifest(), { httpsRequest }), code('DOWNLOAD_NETWORK'));
  }
});
test('下载超时、预先abort、运行中abort、回调异常', async () => {
  const timeout = transport({ hang: true });
  await assert.rejects(downloadVerified(manifest(), { httpsRequest: timeout.httpsRequest, timeoutMs: 5 }), code('DOWNLOAD_TIMEOUT'));
  assert.equal(timeout.calls[0].req.destroyed, true);
  const pre = new AbortController(); pre.abort(); const fake = transport();
  await assert.rejects(downloadVerified(manifest(), { httpsRequest: fake.httpsRequest, signal: pre.signal }), code('DOWNLOAD_ABORTED'));
  assert.equal(fake.calls.length, 0);
  const running = new AbortController(); const ongoing = transport();
  await assert.rejects(downloadVerified(manifest(), { httpsRequest: ongoing.httpsRequest, signal: running.signal, onProgress: () => running.abort() }), code('DOWNLOAD_ABORTED'));
  const callback = transport();
  await assert.rejects(downloadVerified(manifest(), { httpsRequest: callback.httpsRequest, onProgress: () => { throw new Error('secret'); } }), code('DOWNLOAD_PROGRESS'));
});
test('下载网络/TLS错误静态化，不包含底层秘密', async () => {
  for (const [cause, expected] of [[Object.assign(new Error('secret proxy url'), { code: 'ECONNRESET' }), 'DOWNLOAD_NETWORK'], [Object.assign(new Error('secret cert'), { code: 'CERT_HAS_EXPIRED' }), 'DOWNLOAD_TLS']]) {
    const fake = transport({ error: cause });
    await assert.rejects(downloadVerified(manifest(), { httpsRequest: fake.httpsRequest }), code(expected));
  }
});
for (const proxy of ['https://localhost:8080', 'http://u:p@localhost:80', 'localhost:8080', 'http://localhost', 'http://localhost:8080/path', 'http://localhost:8080/?x', 'http://localhost:8080/#x', 'socks5://localhost:1080', 'http://localhost:65536']) {
  test(`下载拒绝代理 ${proxy}`, async () => assert.rejects(downloadVerified(manifest(), { proxy }), code('DOWNLOAD_PROXY')));
}
function proxyTransport({ statusCode = 200, authorized = true, hang = false, head = Buffer.alloc(0), tlsError = false } = {}) {
  const fake = transport(), connectCalls = [], tlsCalls = [];
  const tunnel = new PassThrough(), secure = new PassThrough(); secure.authorized = authorized;
  const httpRequest = options => {
    const req = emitter(); connectCalls.push({ options, req });
    req.end = () => { if (!hang) queueMicrotask(() => req.emit('connect', { statusCode }, tunnel, head)); };
    return req;
  };
  const tlsConnect = options => {
    tlsCalls.push(options);
    queueMicrotask(() => tlsError ? secure.emit('error', new Error('secret')) : secure.emit('secureConnect'));
    return secure;
  };
  return { ...fake, httpRequest, tlsConnect, connectCalls, tlsCalls, tunnel, secure };
}
test('显式HTTP CONNECT后强校验TLS，再请求固定目标', async () => {
  const fake = proxyTransport();
  assert.deepEqual(await downloadVerified(manifest(), { proxy: 'http://127.0.0.1:80', httpsRequest: fake.httpsRequest, httpRequest: fake.httpRequest, tlsConnect: fake.tlsConnect }), content);
  const connect = fake.connectCalls[0].options, tlsOptions = fake.tlsCalls[0];
  assert.equal(connect.method, 'CONNECT'); assert.equal(connect.path, 'www.python.org:443'); assert.equal(connect.hostname, '127.0.0.1'); assert.equal(connect.port, 80);
  assert.equal(connect.headers['Proxy-Authorization'], undefined); assert.equal(connect.agent, false);
  assert.equal(tlsOptions.socket, fake.tunnel); assert.equal(tlsOptions.rejectUnauthorized, true); assert.equal(tlsOptions.servername, 'www.python.org'); assert.equal(tlsOptions.minVersion, 'TLSv1.2');
  assert.deepEqual(tlsOptions.ALPNProtocols, ['http/1.1']);
  assert.equal(fake.calls[0].options.agent.createConnection(), fake.secure);
});
test('代理拒绝状态、额外头部字节、不授权证书和TLS错误', async () => {
  for (const [scenario, expected] of [[{ statusCode: 407 }, 'DOWNLOAD_PROXY'], [{ head: Buffer.from('x') }, 'DOWNLOAD_PROXY'], [{ authorized: false }, 'DOWNLOAD_TLS'], [{ tlsError: true }, 'DOWNLOAD_TLS']]) {
    const fake = proxyTransport(scenario);
    await assert.rejects(downloadVerified(manifest(), { proxy: 'http://localhost:8080', httpsRequest: fake.httpsRequest, httpRequest: fake.httpRequest, tlsConnect: fake.tlsConnect }), code(expected));
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.tunnel.destroyed, true);
  }
});
test('CONNECT阶段abort及时关闭代理且不开始TLS/下载', async () => {
  const fake = proxyTransport({ hang: true }), controller = new AbortController();
  const promise = downloadVerified(manifest(), { proxy: 'http://localhost:8080', signal: controller.signal, httpsRequest: fake.httpsRequest, httpRequest: fake.httpRequest, tlsConnect: fake.tlsConnect });
  controller.abort();
  await assert.rejects(promise, code('DOWNLOAD_ABORTED'));
  assert.equal(fake.connectCalls[0].req.destroyed, true); assert.equal(fake.tlsCalls.length, 0); assert.equal(fake.calls.length, 0);
});
