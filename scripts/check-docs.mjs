import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline documentation contract: no browser, service calls, credentials or writes.
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--root'),
  'Usage: node scripts/check-docs.mjs [--root unpacked-package]');
const root = args.length ? resolve(args[1]) : fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(path, 'utf8');
const pkg = JSON.parse(read(join(root, 'package.json')));
const required = [
  'README.md', 'SECURITY.md', 'docs/getting-started.md', 'docs/cloud-services.md',
  'docs/troubleshooting.md', 'docs/advanced.md', 'docs/development.md',
  'docs/examples/lesson-output.md', 'docs/assets/workflow.svg',
];
for (const file of required) assert.ok(lstatSync(join(root, file)).isFile(), `Missing documentation: ${file}`);
assert.ok(pkg.files.includes('docs'), 'README relative documentation must also ship in TGZ');
assert.equal(pkg.repository.url, 'git+https://github.com/enanasaikou/dsh-video-study.git');
assert.equal(pkg.homepage, 'https://github.com/enanasaikou/dsh-video-study#readme');
assert.equal(pkg.bugs.url, 'https://github.com/enanasaikou/dsh-video-study/issues');
const home = read(join(root, 'README.md'));
assert.ok(home.includes(`云端稳定版 ${pkg.version}`), 'README/package version mismatch');
assert.ok(home.includes(`dsh plugin --profile web add ${pkg.name}@${pkg.version}`),
  'README DSH install command/package version mismatch');
const gettingStarted = read(join(root, 'docs/getting-started.md'));
assert.ok(gettingStarted.includes(`dsh plugin --profile web add ${pkg.name}@${pkg.version}`),
  'Getting-started DSH install command/package version mismatch');
assert.ok(gettingStarted.includes('npm pack --ignore-scripts'), 'Source-to-TGZ fallback must be actionable');
assert.ok(home.includes('人工编写的格式示例'), 'Illustrative output must not claim real ASR evidence');
assert.ok(home.includes('可能收费'), 'Cloud cost/consent warning must stay visible');
assert.doesNotMatch(home, /ask_user_question|output_style_required|本次 TGZ|三段长说明/,
  'Internal API or handover prose must not return to the user homepage');

function filesUnder(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, 'No linked documentation');
    return stat.isDirectory() ? filesUnder(path) : [path];
  });
}
const markdown = [join(root, 'README.md'), join(root, 'SECURITY.md'),
  ...filesUnder(join(root, 'docs')).filter(file => extname(file) === '.md')];
const withoutFences = text => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
function anchors(file) {
  const found = new Set(), counts = new Map();
  for (const match of withoutFences(read(file)).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    found.add(n ? `${base}-${n}` : base);
    counts.set(base, n + 1);
  }
  return found;
}
let links = 0;
for (const file of markdown) {
  const body = withoutFences(read(file));
  assert.doesNotMatch(body, /C:[/\\]Users[/\\]enana|D:[/\\]123123|app\.asar[/\\]dsh/i,
    `Personal installation path in public documentation: ${relative(root, file)}`);
  assert.doesNotMatch(body, /^(?:<{7}|={7}|>{7})(?:\s|$)/m, 'Unresolved conflict marker');
  const pattern = /!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g;
  for (const match of body.matchAll(pattern)) {
    const href = match[1] ?? match[2];
    if (/^https:\/\//i.test(href)) { new URL(href); continue; }
    assert.doesNotMatch(href, /^[a-z][a-z0-9+.-]*:|^\/\//i, 'Unsafe documentation URL scheme');
    const [name, fragment] = href.split('#', 2);
    const target = name ? resolve(dirname(file), decodeURIComponent(name)) : file;
    const rel = relative(root, target);
    assert.ok(!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(target).startsWith('\\\\'),
      `Link escapes repository: ${href}`);
    assert.ok(lstatSync(target).isFile(), `Broken link from ${relative(root, file)}: ${href}`);
    if (fragment && extname(target) === '.md') {
      assert.ok(anchors(target).has(decodeURIComponent(fragment)),
        `Broken heading from ${relative(root, file)}: ${href}`);
    }
    links++;
  }
}
const svg = read(join(root, 'docs/assets/workflow.svg'));
assert.match(svg, /工作流程示意/);
assert.match(svg, /非产品界面截图/);
assert.doesNotMatch(svg, /<script\b|<foreignObject\b|(?:href|src)\s*=/i,
  'Workflow illustration must be self-contained and non-executable');
console.log(JSON.stringify({ status: 'passed', version: pkg.version,
  markdownFiles: markdown.length, localLinks: links, externalRequests: 0,
  checked: ['local-links', 'heading-anchors', 'package-metadata', 'version', 'honest-examples', 'static-svg'] }, null, 2));
