import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createScratchDirectory } from '../lib/workspace-paths.mjs';

// Only this test's mkdtemp root is written or recursively removed. Never touch a
// real workspace, profile or inherited TMP setting. Production Python is unused.
const fixtureLinks = new WeakMap();
async function isolated(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-paths-test-'));
  const canonicalRoot = await realpath(root);
  const links = []; fixtureLinks.set(t, links);
  t.after(async () => {
    assert.ok(isAbsolute(root));
    assert.equal(await realpath(root), canonicalRoot);
    assert.ok(relative(tmpdir(), root).startsWith('dsh-workspace-paths-test-'));
    // Unlink known fixture junctions before rm races them against their targets.
    // Windows Node can report junction lstat as a plain directory.
    for (const link of links) {
      assert.ok(nestedUnder(root, link));
      try { await (process.platform === 'win32' ? rmdir : unlink)(link); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function linkDirectory(target, path, t) {
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    fixtureLinks.get(t).push(path); return true;
  }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('OS does not permit test directory links'); return false; }
    throw error;
  }
}
const nestedUnder = (base, path) => {
  const suffix = relative(base, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
};

test('scratch helper creates unique isolated directories beneath the selected base', async t => {
  const root = await isolated(t), base = join(root, 'workspace', 'video-study', 'transcripts');
  const before = Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(key => [key, process.env[key]]));
  const scratches = await Promise.all(Array.from({ length: 6 }, () => createScratchDirectory(base)));
  assert.equal(new Set(scratches.map(value => value.path)).size, scratches.length);
  for (const scratch of scratches) {
    assert.equal(isAbsolute(scratch.path), true); assert.ok(nestedUnder(base, scratch.path));
    assert.equal((await lstat(scratch.path)).isDirectory(), true);
    await writeFile(join(scratch.path, 'owned.txt'), 'owned');
  }
  await Promise.all(scratches.map(value => value.dispose()));
  for (const scratch of scratches) await assert.rejects(access(scratch.path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(base), []);
  assert.deepEqual(Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(key => [key, process.env[key]])), before);
});

test('disposing one scratch keeps sibling requests and pre-existing output intact', async t => {
  const root = await isolated(t), base = join(root, 'documents');
  await mkdir(base); await writeFile(join(base, 'final.md'), 'keep final');
  const one = await createScratchDirectory(base), two = await createScratchDirectory(base);
  await mkdir(join(one.path, 'nested')); await writeFile(join(one.path, 'nested', 'audio.tmp'), 'discard');
  await writeFile(join(two.path, 'busy.tmp'), 'keep busy');
  await one.dispose(); await one.dispose();
  assert.equal(await readFile(join(base, 'final.md'), 'utf8'), 'keep final');
  assert.equal(await readFile(join(two.path, 'busy.tmp'), 'utf8'), 'keep busy');
  await two.dispose();
  assert.deepEqual(await readdir(base), ['final.md']);
});

test('scratch cleanup removes internal links without following their targets', async t => {
  const root = await isolated(t), outside = join(root, 'outside'), base = join(root, 'base');
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'do not delete');
  const scratch = await createScratchDirectory(base);
  if (!await linkDirectory(outside, join(scratch.path, 'linked-outside'), t)) { await scratch.dispose(); return; }
  await scratch.dispose();
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'do not delete');
  await assert.rejects(access(scratch.path), { code: 'ENOENT' });
});

test('scratch creation refuses a linked output base instead of writing through it', async t => {
  const root = await isolated(t), outside = join(root, 'outside'), link = join(root, 'linked-base');
  await mkdir(outside);
  if (!await linkDirectory(outside, link, t)) return;
  await assert.rejects(createScratchDirectory(link));
  assert.deepEqual(await readdir(outside), []);
});

test('scratch creation refuses links in an ancestor path as well as the final base', async t => {
  const root = await isolated(t), outside = join(root, 'outside'), link = join(root, 'workspace-link');
  await mkdir(outside);
  if (!await linkDirectory(outside, link, t)) return;
  await assert.rejects(createScratchDirectory(join(link, 'video-study', 'transcripts')));
  assert.deepEqual(await readdir(outside), []);
});

test('dispose never follows a scratch path replaced by a directory link', async t => {
  const root = await isolated(t), outside = join(root, 'outside'), base = join(root, 'base');
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep replacement target');
  const scratch = await createScratchDirectory(base);
  const parked = join(base, 'original-parked');
  assert.ok(nestedUnder(root, parked));
  await rename(scratch.path, parked);
  if (!await linkDirectory(outside, scratch.path, t)) return;
  // Refusing cleanup or unlinking only the replacement link are both safe.
  await scratch.dispose().catch(() => {});
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep replacement target');
  assert.equal((await lstat(parked)).isDirectory(), true);
});

test('dispose refuses to traverse a base replaced by an ancestor link', async t => {
  const root = await isolated(t), base = join(root, 'base'), outside = join(root, 'outside');
  const scratch = await createScratchDirectory(base), scratchName = relative(base, scratch.path);
  await mkdir(join(outside, scratchName), { recursive: true });
  await writeFile(join(outside, scratchName, 'keep.txt'), 'keep linked ancestor target');
  const parked = join(root, 'base-parked');
  assert.ok(nestedUnder(root, base)); assert.ok(nestedUnder(root, parked));
  await rename(base, parked);
  if (!await linkDirectory(outside, base, t)) return;
  await scratch.dispose().catch(() => {});
  assert.equal(await readFile(join(outside, scratchName, 'keep.txt'), 'utf8'), 'keep linked ancestor target');
});

test('invalid or unwritable selected bases reject without a global-temp fallback', async t => {
  const root = await isolated(t), blocker = join(root, 'file-not-directory');
  await writeFile(blocker, 'keep file');
  const before = await readdir(root);
  for (const base of ['', 'relative-base', null, undefined, blocker, join(blocker, 'nested')])
    await assert.rejects(createScratchDirectory(base));
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(blocker, 'utf8'), 'keep file');
});
