"""Opt-in, protocol-directed transcription using only the standard library.

No SDK, implicit endpoint/credential/proxy lookup, retry, redirect or fabricated
timestamps. Configuration comes from the caller's private stdin config; only
explicitly consented audio is read or uploaded. Titles and transcript text are
untrusted data, not instructions. Large audio is rejected, never split.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import math
import os
import re
import secrets
import ssl
import stat
import time
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_MAX_BYTES = 25 * 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_SEGMENTS = 50000
MAX_TIMESTAMP_MS = 2 ** 53 - 1
CHUNK_BYTES = 64 * 1024


class CloudASRError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


_MESSAGES = {
    'upload_consent_required': '尚未明确授权云端上传；未读取或上传音轨。',
    'invalid_config': '云端转写配置无效；未读取或上传音轨。',
    'invalid_protocol': '云端转写协议无效；请选择受支持的协议。',
    'invalid_response_format': '云端响应格式配置无效；请选择受支持的格式。',
    'invalid_endpoint': '需配置完整的云端转写接口地址；不得含凭据、查询参数或片段。',
    'insecure_endpoint': '云端接口须使用加密连接；仅显式允许本机回环使用非加密连接。',
    'invalid_api_key': '云端凭据格式无效；未读取环境凭据或上传音轨。',
    'invalid_model': '模型名须为非空可打印文本，不得包含控制字符、无效Unicode或凭据；传输上限64KiB。',
    'unsupported_model': '当前转写协议不支持此模型；未上传或提交任务。',
    'protocol_model_mismatch': '协议与模型不匹配：filetrans 异步模型须选择「DashScope 异步」协议；未上传或提交任务。',
    'unsafe_provider_url': '阿里服务返回的上传或结果地址不符合安全白名单；已停止且未转发凭据。',
    'task_failed': '阿里异步转写任务未成功；未回显任务标识、服务响应或重新提交。',
    'invalid_language': '转写语言仅支持英文、中文或自动检测。',
    'invalid_proxy': '代理须为显式指定且无凭据、路径、查询参数的网页代理。',
    'unsupported_proxy': '云端上传仅支持显式非加密网页代理；不降级、不直连。',
    'proxy_loopback_conflict': '本机非加密回环接口不得与代理混用。',
    'invalid_limit': '云端上传大小或累计超时限制无效。',
    'audio_invalid': '本地音轨文件无效、为空、格式不支持或上传中发生变化。',
    'size_limit': '音轨超过本次上传大小限制；未分块上传。',
    'request_too_large': '云端服务拒绝了过大的上传；未分块或重试。',
    'response_too_large': '云端响应超过安全大小限制。',
    'authentication_failed': '云端服务拒绝了凭据；未读取其它凭据或重试。',
    'access_denied': '云端服务拒绝访问；未切换服务或重试。',
    'rate_limited': '云端服务请求被限流；未自动重试。',
    'redirect_rejected': '云端服务返回重定向，已停止，未转发凭据。',
    'unsupported_timestamp': '当前协议未返回可用正文或真实分段时间戳；不会猜造时间戳。',
    'invalid_timestamps': '云端分段时间戳无效、乱序或与返回时长不一致。',
    'language_mismatch': '云端返回语言与要求的转写语言不符。',
    'invalid_response': '云端响应不是受支持的分段转写格式。',
    'provider_error': '云端转写请求失败；未回显服务响应或重试。',
    'network_error': '云端转写网络或加密连接失败。',
    'timeout': '云端上传及响应处理超过累计时限。',
}


def _fail(code):
    raise CloudASRError(code, _MESSAGES[code]) from None


def _no_secret(value, api_key):
    # Compare normalized JSON so quoted/backslashed or \u-escaped credentials
    # cannot bypass exact-secret echo detection.
    if api_key:
        if len(api_key) < 8:
            # Tiny valid header tokens inevitably collide with public field names
            # and ordinary prose. Reject full string values/Bearer echoes instead.
            def echoed(item):
                if isinstance(item, str):
                    return item == api_key or 'Bearer ' + api_key in item
                if isinstance(item, dict):
                    return any(echoed(val) for val in item.values())
                if isinstance(item, (list, tuple)):
                    return any(echoed(val) for val in item)
                return False
            if echoed(value):
                _fail('invalid_response')
        else:
            encoded_key = json.dumps(api_key, ensure_ascii=False)[1:-1]
            if encoded_key in json.dumps(value, ensure_ascii=False):
                _fail('invalid_response')
    return value


def _clean_text(value, limit):
    return (isinstance(value, str) and len(value) <= limit and '\\' not in value
            and '?' not in value and '#' not in value
            and all(ord(char) > 32 and ord(char) != 127 for char in value))


def _numeric(value, code, *, positive=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0 or positive and value == 0):
        _fail(code)
    return float(value)


def _host(value, code):
    if not value:
        _fail(code)
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    try:
        value = value.encode('idna').decode('ascii').lower()
    except (UnicodeError, ValueError):
        _fail(code)
    if (len(value) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', value)
            or any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-')
                   for label in value.split('.'))):
        _fail(code)
    return value


def _endpoint(value, allow_insecure_loopback, protocol='auto'):
    if not _clean_text(value, 2048):
        _fail('invalid_endpoint')
    try:
        parsed = urlsplit(value)
        host = _host(parsed.hostname, 'invalid_endpoint')
        port = parsed.port
        # Compatible providers may use /openai/v1 or another explicit prefix; only
        # unreserved ASCII segments are accepted, with no encoding or dot traversal.
        path = parsed.path
        native_path = path == '/api/v1/services/audio/asr/transcription'
        native_host = (host in ('dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com')
                       or re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com', host))
        safe_path = ((native_path and native_host and parsed.scheme == 'https' and port in (None, 443))
                     or (not native_path
                         and re.fullmatch(r'/(?:[A-Za-z0-9._~-]+/)*audio/transcriptions', path)
                         and all(part not in ('.', '..') for part in path.split('/')[1:])))
        if protocol != 'auto':
            # Explicit protocol: preserve the user's complete route, without a
            # vendor/path whitelist. Reject encodings and ambiguous separators.
            safe_path = (bool(re.fullmatch(r'/[A-Za-z0-9._~!$&\'()*+,;=:@/-]*', path))
                         and not path.startswith('//') and '//' not in path
                         and all(part not in ('.', '..') for part in path.split('/')[1:]))
        if (parsed.scheme not in ('https', 'http') or parsed.username is not None or parsed.password is not None
                or not safe_path or parsed.query or parsed.fragment
                or port is not None and not 1 <= port <= 65535):
            _fail('invalid_endpoint')
    except (ValueError, UnicodeError):
        _fail('invalid_endpoint')
    loopback = host in ('localhost', '127.0.0.1', '::1')
    if parsed.scheme == 'http' and not (allow_insecure_loopback and loopback):
        _fail('insecure_endpoint')
    return parsed.scheme, host, port or (443 if parsed.scheme == 'https' else 80), loopback, path


def _proxy(value):
    if value is None:
        return None
    if not _clean_text(value, 2048):
        _fail('invalid_proxy')
    try:
        parsed = urlsplit(value)
        if parsed.scheme != 'http':
            _fail('unsupported_proxy')
        host = _host(parsed.hostname, 'invalid_proxy')
        port = parsed.port
        if (parsed.username is not None or parsed.password is not None
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment
                or port is not None and not 1 <= port <= 65535):
            _fail('invalid_proxy')
    except (ValueError, UnicodeError):
        _fail('invalid_proxy')
    return host, port or 80


def _validated(config):
    if not isinstance(config, dict):
        _fail('invalid_config')
    if config.get('upload_consent') is not True:
        _fail('upload_consent_required')
    insecure = config.get('allow_insecure_loopback', False)
    if type(insecure) is not bool:
        _fail('invalid_config')
    protocol = config.get('protocol', 'auto')
    if protocol not in ('auto', 'openai', 'dashscope_paraformer', 'dashscope_qwen',
                        'volcengine_flash', 'tencent_rec_task'):
        _fail('invalid_protocol')
    requested_protocol = protocol
    scheme, host, port, loopback, path = _endpoint(config.get('endpoint'), insecure, protocol)
    if protocol == 'auto':
        protocol = ('dashscope_paraformer' if path == '/api/v1/services/audio/asr/transcription'
                    else 'openai')
    if protocol != 'openai' and scheme != 'https':
        _fail('insecure_endpoint')
    api_key = config.get('api_key')
    if api_key is None:
        api_key = ''
    if (not isinstance(api_key, str) or len(api_key) > 8192
            or any(ord(char) < 33 or ord(char) > 126 for char in api_key)):
        _fail('invalid_api_key')
    model = config.get('model')
    if (not isinstance(model, str) or not model
            or any(ord(char) < 32 or ord(char) == 127 for char in model)
            or api_key and (api_key in model if len(api_key) >= 8
                            else model == api_key or 'Bearer ' + api_key in model)):
        _fail('invalid_model')
    try:
        if len(model.encode('utf-8')) > 65536:
            _fail('invalid_model')
    except UnicodeError:
        _fail('invalid_model')
    native = protocol == 'dashscope_paraformer'
    # Models are opaque provider values. The adapter must never silently replace
    # an explicitly selected model with paraformer-v2 or a preset identifier.
    fields = {}
    for name in ('app_id', 'region', 'resource_id'):
        value = config.get(name, '')
        if (not isinstance(value, str) or len(value) > 2048
                or any(ord(ch) < 33 or ord(ch) > 126 for ch in value)
                or api_key and (api_key in value if len(api_key) >= 8 else value == api_key)):
            _fail('invalid_config')
        fields[name] = value
    if (protocol in ('volcengine_flash', 'tencent_rec_task') and not fields['app_id']
            or protocol == 'volcengine_flash' and not fields['resource_id']):
        _fail('invalid_config')
    if native and fields['region'] not in ('', 'cn-beijing', 'ap-southeast-1'):
        _fail('invalid_config')
    provider_name = config.get('provider_name', '')
    if (not isinstance(provider_name, str)
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in provider_name)):
        _fail('invalid_config')
    try:
        provider_name.encode('utf-8')
    except UnicodeError:
        _fail('invalid_config')
    if api_key and (api_key in provider_name if len(api_key) >= 8 else provider_name == api_key):
        _fail('invalid_config')
    requested_format = config.get('response_format', 'verbose_json')
    if requested_format not in ('verbose_json', 'json', 'provider_default'):
        _fail('invalid_response_format')
    language = config.get('language', 'auto')
    if language not in ('en', 'zh', 'auto'):
        _fail('invalid_language')
    timeout = _numeric(config.get('timeout', 900), 'invalid_limit', positive=True)
    maximum = config.get('max_bytes', DEFAULT_MAX_BYTES)
    if type(maximum) is not int or not 0 < maximum <= 512 * 1024 * 1024:
        _fail('invalid_limit')
    proxy = _proxy(config.get('proxy'))
    if scheme == 'http' and proxy is not None:
        _fail('proxy_loopback_conflict')
    warnings = []
    # A *-filetrans model exists only on the DashScope async API; sending it to
    # the OpenAI-compatible chat route is a configuration mistake the service
    # answers with an opaque 4xx, so refuse it locally instead.
    if protocol == 'dashscope_qwen' and 'filetrans' in model.lower():
        _fail('protocol_model_mismatch')
    if not api_key and not loopback:
        warnings.append('未配置云端凭据；仅使用当前明确配置，不读取环境变量，服务可能拒绝访问。')
    if scheme == 'http':
        warnings.append('已显式允许向本机回环服务发送非加密音频请求。')
    if native:
        warnings.extend([
            '阿里临时上传文件由服务端保存约48小时后自动清理；此通道不提供即时删除。',
            '取消或超时仅停止本地等待，已提交的远端任务可能继续运行并产生费用；不会自动重新提交。',
            '阿里 language_hints 为识别提示而非强制语言或翻译；未返回语言时不推断识别语言。',
        ])
        if 'paraformer' not in model.lower() and 'filetrans' not in model.lower() and 'fun-asr' not in model.lower():
            warnings.append('所选模型未标明 filetrans/paraformer 异步族；若该服务要求同步调用，请改用兼容协议。')
    engine, actual_format = {
        'openai': ('openai_compatible_audio_transcriptions', requested_format),
        'dashscope_paraformer': ('aliyun_paraformer', 'sentences_json'),
        'dashscope_qwen': ('aliyun_qwen_asr', 'chat_completion_json'),
        'volcengine_flash': ('volcengine_flash', 'utterances_json'),
        'tencent_rec_task': ('tencent_rec_task', 'result_detail_json'),
    }[protocol]
    if protocol == 'dashscope_qwen':
        warnings.append('Qwen兼容模式仅返回识别正文；无真实分段时间戳，不生成时间轴。Base64编码后音频上限10MB。')
    if protocol == 'openai' and requested_format == 'provider_default':
        warnings.append('使用服务默认转写格式；不发送语言或时间戳参数，可能仅返回无时间戳正文。')
    return dict(scheme=scheme, host=host, port=port, loopback=loopback, path=path, api_key=api_key,
                protocol=protocol, requested_protocol=requested_protocol, provider_name=provider_name,
                model=model, language=language, timeout=timeout, max_bytes=maximum,
                engine=engine, response_format=actual_format,
                timestamps_capability='optional' if protocol in ('openai', 'dashscope_qwen') else 'required',
                language_parameter_sent=(language != 'auto' and (protocol in ('dashscope_qwen', 'dashscope_paraformer')
                                          or protocol == 'openai' and requested_format != 'provider_default')),
                proxy=proxy, warnings=warnings, **fields)


def validate_cloud_config(config):
    """Offline preflight to run before downloading any source audio.

    Returns non-secret status only; reads no files, DNS or environment.
    Missing upload_consent is an error, not a default authorization.
    """
    try:
        private = _validated(config)
        result = dict(configured=True, upload_consent=True, has_api_key=bool(private['api_key']),
                      model=private['model'], language=private['language'], timeout=private['timeout'],
                      max_bytes=private['max_bytes'], engine=private['engine'],
                      response_format=private['response_format'], protocol=private['protocol'],
                      provider_name=private['provider_name'],
                      timestamps_capability=private['timestamps_capability'],
                      language_parameter_sent=private['language_parameter_sent'],
                      warnings=list(private['warnings']))
        _no_secret(result, private['api_key'])
        if private['protocol'] == 'tencent_rec_task':
            _no_secret(result, private['app_id'])  # Tencent SecretId is private too.
        return result
    except CloudASRError:
        raise
    except Exception:
        _fail('invalid_config')


def _check_audio_identity(audio, path, identity):
    """Reject changed/replaced files, including the named path after opening."""
    try:
        current, named = os.fstat(audio.fileno()), path.stat(follow_symlinks=False)
        if (path.is_symlink() or not stat.S_ISREG(current.st_mode)
                or any(getattr(obj, field) != getattr(identity, field)
                       for obj in (current, named)
                       for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns'))):
            _fail('audio_invalid')
    except OSError:
        _fail('audio_invalid')


def _private_audio(audio_path, config):
    """Stat consented audio only; no network or content reads."""
    path = Path(audio_path)
    extension = path.suffix.lower().lstrip('.')
    try:
        if path.is_symlink() or extension not in ('m4a', 'mp4', 'mp3', 'wav', 'webm', 'ogg', 'opus', 'flac', 'aac'):
            _fail('audio_invalid')
        identity = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(identity.st_mode) or identity.st_size <= 0:
            _fail('audio_invalid')
        if identity.st_size > config['max_bytes']:
            _fail('size_limit')
    except OSError:
        _fail('audio_invalid')
    return path, extension, identity


def _open_audio(path, identity):
    try:
        audio = path.open('rb')
    except OSError:
        _fail('audio_invalid')
    try:
        _check_audio_identity(audio, path, identity)
    except BaseException:
        audio.close()
        raise
    return audio


class _Budget:
    def __init__(self, timeout):
        self.end = time.monotonic() + timeout

    def remaining(self):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            _fail('timeout')
        return remaining

    def socket_timeout(self):
        return min(30, self.remaining())


def _socket_budget(connection, budget, response=None):
    remaining = budget.socket_timeout()
    connection.timeout = remaining
    sock = getattr(connection, 'sock', None)
    if sock is None and response is not None:
        sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
    if sock is not None:
        sock.settimeout(remaining)


def _connect(config, budget):
    if config['scheme'] == 'https':
        context = ssl.create_default_context()
        if config['proxy'] is not None:
            proxy_host, proxy_port = config['proxy']
            connection = http.client.HTTPSConnection(proxy_host, proxy_port,
                                                     timeout=budget.socket_timeout(), context=context)
            # Plaintext CONNECT to the explicit HTTP proxy, then TLS to the origin.
            connection.set_tunnel(config['host'], config['port'], headers={})
        else:
            connection = http.client.HTTPSConnection(config['host'], config['port'],
                                                     timeout=budget.socket_timeout(), context=context)
    else:
        connection = http.client.HTTPConnection(config['host'], config['port'], timeout=budget.socket_timeout())
    return connection


def _multipart(config, extension):
    boundary = 'dsh-audio-' + secrets.token_hex(16)
    fields = [('model', config['model'])]
    if config['response_format'] != 'provider_default':
        fields.append(('response_format', config['response_format']))
        if config['response_format'] == 'verbose_json':
            fields.append(('timestamp_granularities[]', 'segment'))
        if config['language'] != 'auto':
            fields.append(('language', config['language']))
    parts = []
    for name, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8'))
    mime = {'m4a': 'audio/mp4', 'mp4': 'audio/mp4', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
            'webm': 'audio/webm', 'ogg': 'audio/ogg', 'opus': 'audio/ogg',
            'flac': 'audio/flac', 'aac': 'audio/aac'}[extension]
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.{extension}"\r\nContent-Type: {mime}\r\n\r\n'.encode('ascii'))
    prefix = b''.join(parts)
    suffix = f'\r\n--{boundary}--\r\n'.encode('ascii')
    return boundary, prefix, suffix


def _status(status):
    if 300 <= status < 400:
        _fail('redirect_rejected')
    if status == 401:
        _fail('authentication_failed')
    if status == 403:
        _fail('access_denied')
    if status == 429:
        _fail('rate_limited')
    if status == 413:
        _fail('request_too_large')
    if status != 200:
        _fail('provider_error')


def _read_response(response, connection, budget):
    maximum = MAX_RESPONSE_BYTES
    length = response.getheader('Content-Length')
    if length is not None:
        try:
            length = int(length)
        except (ValueError, TypeError):
            _fail('invalid_response')
        if length < 0:
            _fail('invalid_response')
        if length > maximum:
            _fail('response_too_large')
    encoding = response.getheader('Content-Encoding', 'identity').lower()
    if encoding not in ('identity', ''):
        _fail('invalid_response')
    mime = response.getheader('Content-Type', '').lower().split(';')[0].strip()
    if mime and mime != 'application/json' and not mime.endswith('+json'):
        _fail('invalid_response')
    chunks, total = [], 0
    reader = getattr(response, 'read1', response.read)
    while True:
        _socket_budget(connection, budget, response)
        chunk = reader(min(CHUNK_BYTES, maximum - total + 1))
        budget.remaining()
        if not chunk:
            break
        total += len(chunk)
        if total > maximum:
            _fail('response_too_large')
        chunks.append(chunk)
    if total == 0 or length is not None and total != length:
        _fail('invalid_response')
    return b''.join(chunks)


def _reject_constant(value):
    raise ValueError()


def _language_response(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*', value):
        _fail('invalid_response')
    value = value.lower().replace('_', '-')
    return {'english': 'en', 'chinese': 'zh'}.get(value, value)


def _text_result(text, config, *, response_format='text_json', language=None, duration=None):
    if not isinstance(text, str) or not text.strip():
        _fail('invalid_response')
    result = dict(text_only=True, text=text.strip(), segments=[],
                  info=dict(duration=duration, language=language),
                  provider_model=config['model'], response_format=response_format,
                  engine=config['engine'], warnings=list(config['warnings']) + [
                      '服务仅返回识别正文，无真实分段时间戳；不会推断时间或生成字幕时间轴。'])
    return _no_secret(result, config['api_key'])


def _parse_response(raw, config):
    try:
        payload = json.loads(raw.decode('utf-8-sig'), parse_constant=_reject_constant)
    except (ValueError, UnicodeError):
        _fail('invalid_response')
    if not isinstance(payload, dict):
        _fail('invalid_response')
    _no_secret(payload, config['api_key'])
    segments = payload.get('segments')
    if segments is None or segments == []:
        # Text-only is a genuine provider capability, not a zero-duration segment.
        if isinstance(payload.get('text'), str) and payload['text'].strip():
            language = _language_response(payload.get('language'))
            if language is not None and config['language'] != 'auto' and language != config['language'] and not language.startswith(config['language'] + '-'):
                _fail('language_mismatch')
            duration = payload.get('duration')
            if duration is not None:
                duration = _numeric(duration, 'invalid_timestamps', positive=True)
                if duration * 1000 > MAX_TIMESTAMP_MS:
                    _fail('invalid_timestamps')
            return _text_result(payload['text'], config, language=language, duration=duration)
        _fail('unsupported_timestamp')
    if not isinstance(segments, list):
        _fail('invalid_response')
    if len(segments) > MAX_SEGMENTS:
        _fail('response_too_large')
    duration = payload.get('duration')
    if duration is not None:
        duration = _numeric(duration, 'invalid_timestamps', positive=True)
        if duration * 1000 > MAX_TIMESTAMP_MS:
            _fail('invalid_timestamps')
    output, previous_end = [], 0
    for segment in segments:
        if not isinstance(segment, dict):
            _fail('invalid_timestamps')
        start = _numeric(segment.get('start'), 'invalid_timestamps')
        end = _numeric(segment.get('end'), 'invalid_timestamps')
        if end <= start or end * 1000 > MAX_TIMESTAMP_MS:
            _fail('invalid_timestamps')
        start_ms, end_ms = round(start * 1000), round(end * 1000)
        if end_ms <= start_ms or start_ms < previous_end:
            _fail('invalid_timestamps')
        if duration is not None and end_ms > round(duration * 1000) + 1:
            _fail('invalid_timestamps')
        text = segment.get('text')
        if not isinstance(text, str) or not text.strip():
            _fail('invalid_response')
        output.append(dict(start=start_ms / 1000, end=end_ms / 1000, text=text.strip()))
        previous_end = end_ms
    language = _language_response(payload.get('language'))
    if language is not None and config['language'] != 'auto':
        want = config['language']
        if language != want and not language.startswith(want + '-'):
            _fail('language_mismatch')
    result = dict(segments=output, info=dict(duration=duration, language=language),
                  provider_model=config['model'], response_format='verbose_json',
                  engine=config['engine'],
                  warnings=list(config['warnings']))
    return _no_secret(result, config['api_key'])


def transcribe_cloud(audio_path, *, endpoint, api_key, model, language,
                     upload_consent=False, timeout=900, max_bytes=DEFAULT_MAX_BYTES,
                     allow_insecure_loopback=False, proxy=None, protocol='auto',
                     provider_name='', app_id='', region='', resource_id='',
                     response_format='verbose_json'):
    """Upload one consented audio file; retain real timestamps or honest text-only.

    Runs the same offline preflight before file access. File, multipart body and
    response are bounded; compatible multipart audio streams in 64KiB chunks.
    Protocol adapters may use bounded Base64 buffers; no audio cache or rewrite.
    Network operations share one monotonic deadline.
    """
    connection = None
    try:
        config = _validated(dict(endpoint=endpoint, api_key=api_key, model=model, language=language,
                                 upload_consent=upload_consent, timeout=timeout, max_bytes=max_bytes,
                                 allow_insecure_loopback=allow_insecure_loopback, proxy=proxy,
                                 protocol=protocol, provider_name=provider_name, app_id=app_id,
                                 region=region, resource_id=resource_id, response_format=response_format))
        # Offline preflight intentionally permits absent keys: the runner reads an
        # explicitly configured KeyFile only after that check. Execution does not.
        if config['protocol'] in ('volcengine_flash', 'tencent_rec_task') and not config['api_key']:
            _fail('invalid_api_key')
        if config['protocol'] != 'openai':
            # Fixed sibling dispatch only; validation never loads adapters/SDKs.
            import importlib.util
            module = {'dashscope_paraformer': 'aliyun_asr', 'dashscope_qwen': 'qwen_asr',
                      'volcengine_flash': 'volcengine_asr', 'tencent_rec_task': 'tencent_asr'}[config['protocol']]
            spec = importlib.util.spec_from_file_location('_dsh_' + module, Path(__file__).with_name(module + '.py'))
            adapter = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(adapter)
            return adapter.transcribe(audio_path, config, globals())
        budget = _Budget(config['timeout'])
        path = Path(audio_path)
        extension = path.suffix.lower().lstrip('.')
        if path.is_symlink() or not path.is_file() or extension not in ('m4a', 'mp4', 'mp3', 'wav', 'webm', 'ogg', 'opus', 'flac', 'aac'):
            _fail('audio_invalid')
        try:
            initial = path.stat(follow_symlinks=False)
            audio = path.open('rb')
        except OSError:
            _fail('audio_invalid')
        with audio:
            identity = os.fstat(audio.fileno())
            if (not stat.S_ISREG(identity.st_mode) or identity.st_size <= 0 or path.is_symlink()
                    or identity.st_dev != initial.st_dev or identity.st_ino != initial.st_ino
                    or identity.st_size != initial.st_size or identity.st_mtime_ns != initial.st_mtime_ns):
                _fail('audio_invalid')
            size = identity.st_size
            if size > config['max_bytes']:
                _fail('size_limit')
            boundary, prefix, suffix = _multipart(config, extension)
            body_length = len(prefix) + size + len(suffix)
            if len(prefix) + len(suffix) > 81920 or body_length > config['max_bytes'] + 81920:
                _fail('size_limit')
            connection = _connect(config, budget)
            _socket_budget(connection, budget)
            connection.putrequest('POST', config['path'], skip_accept_encoding=True)
            connection.putheader('Content-Type', 'multipart/form-data; boundary=' + boundary)
            connection.putheader('Content-Length', str(body_length))
            connection.putheader('Accept', 'application/json')
            connection.putheader('Accept-Encoding', 'identity')
            connection.putheader('Connection', 'close')
            if config['api_key']:
                connection.putheader('Authorization', 'Bearer ' + config['api_key'])
            connection.endheaders()
            _socket_budget(connection, budget)
            connection.send(prefix)
            sent = 0
            while sent < size:
                budget.remaining()
                chunk = audio.read(min(CHUNK_BYTES, size - sent))
                if not chunk:
                    _fail('audio_invalid')
                _socket_budget(connection, budget)
                connection.send(chunk)
                budget.remaining()
                sent += len(chunk)
            final = os.fstat(audio.fileno())
            if (audio.read(1) or final.st_size != size or final.st_mtime_ns != identity.st_mtime_ns
                    or final.st_ino != identity.st_ino):
                _fail('audio_invalid')
            _socket_budget(connection, budget)
            connection.send(suffix)
            _socket_budget(connection, budget)
            response = connection.getresponse()
            budget.remaining()
            _status(response.status)  # Never read, log, or surface error bodies.
            raw = _read_response(response, connection, budget)
            result = _parse_response(raw, config)
            budget.remaining()
            return result
    except CloudASRError:
        raise
    except TimeoutError:
        _fail('timeout')
    except (OSError, http.client.HTTPException):
        _fail('network_error')
    except Exception:
        _fail('invalid_config')
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
