"""Qwen-ASR OpenAI-compatible input_audio Data URI adapter; no SDK/retry.

Official contract: https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference
This protocol returns real text only, never synthetic timestamps. Encoded audio
is bounded to 10 MB before opening a connection; no remote audio URL or OSS hop.
"""
from __future__ import annotations

import base64
import json
from types import SimpleNamespace

ENCODED_AUDIO_LIMIT = 10 * 1000 * 1000
MIMES = {'m4a': 'audio/mp4', 'mp4': 'audio/mp4', 'mp3': 'audio/mpeg',
         'wav': 'audio/wav', 'webm': 'audio/webm', 'ogg': 'audio/ogg',
         'opus': 'audio/ogg', 'flac': 'audio/flac', 'aac': 'audio/aac'}


def transcribe(audio_path, config, shared):
    c = SimpleNamespace(**shared) if isinstance(shared, dict) else shared
    budget = c._Budget(config['timeout'])
    path, extension, identity = c._private_audio(audio_path, config)
    prefix = 'data:' + MIMES[extension] + ';base64,'
    # The public API limit includes the Base64 expansion (and Data URI prefix),
    # not merely source bytes. Check before reading or creating a connection.
    if len(prefix) + 4 * ((identity.st_size + 2) // 3) > ENCODED_AUDIO_LIMIT:
        c._fail('size_limit')
    chunks, total = [], 0
    with c._open_audio(path, identity) as audio:
        while total < identity.st_size:
            budget.remaining()
            chunk = audio.read(min(c.CHUNK_BYTES, identity.st_size - total))
            if not chunk:
                c._fail('audio_invalid')
            chunks.append(chunk)
            total += len(chunk)
        c._check_audio_identity(audio, path, identity)
        if audio.read(1):
            c._fail('audio_invalid')
        data_uri = prefix + base64.b64encode(b''.join(chunks)).decode('ascii')
        options = {'enable_itn': False}
        if config['language'] != 'auto':
            options['language'] = config['language']
        body = json.dumps(dict(model=config['model'], stream=False,
                               messages=[dict(role='user', content=[dict(type='input_audio',
                                              input_audio={'data': data_uri})])],
                               asr_options=options), ensure_ascii=False,
                          separators=(',', ':')).encode('utf-8')
        budget.remaining()
        connection = c._connect(config, budget)
        try:
            c._check_audio_identity(audio, path, identity)
            c._socket_budget(connection, budget)
            connection.putrequest('POST', config['path'], skip_accept_encoding=True)
            for name, value in {'Content-Type': 'application/json', 'Content-Length': str(len(body)),
                                'Accept': 'application/json', 'Accept-Encoding': 'identity',
                                'Connection': 'close'}.items():
                connection.putheader(name, value)
            if config['api_key']:
                connection.putheader('Authorization', 'Bearer ' + config['api_key'])
            connection.endheaders()
            for offset in range(0, len(body), c.CHUNK_BYTES):
                c._socket_budget(connection, budget)
                connection.send(body[offset:offset + c.CHUNK_BYTES])
                budget.remaining()
            c._check_audio_identity(audio, path, identity)
            c._socket_budget(connection, budget)
            response = connection.getresponse()
            budget.remaining()
            c._status(response.status)
            raw = c._read_response(response, connection, budget)
        finally:
            try:
                connection.close()
            except Exception:
                pass
    try:
        obj = json.loads(raw.decode('utf-8-sig'), parse_constant=c._reject_constant)
    except (ValueError, UnicodeError):
        c._fail('invalid_response')
    if not isinstance(obj, dict):
        c._fail('invalid_response')
    c._no_secret(obj, config['api_key'])
    choices = obj.get('choices')
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        c._fail('invalid_response')
    choice = choices[0]
    # A length/content-filter stop would silently truncate a lecture.
    if choice.get('finish_reason') != 'stop':
        c._fail('invalid_response')
    message = choice.get('message')
    if not isinstance(message, dict) or message.get('role') != 'assistant':
        c._fail('invalid_response')
    language = None
    annotations = message.get('annotations', [])
    if not isinstance(annotations, list):
        c._fail('invalid_response')
    for annotation in annotations:
        if not isinstance(annotation, dict):
            c._fail('invalid_response')
        if annotation.get('type') == 'audio_info' and annotation.get('language') is not None:
            detected = c._language_response(annotation['language'])
            if language is not None and detected != language:
                c._fail('invalid_response')
            language = detected
    if language is not None and config['language'] != 'auto' and language != config['language'] and not language.startswith(config['language'] + '-'):
        c._fail('language_mismatch')
    result = c._text_result(message.get('content'), config,
                            response_format='chat_completion_json', language=language)
    budget.remaining()
    return result
