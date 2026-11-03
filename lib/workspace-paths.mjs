import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

async function checkAncestors(root, create) {
  let current = parse(root).root;
  for (const part of [null, ...relative(current, root).split(sep).filter(Boolean)]) {
    if (part !== null) current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw new Error('task_directory_unavailable');
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('task_directory_unavailable'); }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('task_directory_unavailable');
    // Some Windows Node builds report junctions as plain directories. Compare
    // the canonical path as well, rather than trusting only isSymbolicLink().
    const canonical = await realpath(current);
    const comparable = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
    if (comparable(canonical) !== comparable(current)) throw new Error('task_directory_unavailable');
  }
}

/** Only creates directories beneath the explicitly selected task root. No temp/home fallback. */
export async function createScratchDirectory(base) {
  if (typeof base !== 'string' || !isAbsolute(base) || /[\x00-\x1f\x7f]/.test(base)
      || /^[\\/]{2}/.test(base) || base.split(/[\\/]/).includes('..')) throw new Error('invalid_task_directory');
  const root = resolve(base);
  // Read existing ancestors before creating anything (mkdir on a Windows volume root is not portable).
  await checkAncestors(root, true);
  const path = await mkdtemp(join(root, '.dsh-video-study-tmp-'));
  const identity = await lstat(path);
  let disposed = false;
  return { path, async dispose() {
    if (disposed) return;
    // Verify the exact generated child and every ancestor before removing anything.
    if (dirname(path) !== root || !path.startsWith(join(root, '.dsh-video-study-tmp-')))
      throw new Error('task_cleanup_refused');
    await checkAncestors(root, false);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') { disposed = true; return; } throw error; }
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino)
      throw new Error('task_cleanup_refused');
    await rm(path, { recursive: true, force: false });
    disposed = true;
  } };
}
