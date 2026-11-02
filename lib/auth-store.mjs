import { spawn } from 'node:child_process';
import { join } from 'node:path';

export class AuthStoreError extends Error {
  constructor() { super('安全登录存储不可用。'); this.code = 'storage_error'; }
}

// Constant worker program; the credential is only sent through stdin.
const DPAPI_PROGRAM = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Security
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $entropy=[System.Text.Encoding]::UTF8.GetBytes('dsh-video-study:bilibili:v1')
  $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if($r.action -eq 'protect') {
    $bytes=[System.Text.Encoding]::UTF8.GetBytes([string]$r.value)
    $out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,$scope)
    $result=@{ok=$true;value=[Convert]::ToBase64String($out)}
  } elseif($r.action -eq 'unprotect') {
    $bytes=[Convert]::FromBase64String([string]$r.value)
    $out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,$scope)
    $result=@{ok=$true;value=[System.Text.Encoding]::UTF8.GetString($out)}
  } else { throw 'invalid action' }
  [Console]::Write(($result | ConvertTo-Json -Compress))
} catch { [Console]::Write('{"ok":false,"error":"storage_error"}'); exit 1 }
`;

const validSession = value => typeof value === 'string' && value.length > 0 && value.length <= 16000
  && !/[\x00-\x20\x7f-\uffff;]/.test(value);
const fail = () => { throw new AuthStoreError(); };
const guard = async operation => { try { return await operation(); } catch { fail(); } };

/** CurrentUser DPAPI only; no plaintext-at-rest fallback. */
export function createDpapiCrypto({ platform = process.platform, spawnImpl = spawn,
  windowsRoot = process.env.SystemRoot || 'C:\\Windows', timeoutMs = 10000 } = {}) {
  const supported = platform === 'win32';
  function run(action, value) {
    if (!supported || typeof value !== 'string' || value.length > 65536) return Promise.reject(new AuthStoreError());
    return new Promise((resolve, reject) => {
      let child, bytes = 0, chunks = [], done = false, timer;
      const finish = (error, output) => { if (done) return; done = true; clearTimeout(timer); chunks = [];
        error ? reject(new AuthStoreError()) : resolve(output); };
      try {
        child = spawnImpl(join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROGRAM],
          { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { finish(true); return; }
      const stop = () => { try { child.kill('SIGKILL'); } catch {} finish(true); };
      timer = setTimeout(stop, timeoutMs);
      child.once('error', () => finish(true));
      child.stdin.on('error', stop);
      child.stdout.on('data', chunk => { if (done) return; bytes += chunk.length;
        if (bytes > 131072) stop(); else chunks.push(Buffer.from(chunk)); });
      child.once('close', code => {
        if (done) return;
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/, ''));
          if (code !== 0 || result.ok !== true || typeof result.value !== 'string') throw new Error();
          finish(false, result.value);
        } catch { finish(true); }
      });
      child.stdin.end(JSON.stringify({ action, value }));
    });
  }
  return { supported, protect: value => run('protect', value), unprotect: value => run('unprotect', value) };
}

/** Envelope store only: host credentials are YAML, not a vault; only DPAPI ciphertext is persisted. */
export function createAuthStore({ credentials = () => null, key, crypto = createDpapiCrypto() } = {}) {
  let memory = null, cryptoWorking = crypto.supported === true;
  let serial = Promise.resolve();
  const exclusive = fn => { const result = serial.then(fn, fn); serial = result.catch(() => {}); return result; };
  const provider = () => { try { return typeof credentials === 'function' ? credentials() : credentials; } catch { return null; } };
  const usable = service => Boolean(service && typeof service.readRecord === 'function' && typeof service.modifyRecord === 'function');
  const capabilities = () => ({ encrypted: cryptoWorking, persistent: cryptoWorking && usable(provider()) });
  const writeEnvelope = (service, payload) => guard(() => service.modifyRecord(key, async () => ({ kind: 'grant', payload })));
  return {
    capabilities,
    clear: () => exclusive(async () => {
      const service = provider();
      if (usable(service)) {
        if (typeof service.deleteRecord !== 'function') fail();
        await guard(() => service.deleteRecord(key));
      }
      memory = null;
    }),
    load: () => exclusive(async () => {
      if (memory !== null) return { ...memory };
      const service = provider();
      if (!usable(service)) return null;
      const record = await guard(() => service.readRecord(key));
      if (!record) return null;
      const payload = record.kind === 'grant' ? record.payload : null;
      if (!payload || payload.version !== 1) fail();
      if (payload.source === 'anonymous') { memory = { source: 'anonymous' }; return { ...memory }; }
      if (payload.source !== 'managed' || payload.algorithm !== 'dpapi-current-user' || typeof payload.ciphertext !== 'string') fail();
      const sessdata = await guard(() => crypto.unprotect(payload.ciphertext));
      if (!validSession(sessdata)) fail();
      memory = { source: 'managed', sessdata };
      return { ...memory };
    }),
    save: record => exclusive(async () => {
      if (!record || !['anonymous', 'managed'].includes(record.source)) fail();
      const service = provider();
      if (record.source === 'anonymous') {
        if (usable(service)) await writeEnvelope(service, { version: 1, source: 'anonymous' });
        memory = { source: 'anonymous' };
        return { persistent: Boolean(usable(service)) };
      }
      if (!validSession(record.sessdata)) fail();
      let ciphertext;
      if (cryptoWorking && usable(service)) {
        try { ciphertext = await crypto.protect(record.sessdata); }
        catch { cryptoWorking = false; }
      }
      if (ciphertext !== undefined) {
        if (typeof ciphertext !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(ciphertext) || ciphertext.includes(record.sessdata)) fail();
        await writeEnvelope(service, { version: 1, source: 'managed', algorithm: 'dpapi-current-user', ciphertext });
        memory = { source: 'managed', sessdata: record.sessdata };
        return { persistent: true };
      }
      // Invalidate the old persisted account before accepting a memory-only login.
      if (usable(service)) await writeEnvelope(service, { version: 1, source: 'managed', memoryOnly: true });
      memory = { source: 'managed', sessdata: record.sessdata };
      return { persistent: false };
    }),
  };
}
