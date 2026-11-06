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
import tempfile
import uuid
from urllib.parse import urlparse

BACKENDS = ('captions', 'cloud')
DEPENDENCIES = ['yt-dlp==2026.8.19', 'python-docx==1.2.0']
OWNER_MARKER = '.dsh-video-study-cloud-venv'


def force_utf8_stdio():
    """The plugin decodes JSON as UTF-8, not the Windows console codepage."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
        except (AttributeError, ValueError, OSError):
            pass


def step(message):
    """Emit one progress line for the settings page.

    stdout stays reserved for the single JSON result, so progress goes to
    stderr as UTF-8 bytes with a fixed prefix the plugin recognises.
    """
    sys.stderr.buffer.write(b'DSH_STEP ' + message.encode('utf-8') + b'\n')
    sys.stderr.buffer.flush()


class SetupError(Exception):
    pass


def _is_link(path):
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        return True
    try:
        # Python 3.10/3.11 lack Path.is_junction; reject reparse points there too.
        return bool(getattr(path.lstat(), 'st_file_attributes', 0) & 0x400)
    except (FileNotFoundError, NotADirectoryError):
        return False


def quarantine_foreign_venv(venv, marker):
    """Rename a recognizable foreign venv; never delete or execute its contents."""
    if _is_link(venv) or any(_is_link(parent) for parent in venv.parents):
        raise SetupError('拒绝修改链接环境。')
    if not venv.exists():
        return None
    if not venv.is_dir() or _is_link(marker):
        raise SetupError('环境路径或所有权标记无效；拒绝修改。')
    if marker.is_file():
        return None
    config = venv / 'pyvenv.cfg'
    if _is_link(config) or not config.is_file():
        raise SetupError('同名目录已存在且不是可识别的虚拟环境；请手动移动后重试。')
    original = venv.stat(follow_symlinks=False)
    identity = (original.st_dev, original.st_ino)
    # A fresh unpredictable sibling avoids overwriting an earlier saved venv.
    target = venv.with_name('venv.replaced-' + uuid.uuid4().hex)
    if target.exists() or _is_link(target):
        raise SetupError('保留旧环境的目标已存在；未修改旧环境，请重试。')
    if _is_link(venv) or any(_is_link(parent) for parent in venv.parents):
        raise SetupError('拒绝修改链接环境。')
    current = venv.stat(follow_symlinks=False)
    if (current.st_dev, current.st_ino) != identity:
        raise SetupError('环境目录已变化；拒绝修改。')
    venv.rename(target)
    saved = target.stat(follow_symlinks=False)
    if _is_link(target) or (saved.st_dev, saved.st_ino) != identity:
        raise SetupError('环境目录已变化；已保留目录，停止安装。')
    return target


def parser():
    p = argparse.ArgumentParser(description='可选环境准备；默认仅显示计划，--allow-downloads才创建和下载。')
    p.add_argument('--backend', choices=BACKENDS, default='captions')
    p.add_argument('--state-dir', required=True, help='新/已由本云端插件管理的绝对状态目录')
    p.add_argument('--proxy', help='显式无凭据HTTP代理；默认不使用环境/系统代理')
    p.add_argument('--allow-downloads', action='store_true', help='明确同意本次隔离基础依赖安装；不下载ASR模型')
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
    if args.backend not in BACKENDS:
        raise SetupError('云端版仅支持 captions/cloud；不支持 local 或其他后端。')
    state = Path(args.state_dir)
    if not state.is_absolute() or _is_link(state):
        raise SetupError('状态目录须为明确的绝对目录，不能是链接。')
    if state.exists() and not state.is_dir():
        raise SetupError('状态路径不是目录。')
    if any(_is_link(parent) for parent in state.parents):
        raise SetupError('状态目录的祖先不能是链接。')
    proxy = checked_proxy(args.proxy)
    return {'backend': args.backend, 'state_dir': str(state), 'venv': str(state / 'venv'),
            'python': str(state / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')),
            'requirements': list(DEPENDENCIES), 'package_index': 'https://pypi.org/simple',
            'proxy_configured': bool(proxy), 'approved': bool(args.allow_downloads),
            'notes': ['仅部署隔离Python基础依赖，不安装本机ASR引擎或下载ASR模型。',
                      '包含字幕提取所需yt-dlp与Word导出所需python-docx。',
                      'B站字幕仅需Python标准库；云端协议使用标准库。',
                      '固定顶层依赖，不声称传递依赖已在所有系统验证。']}


def clean_environment(state, proxy):
    # Do not inherit tokens, implicit mirrors, Python startup hooks, or proxy choices.
    allowed = ('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
               'HOME', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL')
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(PYTHONIOENCODING='utf-8', PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1', NETRC=os.devnull,
               TMP=str(state), TEMP=str(state), TMPDIR=str(state))
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
    if args.backend not in BACKENDS or plan.get('backend') != args.backend:
        raise SetupError('云端版仅支持 captions/cloud；部署计划后端必须匹配。')
    if not args.allow_downloads:
        return {'status': 'plan_only', **plan}
    if sys.version_info < (3, 10):
        raise SetupError('需要Python 3.10或更新版本；不会自动安装系统Python。')
    state = Path(plan['state_dir'])
    venv = state / 'venv'
    marker = venv / OWNER_MARKER
    proxy = checked_proxy(args.proxy)
    replaced = quarantine_foreign_venv(venv, marker)
    state.mkdir(parents=True, exist_ok=True)
    # Explicit installer scratch stays in the selected state; no system-temp fallback.
    with tempfile.TemporaryDirectory(prefix='.setup-', dir=state) as scratch:
        env = clean_environment(scratch, proxy)
        if replaced is not None:
            step('发现旧的、不是本插件创建的环境；已改名保留为 ' + replaced.name + '，继续新建…')
        if not venv.exists():
            step('正在创建隔离的 Python 环境…')
            run_step([sys.executable, '-I', '-m', 'venv', str(venv)], env, 180)
            marker.write_text('Owned by dsh-video-study-cloud explicit setup CLI\n', encoding='utf-8')
        step('正在下载并安装依赖（yt-dlp、python-docx，可能要几分钟）…')
        python = plan['python']
        command = [python, '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
                   '--no-input', 'install', '--only-binary=:all:', '--no-cache-dir', '--index-url', 'https://pypi.org/simple']
        if args.proxy:
            command += ['--proxy', args.proxy]
        run_step(command + plan['requirements'], env, 1800)
        step('正在校验已安装的依赖…')
        # Record actual resolved versions for this machine; never package this state.
        run_step([python, '-I', '-m', 'pip', 'check'], env, 60)
        snapshot_code = ("import importlib.metadata as m,json,sys;from pathlib import Path;"
                         "Path(sys.argv[1]).write_text(json.dumps({d.metadata['Name']:d.version for d in m.distributions()},indent=2),encoding='utf-8')")
        run_step([python, '-I', '-c', snapshot_code, str(state / 'installed-versions.json')], env, 60)
        step('正在记录环境信息…')
    result = {'status': 'prepared_not_runtime_verified', **plan,
              'next': '设置页会把它写入仍为空的Python路径；字幕获取和云端服务仍需用户另行验证。'}
    report = state / 'last-setup.json'
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result


def main(argv=None):
    force_utf8_stdio()
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
