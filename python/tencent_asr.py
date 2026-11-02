"""Tencent CreateRecTask/DescribeTaskStatus with inline audio and TC3 signing.

Official contracts (read-only; not live-key/provider acceptance):
https://cloud.tencent.com/document/api/1093/37823
https://cloud.tencent.com/document/api/1093/37822
https://cloud.tencent.com/document/api/1093/37824
https://cloud.tencent.com/document/api/1093/35641
Data is locally capped at decimal 5MB (conservative official 5MB limit).
No hosted-audio requirement, paid enrichment, task resubmission or URL fetching.
"""
import base64
import datetime
import hashlib
import hmac
import json
import math
import time
from types import SimpleNamespace

MAX_AUDIO_BYTES = 5_000_000
POLL_SECONDS = 1.0
# These documented engines only support ResTextFormat=0, not sentence timing.
UNTIMED_MODELS = frozenset('16k_' + name for name in (
    'multi_lang', 'ja', 'ko', 'vi', 'ms', 'id', 'fil', 'th', 'pt', 'tr',
    'ar', 'es', 'hi', 'fr', 'zh_medical', 'de'))
CONTENT_TYPE = 'application/json; charset=utf-8'


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
    if extension not in ('wav', 'mp3', 'm4a', 'mp4', 'aac', 'ogg', 'opus', 'flac'):
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
    return base64.b64encode(b''.join(chunks)).decode('ascii'), size


def _sign(config, body, action, timestamp):
    """Sign exactly the bytes, Host authority and URI actually sent (UTC date)."""
    host = config['host']
    if ':' in host and not host.startswith('['):
        host = '[' + host + ']'
    if config['port'] != 443:
        host += ':' + str(config['port'])
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y-%m-%d')
    signed_headers = 'content-type;host;x-tc-action'
    canonical_headers = ('content-type:' + CONTENT_TYPE + '\nhost:' + host.lower()
                         + '\nx-tc-action:' + action.lower() + '\n')
    canonical = ('POST\n' + config['path'] + '\n\n' + canonical_headers + '\n'
                 + signed_headers + '\n' + hashlib.sha256(body).hexdigest())
    scope = date + '/asr/tc3_request'
    to_sign = ('TC3-HMAC-SHA256\n' + str(timestamp) + '\n' + scope + '\n'
               + hashlib.sha256(canonical.encode('utf-8')).hexdigest())
    def mac(key, value):
        return hmac.new(key, value.encode('utf-8'), hashlib.sha256).digest()
    date_key = mac(('TC3' + config['api_key']).encode('utf-8'), date)
    service_key = mac(date_key, 'asr')
    signing_key = mac(service_key, 'tc3_request')
    signature = hmac.new(signing_key, to_sign.encode('utf-8'), hashlib.sha256).hexdigest()
    authorization = ('TC3-HMAC-SHA256 Credential=' + config['app_id'] + '/' + scope
                     + ', SignedHeaders=' + signed_headers + ', Signature=' + signature)
    return host, authorization


class _Session:
    def __init__(self, config, shared, budget):
        self.config, self.shared, self.budget = config, shared, budget
        self.response_bytes = 0

    def request(self, action, payload):
        config, shared, budget = self.config, self.shared, self.budget
        body = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        budget.remaining()
        timestamp = int(time.time())
        host, authorization = _sign(config, body, action, timestamp)
        connection = None
        try:
            connection = shared._connect(config, budget)
            shared._socket_budget(connection, budget)
            # Explicit Host avoids http.client's different IPv6/default-port rendering.
            connection.putrequest('POST', config['path'], skip_accept_encoding=True, skip_host=True)
            headers = {'Host': host, 'Authorization': authorization,
                       'Content-Type': CONTENT_TYPE, 'Content-Length': str(len(body)),
                       'Accept': 'application/json', 'Accept-Encoding': 'identity',
                       'Connection': 'close', 'X-TC-Action': action,
                       'X-TC-Version': '2019-06-14', 'X-TC-Timestamp': str(timestamp)}
            if config.get('region'):
                headers['X-TC-Region'] = config['region']
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
            raw = shared._read_response(response, connection, budget)
            self.response_bytes += len(raw)
            if self.response_bytes > shared.MAX_RESPONSE_BYTES:
                shared._fail('response_too_large')
            try:
                result = json.loads(raw.decode('utf-8-sig'), parse_constant=shared._reject_constant)
            except (ValueError, UnicodeError):
                shared._fail('invalid_response')
            shared._no_secret(result, config['api_key'])
            shared._no_secret(result, config['app_id'])
            if not isinstance(result, dict) or not isinstance(result.get('Response'), dict):
                shared._fail('invalid_response')
            response = result['Response']
            if 'Error' in response:
                error = response['Error']
                code = error.get('Code') if isinstance(error, dict) else None
                if isinstance(code, str) and code.startswith('AuthFailure'):
                    shared._fail('authentication_failed')
                if isinstance(code, str) and code.startswith('RequestLimitExceeded'):
                    shared._fail('rate_limited')
                shared._fail('provider_error')
            data = response.get('Data')
            if not isinstance(data, dict):
                shared._fail('invalid_response')
            return data
        finally:
            if connection is not None:
                connection.close()


def _task_id(value, shared):
    if type(value) is not int or not 0 < value <= 2 ** 64 - 1:
        shared._fail('invalid_response')
    return value


def _parse(data, config, shared):
    details = data.get('ResultDetail')
    if not isinstance(details, list) or not details:
        shared._fail('unsupported_timestamp')
    if len(details) > shared.MAX_SEGMENTS:
        shared._fail('response_too_large')
    duration = data.get('AudioDuration')
    if duration is not None:
        duration = shared._numeric(duration, 'invalid_timestamps', positive=True)
        if duration * 1000 > shared.MAX_TIMESTAMP_MS:
            shared._fail('invalid_timestamps')
    output, previous_end = [], 0
    for item in details:
        if not isinstance(item, dict):
            shared._fail('invalid_timestamps')
        start, end = item.get('StartMs'), item.get('EndMs')
        if (type(start) is not int or type(end) is not int or start < previous_end
                or end <= start or end > shared.MAX_TIMESTAMP_MS
                or duration is not None and end > round(duration * 1000) + 1):
            shared._fail('invalid_timestamps')
        text = item.get('FinalSentence')
        if not isinstance(text, str) or not text.strip():
            shared._fail('invalid_response')
        output.append(dict(start=start / 1000, end=end / 1000, text=text.strip()))
        previous_end = end
    result = dict(segments=output, info=dict(duration=duration, language=None),
                  provider_model=config['model'], engine='tencent_rec_task',
                  response_format='result_detail_json', warnings=list(config.get('warnings', [])))
    shared._no_secret(result, config['api_key'])
    return shared._no_secret(result, config['app_id'])


def transcribe(audio_path, config, shared):
    """Submit at most once, then poll the exact same configured HTTPS endpoint.

    The shared deadline includes reads, signing/upload, sleeps, polls and result
    parsing. Local timeout does not cancel/delete the already-submitted cloud job.
    """
    shared = _shared(shared)
    try:
        if config.get('scheme') != 'https':
            shared._fail('insecure_endpoint')
        _field(config, 'api_key', shared, 8192)
        _field(config, 'app_id', shared)
        # cloud_asr already validated the opaque JSON model (Unicode/spaces and
        # up to 64KiB UTF-8); do not apply HTTP-header credential rules to it.
        if config.get('region'):
            _field(config, 'region', shared)
        if config['model'] in UNTIMED_MODELS:
            shared._fail('unsupported_timestamp')
        budget = shared._Budget(config['timeout'])
        data, length = _read_audio(audio_path, config, shared, budget)
        session = _Session(config, shared, budget)
        created = session.request('CreateRecTask', {
            'EngineModelType': config['model'], 'ChannelNum': 1, 'ResTextFormat': 3,
            'SourceType': 1, 'Data': data, 'DataLen': length})
        task_id = _task_id(created.get('TaskId'), shared)
        # Derive the frozen-clock safety guard from the user's whole deadline;
        # a fixed cap would silently truncate longer legitimate timeout budgets.
        maximum_polls = math.ceil(config['timeout'] / POLL_SECONDS) + 1
        for _ in range(maximum_polls):
            budget.remaining()
            status = session.request('DescribeTaskStatus', {'TaskId': task_id})
            if _task_id(status.get('TaskId'), shared) != task_id:
                shared._fail('invalid_response')
            state = status.get('Status')
            if type(state) is not int or state not in (0, 1, 2, 3):
                shared._fail('invalid_response')
            if state == 2:
                result = _parse(status, config, shared)
                budget.remaining()
                return result
            if state == 3:
                shared._fail('task_failed')
            time.sleep(min(POLL_SECONDS, budget.remaining()))
            budget.remaining()
        shared._fail('timeout')
    except shared.CloudASRError:
        raise
    except TimeoutError:
        shared._fail('timeout')
    except (OSError, shared.http.client.HTTPException):
        shared._fail('network_error')
    except Exception:
        shared._fail('invalid_response')
