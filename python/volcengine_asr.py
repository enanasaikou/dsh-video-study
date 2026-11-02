"""Volcengine flash ASR, stdlib only, one consented inline-data request.

Contract reference (read-only, no live-key acceptance performed):
https://docs.volcengine.com/docs/doubao-voice/large-model-recording-file-lite-recognition-api?lang=en
https://docs.volcengine.com/docs/doubao-voice/result-query-http-1?lang=en
Legacy console credentials: app_id=AppID, api_key=AccessToken. This adapter
intentionally does not guess/fallback to the new single X-Api-Key credential.
The service limit is 100MB / 2h; bytes are checked locally, duration by service.
"""
import base64
import json
from types import SimpleNamespace
import uuid

MAX_AUDIO_BYTES = 100_000_000  # Conservative decimal MB; independent of user limit.
MAX_AUDIO_DURATION_MS = 2 * 60 * 60 * 1000


def _shared(shared):
    return SimpleNamespace(**shared) if isinstance(shared, dict) else shared


def _field(config, name, shared, limit=2048):
    """Header-safe identifier; limits match cloud_asr preflight, never tighter."""
    value = config.get(name)
    if (not isinstance(value, str) or not value or len(value) > limit
            or any(ord(ch) < 33 or ord(ch) > 126 for ch in value)):
        shared._fail('invalid_config')
    return value


def _read_audio(audio_path, config, shared, budget):
    path, extension, identity = shared._private_audio(audio_path, config)
    if extension not in ('wav', 'mp3', 'ogg', 'opus'):
        shared._fail('audio_invalid')
    if identity.st_size > MAX_AUDIO_BYTES:
        shared._fail('size_limit')
    chunks, size = [], 0
    with shared._open_audio(path, identity) as audio:
        while True:
            budget.remaining()
            try:
                chunk = audio.read(min(shared.CHUNK_BYTES, identity.st_size - size + 1))
            except OSError:
                shared._fail('audio_invalid')
            budget.remaining()
            if not chunk:
                break
            size += len(chunk)
            if size > identity.st_size:
                shared._fail('audio_invalid')
            chunks.append(chunk)
        shared._check_audio_identity(audio, path, identity)
        if size != identity.st_size:
            shared._fail('audio_invalid')
    return base64.b64encode(b''.join(chunks)).decode('ascii')


def _request(body, config, shared, budget):
    connection = None
    try:
        budget.remaining()
        connection = shared._connect(config, budget)
        shared._socket_budget(connection, budget)
        connection.putrequest('POST', config['path'], skip_accept_encoding=True)
        headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json', 'Accept-Encoding': 'identity',
            'Connection': 'close', 'Content-Length': str(len(body)),
            'X-Api-App-Key': config['app_id'],
            'X-Api-Access-Key': config['api_key'],
            'X-Api-Resource-Id': config['resource_id'],
            'X-Api-Request-Id': str(uuid.uuid4()), 'X-Api-Sequence': '-1',
        }
        for name, value in headers.items():
            connection.putheader(name, value)
        shared._socket_budget(connection, budget)
        connection.endheaders()
        for index in range(0, len(body), shared.CHUNK_BYTES):
            shared._socket_budget(connection, budget)
            connection.send(body[index:index + shared.CHUNK_BYTES])
            budget.remaining()
        shared._socket_budget(connection, budget)
        response = connection.getresponse()
        budget.remaining()
        shared._status(response.status)
        # Never print/return the remote message, log ID, or response headers.
        code = response.getheader('X-Api-Status-Code')
        if code != '20000000':
            if code in ('45000002', '45000151'):
                shared._fail('audio_invalid')
            if code == '55000031':
                shared._fail('rate_limited')
            shared._fail('provider_error' if code is not None else 'invalid_response')
        raw = shared._read_response(response, connection, budget)
        try:
            payload = json.loads(raw.decode('utf-8-sig'), parse_constant=shared._reject_constant)
        except (ValueError, UnicodeError):
            shared._fail('invalid_response')
        shared._no_secret(payload, config['api_key'])
        shared._no_secret(payload, config['app_id'])
        return payload
    finally:
        if connection is not None:
            connection.close()


def _milliseconds(value, shared):
    if type(value) is not int or value < 0 or value > shared.MAX_TIMESTAMP_MS:
        shared._fail('invalid_timestamps')
    return value


def _parse(payload, config, shared):
    if not isinstance(payload, dict) or not isinstance(payload.get('result'), dict):
        shared._fail('invalid_response')
    utterances = payload['result'].get('utterances')
    if not isinstance(utterances, list) or not utterances:
        shared._fail('unsupported_timestamp')
    if len(utterances) > shared.MAX_SEGMENTS:
        shared._fail('response_too_large')
    duration = None
    audio_info = payload.get('audio_info')
    if audio_info is not None:
        if not isinstance(audio_info, dict):
            shared._fail('invalid_response')
        if 'duration' in audio_info:
            duration = _milliseconds(audio_info['duration'], shared)
            if duration <= 0 or duration > MAX_AUDIO_DURATION_MS:
                shared._fail('invalid_timestamps')
    output, previous_end = [], 0
    for item in utterances:
        if not isinstance(item, dict):
            shared._fail('invalid_timestamps')
        start = _milliseconds(item.get('start_time'), shared)
        end = _milliseconds(item.get('end_time'), shared)
        if (end <= start or start < previous_end or end > MAX_AUDIO_DURATION_MS
                or duration is not None and end > duration):
            shared._fail('invalid_timestamps')
        text = item.get('text')
        if not isinstance(text, str) or not text.strip():
            shared._fail('invalid_response')
        output.append(dict(start=start / 1000, end=end / 1000, text=text.strip()))
        previous_end = end
    result = dict(segments=output, info=dict(duration=None if duration is None else duration / 1000,
                                           language=None),
                  provider_model=config['model'], engine='volcengine_flash',
                  response_format='utterances_json', warnings=list(config.get('warnings', [])))
    shared._no_secret(result, config['api_key'])
    return shared._no_secret(result, config['app_id'])


def transcribe(audio_path, config, shared):
    """Use validated private config and shared cloud_asr firewall helpers only.

    No URL audio, redirects, retries, downloads, environment credentials or SDK.
    A caller choosing a custom HTTPS origin explicitly controls that one origin.
    """
    shared = _shared(shared)
    try:
        if config.get('scheme') != 'https':
            shared._fail('insecure_endpoint')
        for name in ('app_id', 'resource_id'):
            _field(config, name, shared)
        _field(config, 'api_key', shared, 8192)
        # model is an opaque JSON value already validated by cloud_asr: Unicode,
        # spaces and up to 64KiB UTF-8 are valid, unlike HTTP credential headers.
        budget = shared._Budget(config['timeout'])
        data = _read_audio(audio_path, config, shared, budget)
        request = {'user': {'uid': config['app_id']}, 'audio': {'data': data},
                   'request': {'model_name': config['model'], 'show_utterances': True}}
        body = json.dumps(request, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        budget.remaining()
        result = _parse(_request(body, config, shared, budget), config, shared)
        budget.remaining()
        return result
    except shared.CloudASRError:
        raise
    except TimeoutError:
        shared._fail('timeout')
    except (OSError, shared.http.client.HTTPException):
        shared._fail('network_error')
    except Exception:
        shared._fail('invalid_response')
