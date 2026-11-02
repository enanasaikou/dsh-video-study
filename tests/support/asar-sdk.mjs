// Development-only ASAR reader. No extraction, installs, profile reads or app boot.
import { openSync, readSync, closeSync } from 'node:fs';
import { registerHooks, isBuiltin } from 'node:module';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function openAsarSdk(archivePath) {
  if (!isAbsolute(archivePath)) throw new Error('archive must be absolute');
  const archive = resolve(archivePath), fd = openSync(archive, 'r');
  let hooks;
  const bytes = (offset, length) => {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read);
      if (!count) throw new Error('truncated archive');
      read += count;
    }
    return buffer;
  };
  try {
    const prefix = bytes(0, 16), headerLength = prefix.readUInt32LE(12);
    if (headerLength > 64 * 1024 * 1024) throw new Error('archive header too large');
    const header = JSON.parse(bytes(16, headerLength).toString('utf8'));
    const dataBase = 8 + prefix.readUInt32LE(4);
    const cache = new Map();
    const normalize = value => {
      const path = posix.normalize(value.replaceAll('\\', '/')).replace(/^\/+/, '');
      if (path === '..' || path.startsWith('../')) throw new Error('archive path escape');
      return path;
    };
    function node(path) {
      const parts = normalize(path).split('/');
      let current = header;
      for (const part of parts) {
        current = current?.files?.[part];
        if (!current) return;
      }
      if (current.link) return node(current.link);
      return current;
    }
    function read(path) {
      path = normalize(path);
      if (cache.has(path)) return cache.get(path);
      const entry = node(path);
      if (!entry || entry.files || entry.unpacked || typeof entry.offset !== 'string')
        throw new Error('archive module unavailable');
      const source = bytes(dataBase + Number(entry.offset), entry.size).toString('utf8');
      cache.set(path, source);
      return source;
    }
    const json = path => JSON.parse(read(path));
    function file(path) {
      path = normalize(path);
      for (const candidate of [path, path + '.js', path + '.mjs', path + '.cjs', path + '.json']) {
        const entry = node(candidate);
        if (entry && !entry.files) return candidate;
      }
      if (node(path + '/package.json')) {
        const pkg = json(path + '/package.json');
        if (pkg.main) { const candidate = file(posix.join(path, pkg.main)); if (candidate) return candidate; }
      }
      for (const name of ['index.js', 'index.mjs', 'index.cjs', 'index.json'])
        if (node(path + '/' + name)) return path + '/' + name;
    }
    function packageRoot(path) {
      let directory = posix.dirname(path);
      while (directory !== '.') {
        if (node(directory + '/package.json')) return directory;
        directory = posix.dirname(directory);
      }
    }
    function conditional(target, conditions, wildcard) {
      if (typeof target === 'string') return target.replaceAll('*', wildcard ?? '*');
      if (Array.isArray(target)) {
        for (const item of target) { const result = conditional(item, conditions, wildcard); if (result) return result; }
      } else if (target && typeof target === 'object') {
        for (const [key, value] of Object.entries(target))
          if (key === 'default' || conditions.has(key)) { const result = conditional(value, conditions, wildcard); if (result) return result; }
      }
    }
    function mapped(map, subpath, conditions) {
      if (typeof map === 'string' || Array.isArray(map)) return subpath === '.' ? conditional(map, conditions) : undefined;
      if (!map || typeof map !== 'object') return;
      if (Object.keys(map).every(key => !key.startsWith('.')) && subpath === '.') return conditional(map, conditions);
      if (Object.hasOwn(map, subpath)) return conditional(map[subpath], conditions);
      for (const [key, target] of Object.entries(map)) {
        if (!key.includes('*')) continue;
        const [start, end] = key.split('*');
        if (subpath.startsWith(start) && subpath.endsWith(end))
          return conditional(target, conditions, subpath.slice(start.length, end ? -end.length : undefined));
      }
    }
    function modulePath(specifier, parent, conditions) {
      if (specifier.startsWith('.')) return file(posix.join(posix.dirname(parent), specifier));
      if (specifier.startsWith('#')) {
        const root = packageRoot(parent), target = mapped(json(root + '/package.json').imports, specifier, conditions);
        if (!target) throw new Error('archive package import unavailable');
        return target.startsWith('.') ? file(posix.join(root, target)) : modulePath(target, root + '/package.json', conditions);
      }
      const parts = specifier.split('/'), name = parts[0].startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift();
      let directory = posix.dirname(parent);
      while (true) {
        const root = posix.join(directory, 'node_modules', name), packageFile = root + '/package.json';
        if (node(packageFile)) {
          const pkg = json(packageFile), subpath = parts.length ? './' + parts.join('/') : '.';
          if (pkg.exports !== undefined) {
            const target = mapped(pkg.exports, subpath, conditions);
            if (!target || !target.startsWith('./')) throw new Error('archive package export unavailable');
            return file(posix.join(root, target));
          }
          return file(parts.length ? posix.join(root, ...parts) : root);
        }
        if (directory === '.') break;
        directory = posix.dirname(directory);
      }
      throw new Error('archive dependency unavailable');
    }
    const baseUrl = pathToFileURL(archive + '/').href;
    const url = path => baseUrl + normalize(path);
    const fromUrl = value => {
      if (!value?.startsWith(baseUrl)) return;
      return normalize(fileURLToPath(value).slice(archive.length + 1));
    };
    hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBuiltin(specifier)) return nextResolve(specifier, context);
        if (specifier.startsWith(baseUrl)) {
          const path = file(fromUrl(specifier));
          if (!path) throw new Error('archive module not found');
          return { url: url(path), shortCircuit: true };
        }
        const parent = fromUrl(context.parentURL);
        if (parent === undefined) return nextResolve(specifier, context);
        const path = modulePath(specifier, parent, new Set(context.conditions ?? ['node', 'import']));
        if (!path) throw new Error('archive dependency not found');
        return { url: url(path), shortCircuit: true };
      },
      load(moduleUrl, context, nextLoad) {
        const path = fromUrl(moduleUrl);
        if (path === undefined) return nextLoad(moduleUrl, context);
        if (!/\.(?:mjs|cjs|js|json)$/.test(path)) throw new Error('archive native modules are not allowed');
        let format;
        if (path.endsWith('.json')) format = 'json';
        else if (path.endsWith('.cjs')) format = 'commonjs';
        else if (path.endsWith('.mjs')) format = 'module';
        else { const root = packageRoot(path); format = root && json(root + '/package.json').type === 'module' ? 'module' : 'commonjs'; }
        return { source: read(path), format, shortCircuit: true };
      },
    });
    return {
      importPackage: name => import(url(modulePath(name, 'dsh/probe.mjs', new Set(['node', 'import'])))),
      packageVersion: name => json('dsh/node_modules/' + name + '/package.json').version,
      readPackageFile(name, relative) {
        if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)
            || typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\')
            || relative.split('/').some(part => part === '..')) throw new Error('invalid package file');
        return read('dsh/node_modules/' + name + '/' + relative);
      },
      close() { hooks.deregister(); closeSync(fd); },
    };
  } catch (error) { hooks?.deregister(); closeSync(fd); throw error; }
}
