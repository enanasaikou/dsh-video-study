"""Offline Volcengine audio preparation, using only stdlib and existing ffmpeg.

Never installs a dependency, invokes a shell, probes duration, or uploads media.
The caller supplies an already consented, verified temporary audio file. Source
platform duration and duration_unverified metadata are preserved, not promoted to
independently decoded measurements. The caller must verify the returned file
again and charge this operation against its overall ASR timeout.
"""
from __future__ import annotations

import hashlib
import math
import os
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from cloud_asr import CloudASRError

_MESSAGES = {
    'audio_invalid': '本地音轨文件无效、格式不支持或本地转换中发生变化。',
    'audio_too_large': '本地转换音轨超过本次上传大小限制；未截断或分块。',
    'dependency_missing': '缺少已安装的 ffmpeg；仅使用已有依赖，不会自动安装。',
    'timeout': '本地音轨准备超过累计时限；未继续云端转写。',
}
_DIRECT = frozenset(('wav', 'mp3', 'ogg', 'opus'))
_DEMUXERS = {'m4a': 'mov', 'mp4': 'mov', 'webm': 'matroska',
             'flac': 'flac', 'aac': 'aac'}
_FIELDS = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns')
_MAX_BYTES = 100_000_000
_POLL_SECONDS = 0.05
_REAP_SECONDS = 1.0


def _fail(code):
    raise CloudASRError(code, _MESSAGES[code]) from None


class _Budget:
    def __init__(self, timeout):
        self.end = time.monotonic() + timeout

    def remaining(self):
        left = self.end - time.monotonic()
        if left <= 0:
            _fail('timeout')
        return left


def _safe_path(path):
    # Check every existing ancestor too: resolve() alone hides symlinks/junctions.
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
            _fail('audio_invalid')
    if path.resolve(strict=True) != path:
        _fail('audio_invalid')
    return path


def _identity(path, expected=None, *, maximum=None, allow_empty=False):
    _safe_path(path)
    current = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(current.st_mode) or (not allow_empty and current.st_size <= 0):
        _fail('audio_invalid')
    if expected is not None and any(getattr(current, key) != getattr(expected, key) for key in _FIELDS):
        _fail('audio_invalid')
    if maximum is not None and current.st_size > maximum:
        _fail('audio_too_large')
    return current


def _digest(path, identity, budget):
    digest = hashlib.sha256()
    with path.open('rb') as audio:
        opened = os.fstat(audio.fileno())
        if any(getattr(opened, key) != getattr(identity, key) for key in _FIELDS):
            _fail('audio_invalid')
        total = 0
        while total < identity.st_size:
            budget.remaining()
            chunk = audio.read(min(64 * 1024, identity.st_size - total))
            if not chunk:
                _fail('audio_invalid')
            total += len(chunk)
            digest.update(chunk)
        if audio.read(1):
            _fail('audio_invalid')
        if any(getattr(os.fstat(audio.fileno()), key) != getattr(identity, key) for key in _FIELDS):
            _fail('audio_invalid')
    _identity(path, identity)
    budget.remaining()
    return digest.hexdigest()


def _output(path, initial, maximum, *, complete=False):
    current = _identity(path, maximum=maximum, allow_empty=not complete)
    # ffmpeg may change size/times, but it must write our original regular file.
    if any(getattr(current, key) != getattr(initial, key) for key in ('st_dev', 'st_ino')):
        _fail('audio_invalid')
    return current


def _reap(process):
    # Cancellation and all failures have a bounded kill + wait, never communicate
    # or pipe capture. A cleanup error must not leak a process/filename message.
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=_REAP_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        pass


def prepare_cloud_audio(audio_path, directory, source, options):
    """Return (Path, copied source); transcode only resolved volcengine_flash.

    options uses existing protocol/timeout/max_bytes keys only. ffmpeg is found
    with shutil.which, never an options/config executable or installation step.
    No duration metadata is manufactured. stdout/stderr/stdin are DEVNULL and a
    deliberately empty child environment prevents credential inheritance.
    """
    process = None
    output = None
    initial = None
    root = None
    try:
        if not isinstance(source, dict) or not isinstance(options, dict):
            _fail('audio_invalid')
        result = dict(source)
        path = Path(audio_path)
        if options.get('protocol') != 'volcengine_flash':
            return path, result
        duration = source.get('duration_seconds')
        if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or not 0 < duration <= 7200):
            _fail('audio_invalid')
        extension = path.suffix.lower().lstrip('.')
        if extension in _DIRECT:
            return path, result
        if extension not in _DEMUXERS:
            _fail('audio_invalid')
        timeout = options.get('timeout', 900)
        maximum = options.get('max_bytes', 25 * 1024 * 1024)
        if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                or not math.isfinite(timeout) or timeout <= 0
                or type(maximum) is not int or maximum <= 0):
            _fail('audio_invalid')
        budget = _Budget(timeout)
        maximum = min(maximum, _MAX_BYTES)
        root = _safe_path(directory)
        path = _safe_path(path)
        if not root.is_dir() or path.parent != root:
            _fail('audio_invalid')
        original = _identity(path)
        if source.get('audio_bytes') != original.st_size:
            _fail('audio_invalid')
        original_hash = _digest(path, original, budget)
        if original_hash != source.get('audio_sha256'):
            _fail('audio_invalid')
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            _fail('dependency_missing')
        budget.remaining()
        fd, name = tempfile.mkstemp(prefix='cloud-audio-', suffix='.mp3', dir=root)
        os.close(fd)
        output = Path(name)
        initial = _identity(output, allow_empty=True)
        _identity(path, original)
        # Explicit demuxers prevent playlist/manifest detection. Only local file
        # and pipe protocols are enabled; no remote URL can be opened by ffmpeg.
        argv = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-protocol_whitelist', 'file,pipe', '-f', _DEMUXERS[extension],
                '-i', str(path), '-map', '0:a:0', '-vn', '-sn', '-dn',
                '-map_metadata', '-1', '-map_chapters', '-1', '-ac', '1',
                '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k',
                '-threads', '1', '-f', 'mp3', str(output)]
        budget.remaining()
        try:
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       shell=False, close_fds=True, env={})
        except FileNotFoundError:
            _fail('dependency_missing')
        while True:
            _output(output, initial, maximum)
            _identity(path, original)
            try:
                returncode = process.wait(timeout=min(_POLL_SECONDS, budget.remaining()))
                break
            except subprocess.TimeoutExpired:
                continue
        budget.remaining()
        _output(output, initial, maximum, complete=True)
        if returncode != 0:
            _fail('audio_invalid')
        final = _output(output, initial, maximum, complete=True)
        digest = _digest(output, final, budget)
        _identity(path, original)
        if _digest(path, original, budget) != original_hash:
            _fail('audio_invalid')
        _output(output, initial, maximum, complete=True)
        _identity(output, final)
        warnings = source.get('warnings', [])
        if not isinstance(warnings, list):
            _fail('audio_invalid')
        result['warnings'] = list(warnings)
        if 'local_audio_transcoded' not in result['warnings']:
            result['warnings'].append('local_audio_transcoded')
        result.update(audio_bytes=final.st_size, audio_sha256=digest)
        return output, result
    except CloudASRError:
        raise
    except (OSError, ValueError, TypeError, OverflowError, RuntimeError):
        _fail('audio_invalid')
    finally:
        # A completed child is already reaped; all other paths, including
        # KeyboardInterrupt, kill and reap it before returning control.
        if process is not None and process.returncode is None:
            _reap(process)
        # Partial files stay within the caller-owned temporary directory, which
        # owns cleanup; never unlink a possibly swapped caller path here.
