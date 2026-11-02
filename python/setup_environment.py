"""Optional, explicit deployment CLI; never runs during install or extraction.

Without --allow-downloads this is a plan only and performs no writes/network.
Only an isolated, plugin-owned venv is changed; no global Python/PATH changes.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse

MODELS = {'tiny': '约75MB', 'base': '约145MB', 'small': '约480MB',
          'medium': '约1.5GB', 'large-v3': '约3GB'}
DEPENDENCIES = ['yt-dlp==2026.8.19']
OWNER_MARKER = '.dsh-video-study-venv'
MODEL_DOWNLOAD = """
import sys
from huggingface_hub import snapshot_download
snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2], token=False,
                  endpoint='https://huggingface.co',
                  allow_patterns=['model.bin','config.json','tokenizer.json',
                                  'preprocessor_config.json','vocabulary.*','tokenizer_config.json'])
"""


class SetupError(Exception):
    pass


def _is_link(path):
    return path.is_symlink() or getattr(path, 'is_junction', lambda: False)()


def _model_complete(path, required):
    return all((path / name).is_file() and (path / name).stat().st_size for name in required)


def parser():
    p = argparse.ArgumentParser(description='可选环境准备；默认仅显示计划，--allow-downloads才创建和下载。')
    p.add_argument('--backend', choices=('captions', 'cloud', 'local'), default='captions')
    p.add_argument('--state-dir', required=True, help='新/已由本插件管理的绝对状态目录')
    p.add_argument('--model', choices=tuple(MODELS), default='small')
    p.add_argument('--proxy', help='显式无凭据HTTP代理；默认不使用环境/系统代理')
    p.add_argument('--allow-downloads', action='store_true', help='明确同意本次隔离依赖安装及local模型下载')
    return p


def checked_proxy(raw):
    if not raw:
        return None
    u = urlparse(raw)
    try:
        valid = (u.scheme == 'http' and u.hostname and u.port and not u.username and not u.password
                 and u.path in ('', '/') and not u.query and not u.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise SetupError('代理仅支持无凭据的显式 HTTP 地址，不降级直连。')
    return raw


def build_plan(args):
    state = Path(args.state_dir)
    if not state.is_absolute() or _is_link(state):
        raise SetupError('状态目录须为明确的绝对目录，不能是链接。')
    if state.exists() and not state.is_dir():
        raise SetupError('状态路径不是目录。')
    if any(_is_link(parent) for parent in state.parents):
        raise SetupError('状态目录的祖先不能是链接。')
    proxy = checked_proxy(args.proxy)
    local = args.backend == 'local'
    requirements = DEPENDENCIES + (['faster-whisper==1.2.1'] if local else [])
    return {'backend': args.backend, 'state_dir': str(state), 'venv': str(state / 'venv'),
            'python': str(state / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')),
            'requirements': requirements, 'package_index': 'https://pypi.org/simple',
            'model': args.model if local else None,
            'model_dir': str(state / 'models' / args.model) if local else None,
            'model_repository': 'Systran/faster-whisper-' + args.model if local else None,
            'model_source': 'https://huggingface.co' if local else None, 'model_size_estimate': MODELS[args.model] if local else None,
            'proxy_configured': bool(proxy), 'approved': bool(args.allow_downloads),
            'notes': ['模型大小为估计；依赖和下载缓存额外占用磁盘。',
                      '仅字幕/云模式不安装本地ASR依赖或模型；B站字幕仅需Python标准库。',
                      'CPU可运行本地ASR，但速度/内存受硬件影响。',
                      '固定顶层依赖，不声称传递依赖已在所有系统验证。']}


def clean_environment(state, proxy):
    # Do not inherit tokens, implicit mirrors, Python startup hooks, or proxy choices.
    allowed = ('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
               'HOME', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL')
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(PYTHONIOENCODING='utf-8', PYTHONNOUSERSITE='1', NETRC=os.devnull,
               HF_HOME=str(state / 'download-cache'), HF_HUB_DISABLE_IMPLICIT_TOKEN='1')
    if proxy:
        env['HTTPS_PROXY'] = env['HTTP_PROXY'] = proxy
    return env


def run_step(command, env, timeout):
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=env, shell=False)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise SetupError('准备步骤失败；未显示第三方错误，目录保留。')
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        raise SetupError('准备步骤已取消或超时；目录保留。') from None


def execute(args, plan):
    if not args.allow_downloads:
        return {'status': 'plan_only', **plan}
    if sys.version_info < (3, 10):
        raise SetupError('需要Python 3.10或更新版本；不会自动安装系统Python。')
    state = Path(plan['state_dir'])
    venv = state / 'venv'
    marker = venv / OWNER_MARKER
    if venv.exists() and (not marker.is_file() or marker.is_symlink()):
        raise SetupError('venv已存在但不是本插件创建的环境，拒绝修改。')
    if _is_link(venv):
        raise SetupError('拒绝修改链接环境。')
    state.mkdir(parents=True, exist_ok=True)
    env = clean_environment(state, checked_proxy(args.proxy))
    if not venv.exists():
        run_step([sys.executable, '-I', '-m', 'venv', str(venv)], env, 180)
        marker.write_text('Owned by dsh-video-study explicit setup CLI\n', encoding='utf-8')
    python = plan['python']
    command = [python, '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
               '--no-input', 'install', '--only-binary=:all:', '--no-cache-dir', '--index-url', 'https://pypi.org/simple']
    if args.proxy:
        command += ['--proxy', args.proxy]
    run_step(command + plan['requirements'], env, 1800)
    if args.backend == 'local':
        model_dir = Path(plan['model_dir'])
        required = ('model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json')
        if _is_link(model_dir):
            raise SetupError('拒绝复用链接模型目录。')
        if model_dir.exists():
            if not model_dir.is_dir() or not _model_complete(model_dir, required):
                raise SetupError('已有模型目录不完整，拒绝覆盖；请选择新的状态目录。')
        else:
            model_dir.parent.mkdir(parents=True, exist_ok=True)
            run_step([python, '-I', '-c', MODEL_DOWNLOAD, plan['model_repository'], str(model_dir)], env, 7200)
        if not _model_complete(model_dir, required):
            raise SetupError('模型下载未产生完整文件。')
    # Record actual resolved versions for this machine; never package this state.
    run_step([python, '-I', '-m', 'pip', 'check'], env, 60)
    snapshot_code = ("import importlib.metadata as m,json,sys;from pathlib import Path;"
                     "Path(sys.argv[1]).write_text(json.dumps({d.metadata['Name']:d.version for d in m.distributions()},indent=2),encoding='utf-8')")
    run_step([python, '-I', '-c', snapshot_code, str(state / 'installed-versions.json')], env, 60)
    result = {'status': 'prepared_not_runtime_verified', **plan,
              'next': '将 python 路径填入插件设置；local 模式再填模型目录，并用真实短样例验证。'}
    report = state / 'last-setup.json'
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        plan = build_plan(args)
        result = execute(args, plan)
    except SetupError as exc:
        print(json.dumps({'status': 'setup_failed', 'message': str(exc)}, ensure_ascii=False))
        return 1
    except Exception:
        print(json.dumps({'status': 'setup_failed', 'message': '环境准备失败；未回显底层错误或凭据。'}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
