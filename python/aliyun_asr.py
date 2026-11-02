"""Bounded, no-retry DashScope Paraformer-v2 adapter (standard library only).

Only cloud_asr dispatches here, after explicit consent and offline validation.
All HTTP connections, response bounds and monotonic deadlines reuse that module.
No URLs, policy credentials, task IDs or raw provider responses are persisted.
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import stat
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, quote, unquote, urlsplit

POLL_SECONDS = 2
NATIVE_PATH = '/api/v1/services/audio/asr/transcription'


_OSS_REGION = re.compile(r'\.oss-([a-z0-9-]{2,32})\.aliyuncs\.com$')


def _host_region(host):
    matched = _OSS_REGION.search(host or '')
    return matched.group(1) if matched else None


def _storage_url(value, region, c, *, upload=False, allow_http=False):
    """Allow only Alibaba OSS endpoints; no URL parser ambiguities.

    A None region accepts any DashScope OSS region and reports the detected one,
    so an explicitly configured compatible gateway still resolves the storage
    its own authenticated policy response names. Encoded colons (used in
    official result paths) are supported, but encoded slashes/dots, nested
    encoding, credentials, ports, redirects and arbitrary query keys are not.
    Never return this private URL to the caller.
    """
    if (not isinstance(value, str) or not value or len(value) > 16384
            or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in value)
            or '\\' in value or '#' in value or value.endswith('?')
            or re.search(r'%(?![0-9A-Fa-f]{2})', value)):
        c._fail('unsafe_provider_url')
    try:
        p = urlsplit(value)
        host = p.hostname
        region_pattern = re.escape(region) if region else r'[a-z0-9-]{2,32}'
        allowed = re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.oss-'
                               + region_pattern + r'\.aliyuncs\.com', host or '')
        if (p.scheme not in (('https', 'http') if allow_http else ('https',))
                or not allowed or p.netloc != host
                or p.username is not None or p.password is not None or p.port is not None
                or p.fragment):
            c._fail('unsafe_provider_url')
        if upload:
            if p.path not in ('', '/') or p.query:
                c._fail('unsafe_provider_url')
            return dict(scheme=p.scheme, host=host, port=443, path='/', loopback=False,
                        region=_host_region(host))
        if not p.path.startswith('/') or p.path.startswith('//'):
            c._fail('unsafe_provider_url')
        for part in p.path[1:].split('/'):
            decoded = unquote(part, errors='strict')
            if (not decoded or decoded in ('.', '..') or any(ch in decoded for ch in '/\\%?#')
                    or any(ord(ch) <= 32 or ord(ch) == 127 for ch in decoded)):
                c._fail('unsafe_provider_url')
        if not p.path.endswith('.json'):
            c._fail('unsafe_provider_url')
        pairs = parse_qsl(p.query, keep_blank_values=True, strict_parsing=True, max_num_fields=12)
        allowed_keys = {'Expires', 'OSSAccessKeyId', 'Signature', 'security-token',
                        'x-oss-security-token', 'x-oss-signature-version', 'x-oss-credential',
                        'x-oss-date', 'x-oss-expires', 'x-oss-signature', 'x-oss-additional-headers'}
        fields = dict(pairs)
        if (len(fields) != len(pairs) or not pairs or set(fields) - allowed_keys
                or any(not v or len(v) > 8192 or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in v)
                       or '\\' in v or '#' in v or '%' in v for v in fields.values())):
            c._fail('unsafe_provider_url')
        v1 = {'Expires', 'OSSAccessKeyId', 'Signature'}
        v4 = {'x-oss-signature-version', 'x-oss-credential', 'x-oss-date', 'x-oss-expires', 'x-oss-signature'}
        if not (v1 <= fields.keys() and fields['Expires'].isdigit()
                or v4 <= fields.keys() and fields['x-oss-expires'].isdigit()):
            c._fail('unsafe_provider_url')
        return dict(scheme=p.scheme, host=host, port=443,
                    path=p.path + '?' + p.query, loopback=False, region=_host_region(host))
    except (ValueError, UnicodeError):
        c._fail('unsafe_provider_url')


class _Session:
    def __init__(self, config, shared):
        self.c = SimpleNamespace(**shared)
        self.config = config
        self.budget = self.c._Budget(config['timeout'])
        self.response_bytes = 0
        self.private = [config['api_key']]
        self.filetrans = 'filetrans' in str(config['model']).lower()
        self.result_http = False

    def json(self, raw):
        c = self.c
        self.response_bytes += len(raw)
        if self.response_bytes > c.MAX_RESPONSE_BYTES:
            c._fail('response_too_large')
        try:
            obj = json.loads(raw.decode('utf-8-sig'), parse_constant=c._reject_constant)
        except (ValueError, UnicodeError):
            c._fail('invalid_response')
        if not isinstance(obj, dict):
            c._fail('invalid_response')
        c._no_secret(obj, self.config['api_key'])
        self.budget.remaining()
        return obj

    def request(self, target, method, *, body=None, headers=None, upload=None, api_auth=False):
        """Only explicit API-role requests to the original origin may use the key.

        OSS upload/result roles never inherit main credentials, even when a
        custom API endpoint intentionally has the same origin as that OSS URL.
        """
        c, budget = self.c, self.budget
        origin = dict(target, proxy=self.config['proxy'])
        api = api_auth is True and all(target[k] == self.config[k] for k in ('scheme', 'host', 'port'))
        connection = c._connect(origin, budget)
        try:
            c._socket_budget(connection, budget)
            connection.putrequest(method, target['path'], skip_accept_encoding=True)
            connection.putheader('Accept', 'application/json')
            connection.putheader('Accept-Encoding', 'identity')
            connection.putheader('Connection', 'close')
            if api and self.config['api_key']:
                connection.putheader('Authorization', 'Bearer ' + self.config['api_key'])
            for name, value in (headers or {}).items():
                connection.putheader(name, value)
            if body is not None:
                connection.putheader('Content-Length', str(len(body)))
            elif upload is not None:
                connection.putheader('Content-Length', str(upload['length']))
            connection.endheaders()
            if body is not None:
                c._socket_budget(connection, budget)
                connection.send(body)
                budget.remaining()
            if upload is not None:
                self.send_audio(connection, upload)
            c._socket_budget(connection, budget)
            response = connection.getresponse()
            budget.remaining()
            c._status(response.status)  # Never read or surface any error body.
            if upload is not None:
                return None  # OSS success body is irrelevant, never read/log it.
            raw = c._read_response(response, connection, budget)
            return self.json(raw)
        finally:
            try:
                connection.close()
            except Exception:
                pass

    def send_audio(self, connection, upload):
        c, budget = self.c, self.budget
        audio, size, identity, path = (upload[k] for k in ('audio', 'size', 'identity', 'path'))
        self.identity(audio, path, identity)
        c._socket_budget(connection, budget)
        connection.send(upload['prefix'])
        sent = 0
        while sent < size:
            budget.remaining()
            chunk = audio.read(min(c.CHUNK_BYTES, size - sent))
            if not chunk:
                c._fail('audio_invalid')
            c._socket_budget(connection, budget)
            connection.send(chunk)
            sent += len(chunk)
            budget.remaining()
        self.identity(audio, path, identity)
        if audio.read(1):
            c._fail('audio_invalid')
        c._socket_budget(connection, budget)
        connection.send(upload['suffix'])
        budget.remaining()

    def identity(self, audio, path, expected):
        c = self.c
        try:
            current, named = os.fstat(audio.fileno()), path.stat(follow_symlinks=False)
            if (path.is_symlink() or not stat.S_ISREG(current.st_mode)
                    or any(getattr(obj, k) != getattr(expected, k)
                           for obj in (current, named)
                           for k in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns'))):
                c._fail('audio_invalid')
        except OSError:
            c._fail('audio_invalid')

    def policy_upload(self, audio, path, identity, extension, region):
        c = self.c
        policy = self.request(dict(self.config, path='/api/v1/uploads?action=getPolicy&model='
                                   + quote(self.config['model'], safe='')), 'GET', api_auth=True)
        data = policy.get('data')
        if not isinstance(data, dict):
            c._fail('invalid_response')
        target = _storage_url(data.get('upload_host'), region, c, upload=True)
        directory = data.get('upload_dir')
        if (not isinstance(directory, str) or len(directory) > 2048
                or not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9._-]+)*', directory)
                or any(p in ('.', '..') for p in directory.split('/'))):
            c._fail('invalid_response')
        # Never send an untrusted local filename or reuse an object name.
        filename = 'audio-' + secrets.token_hex(16) + '.' + extension
        key = directory + '/' + filename
        boundary = 'dsh-oss-' + secrets.token_hex(16)
        fields = []
        names = [('OSSAccessKeyId', 'oss_access_key_id'), ('Signature', 'signature'),
                 ('policy', 'policy'), ('x-oss-object-acl', 'x_oss_object_acl'),
                 ('x-oss-forbid-overwrite', 'x_oss_forbid_overwrite')]
        for name, source in names:
            value = data.get(source)
            if (not isinstance(value, str) or not value or len(value) > 16384
                    or any(ord(ch) < 33 or ord(ch) > 126 for ch in value)):
                c._fail('invalid_response')
            fields.append((name, value))
            if source in ('oss_access_key_id', 'signature', 'policy'):
                self.private.append(value)
        if data['x_oss_object_acl'] != 'private' or data['x_oss_forbid_overwrite'] != 'true':
            c._fail('invalid_response')
        fields += [('key', key), ('success_action_status', '200')]
        prefix = b''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('ascii')
                          for name, value in fields)
        prefix += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                   'Content-Type: application/octet-stream\r\n\r\n').encode('ascii')
        suffix = f'\r\n--{boundary}--\r\n'.encode('ascii')
        if len(prefix) + len(suffix) > 65536:
            c._fail('response_too_large')
        self.request(target, 'POST', headers={'Content-Type': 'multipart/form-data; boundary=' + boundary},
                     upload=dict(audio=audio, path=path, identity=identity, size=identity.st_size,
                                 prefix=prefix, suffix=suffix, length=len(prefix) + identity.st_size + len(suffix)))
        oss_url = 'oss://' + key
        self.private += [key, oss_url, data['upload_host']]
        return oss_url, (region or target['region'])

    def task(self, oss_url, region):
        c = self.c
        # DashScope serves two async ASR families behind the same endpoint: the
        # legacy Paraformer job (file_urls array, output.results) and the
        # Qwen-ASR filetrans job (single file_url, output.result). Both return
        # the same transcript JSON with integer millisecond sentence times.
        filetrans = self.filetrans
        parameters = {'channel_id': [0]}
        if filetrans:
            parameters['enable_itn'] = False
        if self.config['language'] != 'auto':
            parameters['language' if filetrans else 'language_hints'] = (
                self.config['language'] if filetrans else [self.config['language']])
        payload = dict(model=self.config['model'],
                       input={'file_url': oss_url} if filetrans else {'file_urls': [oss_url]},
                       parameters=parameters)
        body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        submitted = self.request(self.config, 'POST', body=body, api_auth=True,
                                 headers={'Content-Type': 'application/json', 'X-DashScope-Async': 'enable',
                                          'X-DashScope-OssResourceResolve': 'enable'})
        output = submitted.get('output')
        if not isinstance(output, dict):
            c._fail('invalid_response')
        task_id = output.get('task_id')
        if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', task_id):
            c._fail('invalid_response')
        self.private.append(task_id)
        # A fixed poll count would truncate the caller's budget for long jobs.
        # Two-second minimum spacing makes a timeout-derived cap finite without
        # silently imposing a second, much shorter timeout. The shared deadline
        # (including upload/submission) remains the actual stopping condition.
        max_polls = math.ceil(self.config['timeout'] / POLL_SECONDS) + 1
        for attempt in range(max_polls + 1):
            status = output.get('task_status')
            if status == 'SUCCEEDED':
                if filetrans:
                    outcome = output.get('result')
                    if not isinstance(outcome, dict):
                        c._fail('invalid_response')
                    url = outcome.get('transcription_url')
                else:
                    results = output.get('results')
                    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
                        c._fail('invalid_response')
                    if results[0].get('subtask_status') != 'SUCCEEDED':
                        c._fail('task_failed')
                    url = results[0].get('transcription_url')
                target = _storage_url(url, region, c, allow_http=filetrans)
                self.result_http = target['scheme'] == 'http'
                self.private.append(url)
                # Reject signing credentials even if the transcript echoes only
                # a token rather than the complete private result URL.
                secret_fields = {'OSSAccessKeyId', 'Signature', 'security-token',
                                 'x-oss-security-token', 'x-oss-credential', 'x-oss-signature'}
                query = urlsplit(url).query
                for (name, value), raw in zip(parse_qsl(query, strict_parsing=True), query.split('&')):
                    if name in secret_fields:
                        self.private.extend((value, raw.split('=', 1)[1]))
                return self.request(target, 'GET')
            if status in ('FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'):
                c._fail('task_failed')
            if status not in ('PENDING', 'RUNNING'):
                c._fail('invalid_response')
            if attempt == max_polls:
                c._fail('timeout')
            if attempt:
                time.sleep(min(POLL_SECONDS, self.budget.remaining()))
                self.budget.remaining()
            obj = self.request(dict(self.config, path='/api/v1/tasks/' + task_id), 'GET', api_auth=True)
            output = obj.get('output')
            if not isinstance(output, dict) or output.get('task_id', task_id) != task_id:
                c._fail('invalid_response')
        c._fail('timeout')

    def result(self, obj):
        c = self.c
        transcripts = obj.get('transcripts')
        if (not isinstance(transcripts, list) or len(transcripts) != 1
                or not isinstance(transcripts[0], dict) or type(transcripts[0].get('channel_id')) is not int
                or transcripts[0]['channel_id'] != 0):
            c._fail('unsupported_timestamp')
        sentences = transcripts[0].get('sentences')
        if not isinstance(sentences, list) or not sentences:
            c._fail('unsupported_timestamp')
        if len(sentences) > c.MAX_SEGMENTS:
            c._fail('response_too_large')
        properties = obj.get('properties', {})
        if not isinstance(properties, dict):
            c._fail('invalid_response')
        duration_ms = properties.get('original_duration_in_milliseconds')
        if duration_ms is not None and (type(duration_ms) is not int or not 0 < duration_ms <= c.MAX_TIMESTAMP_MS):
            c._fail('invalid_timestamps')
        segments, end = [], 0
        for sentence in sentences:
            if not isinstance(sentence, dict):
                c._fail('invalid_timestamps')
            begin, finish = sentence.get('begin_time'), sentence.get('end_time')
            if (type(begin) is not int or type(finish) is not int
                    or begin < end or finish <= begin or finish > c.MAX_TIMESTAMP_MS
                    or duration_ms is not None and finish > duration_ms):
                c._fail('invalid_timestamps')
            text = sentence.get('text')
            if not isinstance(text, str) or not text.strip():
                c._fail('invalid_response')
            segments.append(dict(start=begin / 1000, end=finish / 1000, text=text.strip()))
            end = finish
        # A hint is not detected language; do not invent one from the request.
        language = c._language_response(obj.get('language'))
        wanted = self.config['language']
        if language is not None and wanted != 'auto' and language != wanted and not language.startswith(wanted + '-'):
            c._fail('language_mismatch')
        result = dict(segments=segments, info=dict(duration=None if duration_ms is None else duration_ms / 1000,
                                                 language=language), provider_model=self.config['model'],
                      engine=self.config['engine'], response_format=self.config['response_format'],
                      warnings=list(self.config['warnings']))
        if self.result_http:
            result['warnings'].append('result_url_used_plain_http_from_provider')
        for private in self.private:
            c._no_secret(result, private)
        self.budget.remaining()
        return result


def transcribe(audio_path, config, shared):
    """Internal dispatch; shared preserves the caller's exception/network hooks."""
    session = _Session(config, shared)
    c = session.c
    configured = config.get('region') or ''
    if configured:
        region = configured
    elif config['host'] == 'dashscope-intl.aliyuncs.com' or config['host'].endswith('.ap-southeast-1.maas.aliyuncs.com'):
        region = 'ap-southeast-1'
    elif (session.filetrans and config['host'] != 'dashscope.aliyuncs.com'
            and not config['host'].endswith('.cn-beijing.maas.aliyuncs.com')):
        # An explicitly configured compatible gateway may host its storage in
        # any DashScope region; trust only the authenticated policy response
        # and then pin the result download to that same region.
        region = None
    else:
        region = 'cn-beijing'
    if region is not None and region not in ('cn-beijing', 'ap-southeast-1'):
        c._fail('invalid_config')
    path = Path(audio_path)
    extension = path.suffix.lower().lstrip('.')
    if path.is_symlink() or not path.is_file() or extension not in ('m4a', 'mp4', 'mp3', 'wav', 'webm', 'ogg', 'opus', 'flac', 'aac'):
        c._fail('audio_invalid')
    try:
        identity = path.stat(follow_symlinks=False)
        audio = path.open('rb')
    except OSError:
        c._fail('audio_invalid')
    with audio:
        session.identity(audio, path, identity)
        if identity.st_size <= 0:
            c._fail('audio_invalid')
        if identity.st_size > config['max_bytes']:
            c._fail('size_limit')
        oss_url, region = session.policy_upload(audio, path, identity, extension, region)
        obj = session.task(oss_url, region)
        return session.result(obj)
