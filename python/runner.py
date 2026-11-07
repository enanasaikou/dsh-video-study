"""Portable DSH JSON-stdin bridge; configuration/secrets never enter argv or output.
Caption-only is the default; backend changes come from user settings only.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone
import importlib.metadata
import io
import json
import math
from pathlib import Path
import re
import sys
import tempfile
import time
from types import SimpleNamespace

# Embeddable CPython's isolated _pth intentionally excludes the script directory.
# Add only this installed plugin's code directory, never cwd or user site-packages.
_PLUGIN_CODE = str(Path(__file__).resolve().parent)
if _PLUGIN_CODE not in sys.path:
    sys.path.insert(0, _PLUGIN_CODE)

MODES = ('captions', 'cloud')
LANGUAGES = ('en', 'zh', 'auto')
# Protocol stage names are constants owned by the adapter modules; anything else
# (provider text, ids, URLs) must never reach failure output.
STAGE_NAME = re.compile(r'[a-z][a-z_]{0,39}')
RESULT_HOST = re.compile(r'[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]')
FALLBACK_CODES = {'no_captions', 'language_unavailable'}
MESSAGES = {
    'invalid_input': '参数无效，请检查模式、语言和新的绝对输出目录。',
    'unsupported_backend': '云端版仅支持 captions/cloud；不支持 local 或其他后端。',
    'asr_disabled': '仅字幕模式不下载音轨、不启用 ASR。',
    'no_captions': '没有可用的已有字幕；仅字幕模式不下载音轨。',
    'language_unavailable': '没有符合要求的源语言字幕；不接受跨语言或自动翻译轨。',
    'dependency_missing': '缺少依赖；请使用插件准备入口，不会自动安装。',
    'output_exists': '输出路径已存在，未覆盖。',
    'caption_error': '字幕读取未完成；不将其当作无字幕转写。',
    'credential_file_invalid': 'API 密钥文件不可读或格式无效；未上传音频。',
    'invalid_response': '后端结果或时间戳无效。',
    'cancelled': '任务已取消。',
    'operation_failed': '任务未完成；不输出底层异常、凭据或签名链接。',
    'invalid_session': 'B站登录态格式无效；未发起平台请求。',
    'credential_conflict': 'B站文件凭据与后台登录态不能同时配置。',
}


class RunnerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES.get(code, MESSAGES['operation_failed']))


def fail(code):
    raise RunnerError(code)


def number(config, key, default):
    value = config.get(key, default)
    ceilings = {'downloadTimeout': 3600, 'asrTimeout': 86400, 'maxDuration': 86400,
                'cloudMaxAudioMiB': 512}
    if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
            or value <= 0 or value > ceilings.get(key, float('inf'))):
        fail('invalid_input')
    return value


def text(config, key, default=''):
    value = config.get(key, default)
    if not isinstance(value, str):
        fail('invalid_input')
    return value


def mode_of(request, config):
    mode = config.get('mode', 'captions')
    if mode not in MODES:
        fail('unsupported_backend')
    if not isinstance(request.get('captionsOnly', False), bool):
        fail('invalid_input')
    return 'captions' if request.get('captionsOnly', False) else mode


def cloud_config(config, language, read_key=False):
    key = text(config, 'cloudApiKey')
    key_file = text(config, 'cloudApiKeyFile')
    if read_key and key_file and not key:
        try:
            path = Path(key_file)
            if not path.is_absolute() or not path.is_file() or path.stat().st_size > 16384:
                fail('credential_file_invalid')
            key = path.read_text(encoding='utf-8-sig').strip()
            if not key or len(key) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in key):
                fail('credential_file_invalid')
        except (OSError, UnicodeError):
            fail('credential_file_invalid')
    return dict(endpoint=text(config, 'cloudEndpoint'), api_key=key,
                protocol=text(config, 'cloudProtocol', 'auto'), provider_name=text(config, 'cloudProviderName'),
                response_format=text(config, 'cloudResponseFormat', 'verbose_json'),
                app_id=text(config, 'cloudAppId'), region=text(config, 'cloudRegion'), resource_id=text(config, 'cloudResourceId'),
                model=text(config, 'cloudModel'), language=language,
                upload_consent=config.get('cloudUploadConsent', False),
                timeout=number(config, 'asrTimeout', 900),
                max_bytes=int(number(config, 'cloudMaxAudioMiB', 25) * 1024 * 1024),
                allow_insecure_loopback=config.get('allowInsecureLoopback', False),
                proxy=text(config, 'proxy') or None)


def status(config, mode):
    if mode not in MODES:
        fail('unsupported_backend')
    try:
        yt_version = importlib.metadata.version('yt-dlp')
    except importlib.metadata.PackageNotFoundError:
        yt_version = None
    result = {'status': 'ok', 'operation': 'status', 'mode': mode, 'network_used': False,
              'caption_support': {'youtube_dependency': yt_version,
                                  'bilibili': 'standard_library'},
              'asr_enabled': mode != 'captions', 'runtime_ready': False,
              'warnings': ['静态检查不证明平台可访问、字幕可靠或 ASR 可运行。']}
    if mode == 'captions':
        # Top-level ok means the check completed, not that optional dependencies
        # exist. Report actual offline readiness without importing packages.
        try:
            docx_version = importlib.metadata.version('python-docx')
        except importlib.metadata.PackageNotFoundError:
            docx_version = None
        missing = [name for name, version in (('yt-dlp', yt_version), ('python-docx', docx_version))
                   if version is None]
        result['document_support'] = {'docx_dependency': docx_version}
        result['backend'] = {'kind': 'none', 'needs_api': False,
                             'status': 'dependency_missing' if missing else 'ok',
                             'missing_dependencies': missing, 'python_executable': sys.executable}
    else:
        from cloud_asr import CloudASRError, validate_cloud_config
        try:
            result['backend'] = validate_cloud_config(cloud_config(config, 'auto'))
            result['backend']['api_key_file_configured'] = bool(config.get('cloudApiKeyFile'))
            result['backend']['credential_file_read'] = False
        except CloudASRError as exc:
            result['backend'] = {'configured': False, 'status': exc.code, 'message': exc.message}
    return result


def bili_session(config):
    """Read the private JSON-stdin field only for a selected Bilibili target."""
    from bilibili_subtitles import SafeFailure, validate_session
    session = config.get('biliSessdata')
    if session is not None:
        if text(config, 'biliCookieFile'):
            fail('credential_conflict')
        try:
            return validate_session(session)
        except SafeFailure:
            fail('invalid_session')
    return None


def caption_extract(target, out, language, config, page=None):
    from audio_sources import _target
    platform, canonical, video_id, selected_page = _target(target, page)
    if platform == 'youtube':
        import ytstudy
        args = SimpleNamespace(target=canonical, lang='en,zh' if language == 'auto' else language,
                               allow_other=False, list_languages=False, no_dedupe=False,
                               reject_translated=True, out=str(out),
                               proxy=text(config, 'proxy') or None,
                               cookies=text(config, 'youtubeCookieFile') or None)
        try:
            return ytstudy.extract(args)
        except ytstudy.StudyError as exc:
            # These controlled messages never contain raw third-party exceptions.
            return {'status': exc.code, 'message': exc.message}
    import bilibili_subtitles as bili
    session = bili_session(config)
    argv = ['bilibili_subtitles', '--bvid', video_id, '--page', str(selected_page),
            '--lang', language, '--out', str(out)]
    for key, flag in (('proxy', '--proxy'), ('biliCookieFile', '--cookie-file')):
        if text(config, key):
            argv += [flag, config[key]]
    previous = sys.argv
    buffer = io.StringIO()
    try:
        sys.argv = argv
        with contextlib.redirect_stdout(buffer):
            bili.main(session_override=session)
        return json.loads(buffer.getvalue())
    except bili.SafeFailure as exc:
        code = exc.payload['status']
        if code == 'no_subtitle_tracks_returned':
            code = 'no_captions'
        elif code == 'chinese_subtitle_unavailable':
            code = 'language_unavailable'
        return {'status': code, 'message': MESSAGES.get(code, MESSAGES['caption_error'])}
    finally:
        sys.argv = previous


def caption_bundle(result, out, canonical):
    meta_path = out / 'metadata.json'
    transcript = out / 'transcript.txt'
    if not meta_path.is_file() or not transcript.is_file():
        fail('invalid_response')
    metadata = json.loads(meta_path.read_text(encoding='utf-8'))
    metadata.update(source_url=canonical, content_verified=False, coverage_verified=False,
                    caption_origin='platform_published_caption',
                    reliability_note='文件获取成功不是可靠性认证；需核对主题、分P及全文覆盖。')
    warnings = metadata.get('warnings')
    warnings = [w for w in warnings if isinstance(w, str)] if isinstance(warnings, list) else []
    warnings.append('caption_content_and_coverage_require_review')
    metadata['warnings'] = warnings
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'status': 'ok', 'output': str(out), 'metadata_file': str(meta_path),
            'transcript_file': str(transcript), 'caption_kind': metadata.get('caption_kind', result.get('kind')),
            'language': metadata.get('language'), 'content_verified': False,
            'warnings': warnings, 'audio_downloaded': False, 'audio_uploaded': False}


def audio_cookie_options(request, config):
    from audio_sources import _target
    platform, _, _, _ = _target(request['target'], request.get('page'))
    credentials = {'cookies': (text(config, 'youtubeCookieFile') or None) if platform == 'youtube' else None,
                   'bili_cookie_file': (text(config, 'biliCookieFile') or None) if platform == 'bilibili' else None}
    if platform == 'bilibili':
        session = bili_session(config)
        if session is not None:
            credentials['bili_sessdata'] = session
    return credentials


def write_cloud_text(out, segments):
    from cloud_output import markdown_literal, stamp
    header = 'AI 云端 ASR 转写（未经校订，非平台字幕）'
    with (out / 'transcript.txt').open('x', encoding='utf-8') as txt, \
         (out / 'transcript.md').open('x', encoding='utf-8') as md, \
         (out / 'transcript.srt').open('x', encoding='utf-8') as srt:
        txt.write(header + '\n\n')
        md.write('# ' + header + '\n\n')
        for i, item in enumerate(segments, 1):
            timing = f'[{stamp(item["start"])} --> {stamp(item["end"])}]'
            txt.write(timing + ' ' + item['text'] + '\n')
            md.write(timing + ' ' + markdown_literal(item['text']) + '\n\n')
            srt.write(f'{i}\n{stamp(item["start"], True)} --> {stamp(item["end"], True)}\n'
                      + item['text'].replace('\r', ' ').replace('\n', ' ') + '\n\n')


def write_cloud_plain(out, body):
    from cloud_output import markdown_literal
    header = 'AI 云端 ASR 转写（未经校订，非平台字幕；服务未提供时间戳）'
    (out / 'transcript.txt').write_text(header + '\n\n' + body + '\n', encoding='utf-8')
    (out / 'transcript.md').write_text('# ' + header + '\n\n' + markdown_literal(body) + '\n', encoding='utf-8')


def cloud_extract(request, config, out, reason, downloader=None, transcriber=None):
    from cloud_asr import validate_cloud_config, transcribe_cloud
    from audio_sources import download_audio
    from cloud_output import safe_source, verify_audio, validate_segments, write_json
    # Consent is checked before reading an explicitly configured credential file.
    validate_cloud_config(cloud_config(config, request.get('language', 'auto')))
    download_timeout = number(config, 'downloadTimeout', 300)
    max_duration = number(config, 'maxDuration', 14400)
    options = cloud_config(config, request.get('language', 'auto'), read_key=True)
    preflight = validate_cloud_config(options)  # credentials/config before media download
    engine = preflight['engine']  # trusted adapter choice, not arbitrary provider response text
    if engine in ('volcengine_flash', 'tencent_rec_task') and not options['api_key']:
        from cloud_asr import CloudASRError, _MESSAGES
        raise CloudASRError('invalid_api_key', _MESSAGES['invalid_api_key'])
    native = engine == 'aliyun_paraformer'
    downloader = downloader or download_audio
    transcriber = transcriber or transcribe_cloud
    raw = None
    created = False
    try:
        out.mkdir(parents=True, exist_ok=False)
        created = True
        credentials = audio_cookie_options(request, config)
        # Never ask tempfile to choose a system/cwd fallback. This directory
        # belongs to the new output, and cleanup never removes transcript files.
        with tempfile.TemporaryDirectory(prefix='.audio-', dir=out) as directory:
            audio, source_data = downloader(request['target'], directory, page=request.get('page'),
                proxy=options['proxy'], **credentials,
                max_bytes=options['max_bytes'], max_duration=max_duration,
                timeout=download_timeout,
                audio_language=request.get('audioLanguage'), audio_format=request.get('audioFormat'))
            source = safe_source(source_data)
            args = SimpleNamespace(max_audio_mib=options['max_bytes'] / (1024 * 1024),
                                   max_duration=max_duration)
            audio = verify_audio(audio, directory, source, args)
            if preflight.get('protocol') == 'volcengine_flash':
                from audio_prepare import prepare_cloud_audio
                started = time.monotonic()
                audio, prepared_source = prepare_cloud_audio(audio, directory, source,
                    {**options, 'protocol': preflight['protocol']})
                source = safe_source(prepared_source)
                audio = verify_audio(audio, directory, source, args)
                remaining = options['timeout'] - (time.monotonic() - started)
                if remaining <= 0:
                    from cloud_asr import CloudASRError, _MESSAGES
                    raise CloudASRError('timeout', _MESSAGES['timeout'])
                options = {**options, 'timeout': remaining}
            raw = transcriber(audio, **options)
        info = dict(raw.get('info') or {})
        duration_from_api = info.get('duration') is not None
        if not duration_from_api:
            info['duration'] = source['duration_seconds']
        text_only = raw.get('text_only') is True
        if text_only:
            body = raw.get('text')
            if not isinstance(body, str) or not body.strip() or raw.get('segments'):
                from cloud_asr import CloudASRError, _MESSAGES
                raise CloudASRError('invalid_response', _MESSAGES['invalid_response'])
            segments, duration = [], info['duration']
            warnings = ['provider_did_not_supply_timestamps_no_subtitle_file_generated']
        else:
            segments, duration, warnings = validate_segments(raw.get('segments', []), info, source, args.max_duration)
        warnings.extend(w for w in raw.get('warnings', []) if isinstance(w, str))
        warnings.extend('audio_source: ' + w for w in source.get('warnings', []) if isinstance(w, str))
        if not duration_from_api:
            warnings.append('duration_from_platform_not_independently_decoded_by_client')
        if options['language'] == 'auto':
            warnings.append('auto_language_detection_can_be_wrong')
        write_json(out / 'raw-asr.json', {'status': 'complete', 'engine': 'cloud_asr', 'result': raw,
                   'source': source, 'content_verified': False})
        if text_only:
            write_cloud_plain(out, body)
        else:
            write_cloud_text(out, segments)
        metadata = {'status': 'ok', 'caption_kind': 'cloud_asr', 'caption_origin': 'AI cloud ASR',
            'source_url': source['source_url'], 'title': source.get('title'), 'source': source,
            'language': info.get('language') or 'unknown', 'forced_language': None,
            'language_hint': options['language'] if preflight.get('language_parameter_sent') and options['language'] != 'auto' else None,
            'requested_language': options['language'],
            'reason': reason, 'duration_seconds': duration, 'duration_from_api': duration_from_api,
            'engine': engine, 'response_format': 'text_json' if text_only and engine == 'openai_compatible_audio_transcriptions' else preflight['response_format'],
            'protocol': preflight.get('protocol'), 'model': options['model'], 'timestamps_available': not text_only,
            'transcript_kind': 'plain_text' if text_only else 'timestamped_segments',
            'audio_uploaded': True, 'upload_consent': True, 'endpoint': 'explicit_user_configuration_not_persisted',
            'content_verified': False, 'coverage_verified': False, 'segments': segments,
            'warnings': list(dict.fromkeys(warnings)), 'created_at': datetime.now(timezone.utc).isoformat()}
        write_json(out / 'metadata.json', metadata)  # success marker last
        return {'status': 'ok', 'output': str(out), 'metadata_file': str(out / 'metadata.json'),
                'transcript_file': str(out / 'transcript.txt'), 'caption_kind': 'cloud_asr',
                'language': metadata['language'], 'warnings': metadata['warnings'],
                'content_verified': False, 'audio_uploaded': True}
    except BaseException as exc:
        if created:
            try:
                stage = getattr(exc, 'stage', None)
                shape = getattr(exc, 'shape', None)
                host = getattr(exc, 'host', None)
                reason = getattr(exc, 'reason', None)
                write_json(out / 'failure.json', {'status': 'failed', 'success': False,
                           'stage': stage if isinstance(stage, str) and STAGE_NAME.fullmatch(stage) else None,
                           'shape': (shape[:300] if isinstance(shape, str)
                                     and all(ch.isalnum() or ch in '_:,;-' for ch in shape) else None),
                           'result_host': (host[:253] if isinstance(host, str)
                                           and RESULT_HOST.fullmatch(host) else None),
                           'result_reason': (reason if isinstance(reason, str)
                                             and STAGE_NAME.fullmatch(reason) else None),
                           'note': ('云端转写未完成；可能已经向用户指定服务上传音频。'
                                    + ('阿里临时OSS约48小时后清理；远端任务可能继续并产生费用，未自动重提。' if native else '远端任务可能继续并产生费用，未自动重提。' if engine == 'tencent_rec_task' else ''))})
                if raw is not None and not (out / 'raw-asr.json').exists():
                    write_json(out / 'raw-asr.json', {'status': 'failed', 'result': raw})
            except OSError:
                pass
        raise


def dispatch(request, caption_fn=None, cloud_fn=None):
    if not isinstance(request, dict) or not isinstance(request.get('config', {}), dict):
        fail('invalid_input')
    config = request.get('config', {})
    mode = mode_of(request, config)
    if request.get('operation', 'extract') == 'status':
        return status(config, mode)
    if request.get('operation', 'extract') != 'extract':
        fail('invalid_input')
    language = request.get('language', 'auto')
    if language not in LANGUAGES or not isinstance(request.get('forceAsr', False), bool):
        fail('invalid_input')
    from audio_sources import _target
    _, canonical, _, _ = _target(request.get('target'), request.get('page'))
    raw_out = request.get('out')
    if not isinstance(raw_out, str) or not raw_out or not Path(raw_out).is_absolute():
        fail('invalid_input')
    out = Path(raw_out)
    if out.exists() or out.is_symlink():
        fail('output_exists')
    if request.get('forceAsr', False):
        if mode == 'captions':
            fail('asr_disabled')
        reason = request.get('reason', 'user_requested')
        if reason not in ('user_requested', 'unreliable_captions'):
            fail('invalid_input')
    else:
        caption_fn = caption_fn or caption_extract
        result = caption_fn(request['target'], out, language, config, request.get('page'))
        code = result.get('status')
        if code == 'ok':
            return caption_bundle(result, out, canonical)
        if mode == 'captions' or code not in FALLBACK_CODES or out.exists():
            return {'status': code or 'caption_error', 'message': result.get('message', MESSAGES['caption_error']),
                    'mode': mode, 'asr_attempted': False, 'audio_downloaded': False,
                    'content_verified': False}
        reason = code
    return (cloud_fn or cloud_extract)(request, config, out, reason)


def safe_result(value, private_value=None):
    """Drop credential fields and redact the known in-memory value."""
    from bilibili_subtitles import redact_session
    sensitive = {'bilisessdata', 'bili_sessdata', 'session_override', 'sessdata',
                 'cookie', 'cookies', 'authorization', 'proxy-authorization'}
    def clean(item):
        if isinstance(item, dict):
            return {key: clean(val) for key, val in item.items()
                    if not isinstance(key, str) or key.lower() not in sensitive}
        if isinstance(item, list):
            return [clean(val) for val in item]
        return item
    secret = private_value if isinstance(private_value, str) and private_value else None
    return redact_session(clean(value), secret)


def main():
    request = None
    try:
        raw = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            fail('invalid_input')
        request = json.loads(raw.decode('utf-8'))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = dispatch(request)
    except KeyboardInterrupt:
        result = {'status': 'cancelled', 'message': MESSAGES['cancelled'], 'success': False}
    except RunnerError as exc:
        result = {'status': exc.code, 'message': str(exc), 'success': False}
    except Exception as exc:
        # Only module-owned safe errors may reveal their fixed, scrubbed message.
        from audio_sources import AudioSourceError
        try:
            from cloud_asr import CloudASRError
        except ImportError:
            CloudASRError = ()
        if isinstance(exc, AudioSourceError) or (CloudASRError and isinstance(exc, CloudASRError)):
            stage = getattr(exc, 'stage', None)
            result = {'status': exc.code, 'message': exc.message, 'success': False}
            if isinstance(stage, str) and STAGE_NAME.fullmatch(stage):
                result['stage'] = stage
            host = getattr(exc, 'host', None)
            if isinstance(host, str) and RESULT_HOST.fullmatch(host):
                result['result_host'] = host
            reason = getattr(exc, 'reason', None)
            if isinstance(reason, str) and STAGE_NAME.fullmatch(reason):
                result['result_reason'] = reason
        else:
            result = {'status': 'operation_failed', 'message': MESSAGES['operation_failed'], 'success': False}
    config = request.get('config') if isinstance(request, dict) else None
    private_value = config.get('biliSessdata') if isinstance(config, dict) else None
    result = safe_result(result, private_value)
    # ASCII JSON avoids Windows pipe code-page issues.
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    return 0 if result.get('status') == 'ok' else (130 if result.get('status') == 'cancelled' else 1)


if __name__ == '__main__':
    raise SystemExit(main())
