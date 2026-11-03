"""Build a source ZIP and validate an independently produced standard tgz.

No install/network. Tar is extracted only after a strict regular-file whitelist,
then tested from a moved Unicode/spaced temporary path. Choose an external
host SDK probe or explicitly choose the offline client-only probe; the latter
is never reported as real SDK/GUI verification.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
CLIENT_PROBE = r"""
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.argv[1];let client;
const React={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[v&&v.draft?{...v,loading:false,values:{...v.draft,mode:'cloud'},draft:{...v.draft,mode:'cloud'}}:v,()=>{}],useRef:v=>({current:v}),useEffect:()=>{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'lib/client.js'),'utf8'),{window:{__ModuleLoader__:{load:d=>{client=d.factory(n=>{assert.equal(n,'react');return React;});}}},URL,AbortController,TextEncoder,setTimeout,clearTimeout});
const entries=[];client.apply({slots:{inject:(name,fn)=>fn(),register:(entry,component)=>{entries.push(entry);return()=>{};}}});
assert.equal(entries[0].id,'video-study');
assert.equal(typeof client._testing.asr.createController,'function');
const login=JSON.stringify(client._testing.LoginSettings());
assert.ok(login.includes('哔哩哔哩下载字幕需要登录，Cookie仅供B站请求使用。'));
assert.ok(!login.includes('来源：')&&!login.includes('尚未检查登录有效性'));
const asr=JSON.stringify(client._testing.asr.Component());
for(const label of ['字幕与ASR','仅现有字幕','云端ASR','保存设置'])assert.ok(asr.includes(label));
for(const label of ['本机ASR','localModel','localModelDir','localDevice','localComputeType','快捷填入','选择预设或自定义'])assert.ok(!asr.includes(label),'removed UI control remains: '+label);
assert.deepEqual(Object.keys(client._testing.asr.defaults).filter(name=>/^local(Model|Device|Compute)/.test(name)),[]);
for(const label of ['一键准备运行环境','隔离 Python 环境'])assert.ok(asr.includes(label),'one-click install control missing: '+label);
const documents=JSON.stringify(client._testing.documents.Component());
for(const label of ['文档输出','默认文档格式','保存文档设置','Markdown','纯文本'])assert.ok(documents.includes(label));
const tabs=JSON.stringify(client._testing.VideoSettings());
for(const label of ['字幕与ASR','文档输出','B站登录','tabpanel'])assert.ok(tabs.includes(label));
for(const host of ['account.bilibili.com','passport.bilibili.com']){const matrix=client._testing.qrGeometry('https://'+host+'/offline-test?fixture=NOT-A-LOGIN');assert.ok(matrix.size>20&&matrix.path.length>100);}
assert.ok(documents.includes('当前会话工作区'));
const {createRuntime}=await import(pathToFileURL(path.join(root,'lib/runtime.mjs')));
const runtime=createRuntime({}, {spawnImpl:()=>assert.fail('artifact probe must not spawn Python'),createScratchImpl:()=>assert.fail('artifact probe must not write')});
try {
  const required=await runtime.extract({target:'abcdefghijk'});
  assert.equal(required.status,'output_style_required');
  assert.deepEqual(required.choices.map(item=>item.label),['原文（完全复述）','简要压缩','总结']);
  assert.equal((await runtime.extract({target:'abcdefghijk',outputStyle:'verbatim'})).status,'workspace_required');
  assert.equal((await runtime.setupInstall({unexpected:true})).status,'invalid_input');
  assert.equal(runtime.setupInstallStatus().status,'idle');
  assert.equal(typeof runtime.setupInstall,'function');
} finally {await runtime.dispose();}
console.log(JSON.stringify({status:'passed',kind:'client_only',sdkProbeRun:false,liveGuiTested:false,settingsSection:entries[0].id,asrSettingsPresent:true,loginCopySimplified:true,outputStyleGate:true,workspaceDefaultGuard:true,installGate:true,exactQrHosts:['account.bilibili.com','passport.bilibili.com']}));
"""


def safe_members(archive, allowed):
    members = archive.getmembers()
    names = set()
    for item in members:
        name = PurePosixPath(item.name)
        if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'package':
            raise RuntimeError('Unsafe tar path')
        if item.isdir():
            continue
        if not item.isfile() or item.name in names:
            raise RuntimeError('Non-regular or duplicate tar member')
        relative = '/'.join(name.parts[1:])
        if relative not in allowed:
            raise RuntimeError('Unexpected tar payload: ' + relative)
        names.add(item.name)
    if names != {'package/' + item for item in allowed}:
        raise RuntimeError('Missing payload files')
    return members


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tgz', required=True)
    parser.add_argument('--source-zip', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--sdk-probe')
    parser.add_argument('--client-only-probe', action='store_true')
    parser.add_argument('--host-asar')
    parser.add_argument('--python')
    args = parser.parse_args()
    if bool(args.sdk_probe) == args.client_only_probe:
        parser.error('choose exactly one: --sdk-probe or --client-only-probe')
    if args.sdk_probe and not (args.host_asar and args.python):
        parser.error('SDK probe requires --host-asar and --python')
    tgz, source_zip, report_path = (Path(value) for value in (args.tgz, args.source_zip, args.report))
    if not all(p.is_absolute() for p in (tgz, source_zip, report_path)) or source_zip.exists() or report_path.exists():
        parser.error('use absolute paths; ZIP and report must not exist')
    manifest = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    paths = {'package.json'}
    for include in manifest['files']:
        path = ROOT / include
        files = path.rglob('*') if path.is_dir() else [path]
        for file in files:
            if file.is_symlink():
                raise RuntimeError('No symlinks')
            if file.is_file():
                paths.add(file.relative_to(ROOT).as_posix())
    with tarfile.open(tgz, 'r:gz') as archive:
        members = safe_members(archive, paths)
        for item in members:
            if not item.isfile():
                continue
            data = archive.extractfile(item).read()
            relative = '/'.join(PurePosixPath(item.name).parts[1:])
            if relative == 'package.json':
                # Package managers may normalize manifest whitespace without changing meaning.
                if json.loads(data.decode('utf-8')) != manifest:
                    raise RuntimeError('Packaged manifest differs semantically from tested source')
            elif data != (ROOT / relative).read_bytes():
                raise RuntimeError('Packaged bytes differ from tested source: ' + relative)
        with tempfile.TemporaryDirectory(prefix='dsh portable 插件 ') as directory:
            destination = Path(directory).resolve()
            if not destination.is_absolute():
                raise RuntimeError('Unexpected temporary root')
            # Each member has already been restricted to a known regular file.
            for item in members:
                if item.isfile():
                    out = destination.joinpath(*PurePosixPath(item.name).parts)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with out.open('xb') as file:
                        file.write(archive.extractfile(item).read())
            command = ([args.node, '--input-type=module', '-e', CLIENT_PROBE, str(destination / 'package')]
                       if args.client_only_probe else
                       [args.node, args.sdk_probe, args.host_asar, str(destination / 'package'), args.python])
            probe = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=45,
                                   check=False)
            if probe.returncode:
                raise RuntimeError('Moved artifact probe failed (no installation performed)')
            probe_result = json.loads(probe.stdout)
            if probe_result.get('status') != 'passed':
                raise RuntimeError('Artifact probe did not confirm success')
    source_paths = set(paths)
    for directory in ('scripts', 'tests', 'client'):
        for file in (ROOT / directory).rglob('*'):
            if file.is_file() and not file.is_symlink() and '__pycache__' not in file.parts and file.suffix != '.pyc':
                source_paths.add(file.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(source_zip, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for relative in sorted(source_paths):
            archive.write(ROOT / relative, arcname='dsh-video-study/' + relative)
    report = {'verified_at': datetime.now(timezone.utc).isoformat(), 'status': 'passed',
              'runtime_files': len(paths), 'source_files': len(source_paths),
              'tgz': {'name': tgz.name, 'bytes': tgz.stat().st_size,
                      'sha256': hashlib.sha256(tgz.read_bytes()).hexdigest()},
              'source_zip': {'name': source_zip.name, 'bytes': source_zip.stat().st_size,
                             'sha256': hashlib.sha256(source_zip.read_bytes()).hexdigest()},
              'moved_unicode_spaced_path_probe': probe_result,
              'limits': ['No profile installation, live GUI interaction, actual QR login, real media, paid API or model inference tested.']}
    with report_path.open('x', encoding='utf-8') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
