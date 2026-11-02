"""Explicit local-only ASR; never decides whether a platform has captions.

No installs, model lookup, browser access, ffmpeg CLI or implicit proxy. A spawned
worker loads the local model before download and bounds native hangs. Untrusted
titles/text stay data, never Markdown headings or instructions.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import multiprocessing
import os
from pathlib import Path
import queue
import re
import tempfile
import threading
import time


REASONS = ('no_captions', 'language_unavailable', 'unreliable_captions', 'user_requested')
MODEL_FILES = ('model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json')
DEPENDENCIES = ('faster-whisper', 'ctranslate2', 'av', 'tokenizers', 'onnxruntime')
SAFE_CODES = {
    'model_missing', 'model_invalid', 'dependency_missing', 'engine_not_ready',
    'asr_error', 'asr_timeout', 'worker_failed', 'empty_output', 'invalid_timestamp',
    'duration_mismatch', 'invalid_input', 'output_exists', 'cancelled',
    'audio_invalid', 'download_error', 'output_error',
}
MESSAGES = {
    'model_missing': '本地模型目录或必需文件缺失；未下载音轨。',
    'model_invalid': '本地模型文件无效；未下载音轨。',
    'dependency_missing': '可选 ASR 依赖缺失；请先准备隔离环境，不会自动安装。',
    'engine_not_ready': '本地引擎初始化失败；未下载音轨。',
    'asr_timeout': '模型加载或转写超时；子进程已停止。',
    'asr_error': 'ASR 转写异常，结果可能不完整。',
    'worker_failed': 'ASR 子进程提前退出或通信异常。',
    'empty_output': 'ASR 未产生非空文字。',
    'invalid_timestamp': 'ASR 时间戳无效；原始结果已保留。',
    'duration_mismatch': '解码音频时长、来源时长或段落时间范围不一致。',
    'invalid_input': '参数无效；仅接受显式本地模型和新的绝对输出目录。',
    'output_exists': '输出目录已存在，未覆盖。',
    'cancelled': '已取消；子进程及临时音轨已收尾。',
    'audio_invalid': '下载模块返回的音轨路径、大小或来源数据无效。',
    'download_error': '音轨下载失败。',
    'output_error': '无法安全写入输出。',
}


DOWNLOAD_CODES = {
    'invalid_target', 'invalid_proxy', 'unsupported_proxy', 'invalid_cookie_file',
    'output_not_empty', 'local_error', 'metadata_invalid', 'page_conflict', 'page_not_found',
    'duration_limit', 'video_identity_mismatch', 'identity_unverified', 'audio_unavailable',
    'audio_format_unavailable', 'audio_language_unavailable', 'audio_track_ambiguous',
    'unapproved_media_host', 'redirect_rejected', 'login_required', 'platform_restricted',
    'rate_limited', 'platform_error', 'network_error', 'timeout', 'size_limit',
    'invalid_response', 'extraction_error',
}
SAFE_CODES |= DOWNLOAD_CODES
MESSAGES |= {code: '音轨获取已停止；请核对安全状态码。' for code in DOWNLOAD_CODES}


class ASRError(Exception):
    def __init__(self, code):
        self.code = code if code in SAFE_CODES else 'asr_error'
        super().__init__(MESSAGES[self.code])


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def json_data(value):
    """Preserve engine dataclasses recursively; nonfinite raw values remain explicit."""
    if is_dataclass(value):
        return json_data(asdict(value))
    if hasattr(value, '_asdict'):
        return json_data(value._asdict())
    if hasattr(value, '__dict__'):
        return json_data(vars(value))
    if isinstance(value, dict):
        return {str(k): json_data(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_data(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    # Unexpected types must not expose arbitrary repr (URLs, credentials, addresses).
    return {'unsupported_type': type(value).__name__}


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(json_data(value), handle, ensure_ascii=False, allow_nan=False, indent=2)
        handle.write('\n')


def model_directory(raw):
    path = Path(raw).resolve()
    if not path.is_dir() or any(not (path / name).is_file() for name in MODEL_FILES):
        raise ASRError('model_missing')
    if any((path / name).stat().st_size == 0 for name in MODEL_FILES):
        raise ASRError('model_invalid')
    return path


def model_identity(path):
    files = {}
    for name in MODEL_FILES:
        digest = hashlib.sha256()
        with (path / name).open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        files[name] = {'bytes': (path / name).stat().st_size, 'sha256': digest.hexdigest()}
    return {'path': str(path), 'identity_kind': 'sha256_required_files', 'files': files}


def dependency_versions():
    versions = {}
    for name in DEPENDENCIES:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


def status_report(args):
    versions = dependency_versions()
    model = {'provided': bool(args.model_dir), 'exists': False, 'required_files': list(MODEL_FILES)}
    if args.model_dir:
        try:
            path = model_directory(args.model_dir)
            model.update(path=str(path), exists=True)
        except ASRError as exc:
            model['issue'] = exc.code
        except OSError:
            model['issue'] = 'model_invalid'
    missing = [name for name, version in versions.items() if version is None]
    code = 'dependency_missing' if missing else ('model_missing' if not model['exists'] else 'not_runtime_checked')
    return {'status': code, 'dependencies': versions, 'missing_dependencies': missing,
            'model': model, 'network_used': False, 'runtime_ready': False,
            'limitations': ['静态检查不证明引擎可加载、CUDA 可用或模型有效。',
                            '真实转写前子进程加载本地模型；不联网、不安装。',
                            'Python 3.13 与各平台二进制依赖需在隔离环境实际验证。']}


def load_engine(config, model_factory=None):
    """All runtime imports/initialization occur before the ready handshake."""
    path = model_directory(config['model_dir'])
    if model_factory is None:
        try:
            import av  # noqa: F401 -- verify PyAV runtime import, not ffmpeg CLI
            from faster_whisper import WhisperModel
            if config['vad_filter']:
                from faster_whisper.vad import get_vad_model
                get_vad_model()  # verify ONNX runtime + packaged VAD before downloading
        except (ImportError, ModuleNotFoundError):
            raise ASRError('dependency_missing') from None
        except Exception:
            raise ASRError('engine_not_ready') from None
        model_factory = WhisperModel
    try:
        model = model_factory(str(path), device=config['device'],
                              compute_type=config['compute_type'], local_files_only=True)
        if config['language'] != 'auto':
            supported = getattr(model, 'supported_languages', None)
            if supported is not None and config['language'] not in supported:
                raise ASRError('engine_not_ready')
    except ASRError:
        raise
    except Exception:
        raise ASRError('engine_not_ready') from None
    return model


def transcription_parameters(config):
    return {'task': 'transcribe',
            'language': None if config['language'] == 'auto' else config['language'],
            'beam_size': config.get('beam_size', 5),
            'vad_filter': config['vad_filter'], 'word_timestamps': False}


def iter_engine(model, audio_path, config):
    """Return lazy segments and info; caller MUST fully consume before success."""
    return model.transcribe(str(audio_path), **transcription_parameters(config))


MAX_IPC_BYTES = 8 * 1024 * 1024
MAX_SEGMENTS = 100000


def send_event(connection, event):
    """Bound individual engine records and use JSON, never unpickle IPC data."""
    payload = json.dumps(json_data(event), ensure_ascii=False, allow_nan=False).encode('utf-8')
    if len(payload) > MAX_IPC_BYTES:
        raise ASRError('asr_error')
    connection.send_bytes(payload)


def _worker(connection, config):
    # Suppress Python AND native dependency output. Never print exception strings.
    null = None
    try:
        # Child-local defence in depth; never inspect tokens or parent proxy settings.
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        null = open(os.devnull, 'w')
        os.dup2(null.fileno(), 1)
        os.dup2(null.fileno(), 2)
        model = load_engine(config)
        identity = model_identity(Path(config['model_dir']))
        send_event(connection, {'event': 'ready', 'model': identity,
                         'engine_version': importlib.metadata.version('faster-whisper')})
        request = connection.recv()
        if request.get('event') != 'transcribe':
            raise ASRError('worker_failed')
        segments, info = iter_engine(model, request['audio_path'], config)
        send_event(connection, {'event': 'info', 'info': json_data(info)})
        for segment in segments:  # no list(), no VAD timestamp rebasing
            send_event(connection, {'event': 'segment', 'segment': json_data(segment)})
        send_event(connection, {'event': 'done'})
    except BaseException as exc:
        code = exc.code if isinstance(exc, ASRError) else 'asr_error'
        try:
            send_event(connection, {'event': 'error', 'code': code})
        except (OSError, EOFError):
            pass
    finally:
        connection.close()
        if null is not None:
            null.close()


class WorkerSession:
    """Spawn/Pipe boundary; deadlines cover blocked imports, load and the generator.

    timeout applies separately to readiness and inference. close() always
    terminate/kill AND join before temporary audio cleanup.
    """
    def __init__(self, config, timeout, context=None, clock=time.monotonic):
        self.config, self.timeout, self.clock = config, timeout, clock
        self.context = context or multiprocessing.get_context('spawn')
        self.connection = self.child_connection = self.process = None
        self.started = False
        self.closed = False
        self.events = queue.Queue(maxsize=8)
        self.stop_reader = threading.Event()
        self.reader = None

    def __enter__(self):
        self.connection, self.child_connection = self.context.Pipe(duplex=True)
        self.process = self.context.Process(target=_worker, args=(self.child_connection, self.config))
        try:
            self.process.start()
            self.started = True
            self.child_connection.close()
            # recv_bytes may block after a partial native pipe frame: keep it off
            # the deadline-owning thread, and reap the child before joining reader.
            self.reader = threading.Thread(target=self._read_events, daemon=True,
                                           name='local-asr-ipc')
            self.reader.start()
        except BaseException:
            self.close()
            raise
        return self

    def _read_events(self):
        while not self.stop_reader.is_set():
            try:
                payload = self.connection.recv_bytes(MAX_IPC_BYTES)
                event = json.loads(payload)
                if not isinstance(event, dict):
                    raise ValueError
            except (EOFError, OSError, ValueError, TypeError):
                event = {'event': 'error', 'code': 'worker_failed'}
            while not self.stop_reader.is_set():
                try:
                    self.events.put(event, timeout=0.1)
                    break
                except queue.Full:
                    continue
            if event.get('event') == 'error':
                return

    def _receive(self, deadline):
        while True:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise ASRError('asr_timeout')
            try:
                event = self.events.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            if event.get('event') == 'error':
                raise ASRError(event.get('code', 'asr_error'))
            return event

    def ready(self):
        event = self._receive(self.clock() + self.timeout)
        if event.get('event') != 'ready':
            raise ASRError('worker_failed')
        return event

    def transcribe(self, audio_path, on_event):
        try:
            # Small parent command uses multiprocessing's trusted local pickle;
            # engine output always uses bounded JSON bytes on a reader thread.
            self.connection.send({'event': 'transcribe', 'audio_path': str(audio_path)})
        except (OSError, EOFError):
            raise ASRError('worker_failed') from None
        deadline = self.clock() + self.timeout
        seen_info = False
        while True:
            event = self._receive(deadline)
            kind = event.get('event')
            if kind == 'info' and not seen_info:
                seen_info = True
            elif kind == 'segment' and seen_info:
                pass
            elif kind == 'done' and seen_info:
                # All generator values were consumed; still require clean exit.
                self.process.join(timeout=min(2, max(0, deadline - self.clock())))
                if self.process.is_alive():
                    raise ASRError('asr_timeout')
                if self.process.exitcode != 0:
                    raise ASRError('worker_failed')
                return
            else:
                raise ASRError('worker_failed')
            on_event(event)

    def close(self):
        if self.closed:
            return
        self.stop_reader.set()
        try:
            if self.process is not None and self.started:
                if self.process.is_alive():
                    self.process.terminate()
                self.process.join(timeout=2)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join(timeout=2)
                if self.process.is_alive():
                    # Do not silently proceed while the native process still owns audio.
                    raise ASRError('worker_failed')
        finally:
            for connection in (self.connection, self.child_connection):
                if connection is not None:
                    connection.close()
            if self.reader is not None:
                self.reader.join(timeout=2)
            if self.process is not None and self.started and not self.process.is_alive():
                self.process.close()
                self.closed = True

    def __exit__(self, exc_type, exc, tb):
        self.close()


def finite_number(value, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ASRError('invalid_timestamp')
    if value < 0 or (positive and value <= 0):
        raise ASRError('invalid_timestamp')
    return float(value)


def validate_segments(raw_segments, info, source, max_duration):
    duration = finite_number(info.get('duration'), positive=True)
    if duration > max_duration:
        raise ASRError('duration_mismatch')
    source_duration = finite_number(source.get('duration_seconds'), positive=True)
    if abs(source_duration - duration) > max(2.0, source_duration * 0.02):
        raise ASRError('duration_mismatch')
    segments, warnings = [], []
    previous_start = -1
    seen_text = set()
    for index, raw in enumerate(raw_segments):
        if not isinstance(raw, dict) or not isinstance(raw.get('text'), str):
            raise ASRError('invalid_timestamp')
        start, end = finite_number(raw.get('start')), finite_number(raw.get('end'))
        if (end <= start or round(end * 1000) <= round(start * 1000)
                or start < previous_start or end > duration + 0.05):
            raise ASRError('invalid_timestamp')
        if 'duration' in raw and abs(finite_number(raw['duration'], positive=True) - (end-start)) > 0.001:
            raise ASRError('duration_mismatch')
        previous_start = start
        text = raw['text']  # no normalization, deletion, de-duplication or hallucinated repairs
        normalized = {'start': start, 'end': end, 'duration': end-start, 'text': text}
        for field in ('avg_logprob', 'no_speech_prob', 'compression_ratio'):
            value = raw.get(field)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                warnings.append(f'segment_{index}:invalid_{field}')
            normalized[field] = value
        if ((isinstance(raw.get('avg_logprob'), (int, float)) and raw['avg_logprob'] < -1)
                or (isinstance(raw.get('no_speech_prob'), (int, float)) and raw['no_speech_prob'] > 0.6)
                or (isinstance(raw.get('compression_ratio'), (int, float)) and raw['compression_ratio'] > 2.4)):
            warnings.append(f'segment_{index}:low_confidence_or_repetition_risk_preserved')
        if text.strip() in seen_text and text.strip():
            warnings.append(f'segment_{index}:repeated_text_preserved')
        seen_text.add(text.strip())
        segments.append(normalized)
    if not segments or not any(segment['text'].strip() for segment in segments):
        raise ASRError('empty_output')
    if segments[0]['start'] > 15:
        warnings.append('leading_audio_without_transcribed_text')
    if duration - max(s['end'] for s in segments) > max(30, duration * 0.05):
        warnings.append('trailing_audio_without_transcribed_text_possible_early_stop')
    prior_end = 0
    for segment in segments:
        if segment['start'] - prior_end > 30:
            warnings.append('long_gap_without_transcribed_text')
        prior_end = max(prior_end, segment['end'])
    warnings.append('coverage_and_content_not_verified_no_visual_or_speaker_verification')
    return segments, duration, list(dict.fromkeys(warnings))


def safe_source(raw):
    """Whitelist metadata; rebuild public URL so tokens/signatures cannot persist."""
    if not isinstance(raw, dict):
        raise ASRError('audio_invalid')
    keys = ('platform', 'id', 'title', 'duration_seconds', 'bvid', 'page', 'cid', 'part',
            'audio_format_id', 'audio_language', 'audio_track_note', 'audio_sha256', 'audio_bytes',
            'identity_verification', 'warnings')
    result = {key: raw[key] for key in keys if key in raw}
    platform = result.get('platform')
    if platform == 'youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}', str(result.get('id', ''))):
        result['source_url'] = 'https://www.youtube.com/watch?v=' + result['id']
    elif platform == 'bilibili' and re.fullmatch(r'BV[0-9A-Za-z]{10}', str(result.get('bvid', ''))):
        page = result.get('page')
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise ASRError('audio_invalid')
        result['source_url'] = f'https://www.bilibili.com/video/{result["bvid"]}?p={page}'
    else:
        raise ASRError('audio_invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', str(result.get('audio_sha256', ''))):
        raise ASRError('audio_invalid')
    return result


def verify_audio(path, directory, source, args):
    original = Path(path)
    audio = original.resolve()
    root = Path(directory).resolve()
    if audio.parent != root or not audio.is_file() or original.is_symlink():
        raise ASRError('audio_invalid')
    size = audio.stat().st_size
    if size <= 0 or size > args.max_audio_mib * 1024 * 1024 or source.get('audio_bytes') != size:
        raise ASRError('audio_invalid')
    digest = hashlib.sha256()
    with audio.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != source.get('audio_sha256'):
        raise ASRError('audio_invalid')
    duration = finite_number(source.get('duration_seconds'), positive=True)
    if duration > args.max_duration:
        raise ASRError('duration_mismatch')
    return audio


def stamp(seconds, srt=False):
    total = round(seconds * 1000)
    hours, total = divmod(total, 3600000)
    minutes, total = divmod(total, 60000)
    secs, millis = divmod(total, 1000)
    return f'{hours:02}:{minutes:02}:{secs:02}{"," if srt else "."}{millis:03}'


def markdown_literal(text):
    # HTML escaping plus backslash escapes keep untrusted ASR text as literal data.
    import html
    escaped = html.escape(text, quote=False)
    return re.sub(r'([\\`*_{}\[\]()#+.!|>~-])', r'\\\1', escaped).replace('\n', '  \n')


def write_transcripts(out, segments):
    header = 'AI 本地 ASR 自动转写（非人工、非平台字幕，未经核验）'
    with (out / 'transcript.txt').open('x', encoding='utf-8', newline='\n') as txt, \
            (out / 'transcript.md').open('x', encoding='utf-8', newline='\n') as md, \
            (out / 'transcript.srt').open('x', encoding='utf-8', newline='\n') as srt:
        txt.write(header + '\n\n')
        md.write('# ' + header + '\n\n')
        for index, segment in enumerate(segments, 1):
            timing = f'[{stamp(segment["start"])} --> {stamp(segment["end"])}]'
            txt.write(timing + ' ' + segment['text'] + '\n')
            md.write(timing + ' ' + markdown_literal(segment['text']) + '\n\n')
            srt.write(f'{index}\n{stamp(segment["start"], True)} --> {stamp(segment["end"], True)}\n'
                      + segment['text'] + '\n\n')


def validate_options(args):
    if args.language not in ('en', 'zh', 'auto') or args.reason not in REASONS:
        raise ASRError('invalid_input')
    if args.device not in ('cpu', 'cuda'):
        raise ASRError('invalid_input')
    for name in ('download_timeout', 'asr_timeout', 'max_audio_mib', 'max_duration', 'beam_size'):
        value = getattr(args, name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ASRError('invalid_input')
    if args.page is not None and args.page < 1:
        raise ASRError('invalid_input')
    if not args.compute_type:
        args.compute_type = 'int8' if args.device == 'cpu' else 'float16'


def transcribe(args, downloader=None, worker_factory=WorkerSession):
    """Return safe JSON status; never log URLs, cookies, proxy or engine exceptions."""
    out = Path(args.out)
    if not out.is_absolute():
        raise ASRError('invalid_input')
    if out.exists():
        raise ASRError('output_exists')
    try:
        out.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise ASRError('output_exists') from None
    except OSError:
        raise ASRError('output_error') from None
    started = utc_now()
    raw = {'schema_version': 1, 'status': 'incomplete', 'engine': 'faster-whisper',
           'parameters': {}, 'segments': [], 'info': None, 'content_verified': False}
    raw_written = False
    audio_error = None
    try:
        validate_options(args)
        model_dir = model_directory(args.model_dir)  # before worker or audio download
        config = {'model_dir': str(model_dir), 'language': args.language,
                  'device': args.device, 'compute_type': args.compute_type,
                  'vad_filter': args.vad_filter, 'beam_size': args.beam_size}
        raw['parameters'] = dict(transcription_parameters(config), local_files_only=True,
                                 device=args.device, compute_type=args.compute_type)
        with worker_factory(config, args.asr_timeout) as worker:
            ready = worker.ready()  # native model load ready BEFORE any network request
            raw.update(model=ready['model'], engine_version=ready['engine_version'])
            try:
                from audio_sources import AudioSourceError, download_audio
            except ImportError:
                raise ASRError('dependency_missing') from None
            if downloader is None:
                downloader = download_audio
            with tempfile.TemporaryDirectory(prefix='youtube-study-asr-') as directory:
                try:
                    # Backend-only memory value; never a parser flag, worker config or file.
                    private_options = {}
                    session = getattr(args, 'bili_sessdata', None)
                    if session is not None:
                        private_options['bili_sessdata'] = session
                    audio_path, source_data = downloader(
                        args.target, directory, page=args.page, proxy=args.proxy,
                        cookies=args.cookies, bili_cookie_file=args.bili_cookie_file,
                        max_bytes=int(args.max_audio_mib * 1024 * 1024),
                        max_duration=args.max_duration, timeout=args.download_timeout,
                        audio_language=args.audio_language, audio_format=args.audio_format,
                        **private_options)
                except KeyboardInterrupt:
                    raise
                except AudioSourceError as exc:
                    # Only this module's explicitly safe exception is exposed;
                    # arbitrary dependency exceptions and URLs never are.
                    code = exc.code if exc.code in SAFE_CODES else 'download_error'
                    audio_error = {'code': code, 'message': exc.message}
                    raise ASRError(code) from None
                except Exception:
                    raise ASRError('download_error') from None
                source = safe_source(source_data)
                audio_path = verify_audio(audio_path, directory, source, args)

                def on_event(event):
                    if event['event'] == 'segment':
                        if len(raw['segments']) >= MAX_SEGMENTS:
                            raise ASRError('asr_error')
                        raw['segments'].append(event['segment'])
                    elif event['event'] == 'info':
                        raw['info'] = event['info']

                try:
                    worker.transcribe(audio_path, on_event)
                finally:
                    # Stop worker before TemporaryDirectory removes a still-open audio.
                    worker.close()
        segments, duration, warnings = validate_segments(raw['segments'], raw['info'] or {}, source, args.max_duration)
        source_warnings = source.get('warnings', [])
        if isinstance(source_warnings, list):
            warnings.extend('audio_source: ' + warning for warning in source_warnings if isinstance(warning, str))
        if args.language == 'auto':
            warnings.insert(0, 'auto_language_detection_requested_language_not_forced')
        if args.vad_filter:
            warnings.append('vad_enabled_engine_original_audio_timestamps_preserved_not_rebased')
        raw['status'] = 'complete'
        write_json(out / 'raw-asr.json', raw)
        raw_written = True
        write_transcripts(out, segments)
        language = args.language if args.language != 'auto' else (raw['info'].get('language') or 'unknown')
        metadata = {'schema_version': 1, 'status': 'ok', 'caption_kind': 'local_asr',
                    'caption_origin': 'AI local ASR; not human or platform captions',
                    'language': language, 'forced_language': None if args.language == 'auto' else args.language,
                    'requested_language': args.language, 'reason': args.reason,
                    'fallback_decision': 'explicit_cli_invocation_not_inferred_from_network_error',
                    'source_url': source['source_url'], 'video_id': source.get('id'),
                    'title': source.get('title'), 'source': source, 'duration_seconds': duration,
                    'engine': 'faster-whisper', 'engine_version': ready['engine_version'],
                    'model': ready['model'], 'parameters': raw['parameters'],
                    'created_at': utc_now(), 'started_at': started,
                    'content_verified': False, 'coverage_verified': False,
                    'warnings': warnings, 'segments': segments,
                    'files': {'raw': 'raw-asr.json', 'text': 'transcript.txt',
                              'markdown': 'transcript.md', 'srt': 'transcript.srt'},
                    'untrusted_data_fields': ['title', 'source', 'segments', 'raw-asr.json']}
        # Success marker LAST. No metadata.json exists on engine/validation failure.
        write_json(out / 'metadata.json', metadata)
        return {'status': 'ok', 'output': str(out), 'caption_kind': 'local_asr',
                'language': language, 'segments': len(segments), 'content_verified': False,
                'warnings': warnings}
    except BaseException as exc:
        code = 'cancelled' if isinstance(exc, KeyboardInterrupt) else (
            exc.code if isinstance(exc, ASRError) else 'asr_error')
        failure_message = audio_error['message'] if audio_error else MESSAGES[code]
        try:
            if not raw_written:
                raw['status'] = 'failed'
                raw['failure_code'] = code
                write_json(out / 'raw-asr.json', raw)
            write_json(out / 'failure.json', {'status': 'failed', 'code': code,
                                            'message': failure_message, 'created_at': utc_now(),
                                            'content_verified': False, 'success': False,
                                            'audio_error': audio_error})
        except OSError:
            pass
        return {'status': code, 'message': failure_message, 'output': str(out),
                'success': False, 'audio_error': audio_error}


def build_parser():
    parser = argparse.ArgumentParser(description='显式本地 AI ASR；不自动判定无字幕，不安装或下载模型。')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('status', help='仅离线静态检查，不宣称运行就绪')
    p.add_argument('--model-dir')
    p = sub.add_parser('transcribe')
    p.add_argument('target')
    p.add_argument('--model-dir', required=True, help='完整本地CTranslate2目录；必须包含tokenizer及preprocessor')
    p.add_argument('--language', required=True, choices=('en', 'zh', 'auto'))
    p.add_argument('--reason', required=True, choices=REASONS)
    p.add_argument('--out', required=True, help='新的绝对目录；不覆盖')
    p.add_argument('--page', type=int)
    p.add_argument('--proxy')
    p.add_argument('--cookies')
    p.add_argument('--bili-cookie-file')
    p.add_argument('--audio-language')
    p.add_argument('--audio-format')
    p.add_argument('--device', choices=('cpu', 'cuda'), default='cpu')
    p.add_argument('--compute-type', help='默认cpu=int8，cuda=float16')
    p.add_argument('--download-timeout', type=float, default=300)
    p.add_argument('--asr-timeout', type=float, default=3600, help='分别限制模型加载及生成器消费；下载另计')
    p.add_argument('--max-audio-mib', type=float, default=512)
    p.add_argument('--max-duration', type=float, default=14400)
    p.add_argument('--beam-size', type=int, default=5)
    p.add_argument('--vad-filter', action=argparse.BooleanOptionalAction, default=True, help='使用引擎VAD且不重排原时间轴')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        result = status_report(args) if args.command == 'status' else transcribe(args)
    except ASRError as exc:
        result = {'status': exc.code, 'message': MESSAGES[exc.code], 'success': False}
    except KeyboardInterrupt:
        result = {'status': 'cancelled', 'message': MESSAGES['cancelled'], 'success': False}
    except Exception:
        result = {'status': 'asr_error', 'message': MESSAGES['asr_error'], 'success': False}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    if args.command == 'status':
        return 2  # static-only report deliberately never claims runtime readiness
    return 0 if result['status'] == 'ok' else (130 if result['status'] == 'cancelled' else 1)


if __name__ == '__main__':
    multiprocessing.freeze_support()
    raise SystemExit(main())
