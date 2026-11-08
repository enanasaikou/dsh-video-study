"""Standard-library offline tests. Fake uploads only; every HTTP connection mocked."""
import copy
import http.client
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('video_study_cloud_asr', Path(__file__).parents[1] / 'python' / 'cloud_asr.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

KEY = 'FAKE_CLOUD_CREDENTIAL_NEVER_REAL'
ENDPOINT = 'https://speech.example.invalid/v1/audio/transcriptions'
FAKE_AUDIO = b'FAKE_TEST_BYTES_NOT_REAL_MEDIA'


def good(**changes):
    obj = dict(duration=2.5, language='english', segments=[
        dict(start=0, end=1.25, text='first'), dict(start=1.25, end=2.5, text='second')])
    obj.update(changes)
    return obj


class Response:
    def __init__(self, body=None, status=200, headers=None, on_read=None):
        body = good() if body is None else body
        if not isinstance(body, bytes):
            body = json.dumps(body).encode('utf-8')
        self.buffer = io.BytesIO(body)
        self.status = status
        self.headers = headers or {'Content-Type': 'application/json'}
        self.on_read = on_read
        self.reads = 0
    def getheader(self, name, default=None): return self.headers.get(name, default)
    def read(self, size=-1):
        self.reads += 1
        if self.on_read:
            self.on_read()
        return self.buffer.read(size)
    def read1(self, size=-1): return self.read(size)


class Socket:
    def __init__(self): self.timeouts = []
    def settimeout(self, value): self.timeouts.append(value)


class Connection:
    def __init__(self, response=None):
        self.response = response or Response()
        self.headers = {}
        self.sent = []
        self.request = None
        self.tunnel = None
        self.closed = False
        self.sock = Socket()
        self.timeout = None
        self.on_send = None
        self.error = None
    def set_tunnel(self, host, port, headers=None): self.tunnel = (host, port, headers)
    def putrequest(self, method, path, **kwargs): self.request = (method, path, kwargs)
    def putheader(self, name, value): self.headers[name] = value
    def endheaders(self):
        if self.error:
            raise self.error
    def send(self, payload):
        self.sent.append(payload)
        if self.on_send:
            self.on_send(payload)
    def getresponse(self): return self.response
    def close(self): self.closed = True


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cloud-asr-offline-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.audio = self.root / 'UNTRUSTED_FILENAME.m4a'
        self.audio.write_bytes(FAKE_AUDIO)
        self.config = dict(endpoint=ENDPOINT, api_key=KEY, model='whisper-1', language='en', upload_consent=True)
        self.connection = Connection()
        self.addCleanup(patch.stopall)
        self.https = patch.object(m.http.client, 'HTTPSConnection', side_effect=lambda *args, **kwargs: self.connection).start()
        self.http = patch.object(m.http.client, 'HTTPConnection', side_effect=lambda *args, **kwargs: self.connection).start()
        self.context = patch.object(m.ssl, 'create_default_context', return_value=object()).start()

    def invoke(self, **changes):
        config = dict(self.config, **changes)
        return m.transcribe_cloud(self.audio, **config)

    def code(self, expected, function, *args, **kwargs):
        with self.assertRaises(m.CloudASRError) as caught:
            function(*args, **kwargs)
        error = caught.exception
        self.assertEqual(error.code, expected)
        self.assertNotIn(KEY, error.message)
        self.assertNotIn(ENDPOINT, error.message)
        self.assertTrue(error.__suppress_context__)
        self.assertIsNone(error.__cause__)
        return error

    def assert_no_connection(self):
        self.https.assert_not_called()
        self.http.assert_not_called()

    def test_success_whitelisted_response_and_exact_multipart(self):
        result = self.invoke()
        self.assertEqual(result['provider_model'], 'whisper-1')
        self.assertEqual(result['response_format'], 'verbose_json')
        self.assertEqual(result['info'], {'duration': 2.5, 'language': 'en'})
        self.assertEqual(len(result['segments']), 2)
        self.assertEqual(self.connection.request[:2], ('POST', '/v1/audio/transcriptions'))
        self.assertEqual(self.connection.headers['Authorization'], 'Bearer ' + KEY)
        body = b''.join(self.connection.sent)
        self.assertEqual(int(self.connection.headers['Content-Length']), len(body))
        for name, value in ((b'model', b'whisper-1'), (b'language', b'en'),
                            (b'response_format', b'verbose_json'), (b'timestamp_granularities[]', b'segment')):
            self.assertIn(b'name="' + name + b'"\r\n\r\n' + value, body)
        self.assertIn(b'filename="audio.m4a"', body)
        self.assertNotIn(b'UNTRUSTED_FILENAME', body)
        self.assertIn(FAKE_AUDIO, body)
        self.assertNotIn(KEY.encode(), body)
        self.assertNotIn(KEY, json.dumps(result))
        self.assertNotIn(ENDPOINT, json.dumps(result))
        self.assertTrue(self.connection.closed)
        self.assertEqual(self.audio.read_bytes(), FAKE_AUDIO)

    def test_provider_default_siliconflow_contract_omits_unsupported_fields(self):
        self.connection.response = Response({'text': '硅基流动真实识别正文'})
        result = self.invoke(protocol='openai', endpoint='https://api.siliconflow.cn/v1/audio/transcriptions',
                             provider_name='任意自定义展示名', model='future/vendor-model', response_format='provider_default')
        body = b''.join(self.connection.sent)
        self.assertIn(b'name="model"\r\n\r\nfuture/vendor-model', body)
        for field in (b'language', b'response_format', b'timestamp_granularities[]'):
            self.assertNotIn(b'name="' + field + b'"', body)
        self.assertTrue(result['text_only'])
        self.assertEqual(result['text'], '硅基流动真实识别正文')
        state = m.validate_cloud_config(dict(self.config, protocol='openai', response_format='provider_default'))
        self.assertFalse(state['language_parameter_sent'])

    def test_json_mode_sends_language_but_not_unsupported_timestamp_parameter(self):
        self.connection.response = Response({'text': 'actual text', 'language': 'english', 'duration': 2})
        result = self.invoke(protocol='openai', response_format='json')
        body = b''.join(self.connection.sent)
        self.assertIn(b'name="response_format"\r\n\r\njson', body)
        self.assertIn(b'name="language"\r\n\r\nen', body)
        self.assertNotIn(b'name="timestamp_granularities[]"', body)
        self.assertTrue(result['text_only'])
        self.assertEqual(result['info'], {'language': 'en', 'duration': 2.0})

    def test_explicit_openai_preserves_custom_route_not_vendor_or_name_allowlist(self):
        path = '/tenant/custom-v3:transcribe;mode=asr/'
        state = m.validate_cloud_config(dict(self.config, protocol='openai', endpoint='https://custom.invalid:8443' + path,
                                              provider_name='火山引擎', model='new vendor model'))
        self.assertEqual(state['protocol'], 'openai')
        self.assertEqual(state['provider_name'], '火山引擎')
        self.invoke(protocol='openai', endpoint='https://custom.invalid:8443' + path, provider_name='腾讯云')
        self.assertEqual(self.connection.request[:2], ('POST', path))
        self.assertEqual(self.https.call_args.args[:2], ('custom.invalid', 8443))
        self.assertEqual(self.connection.headers['Authorization'], 'Bearer ' + KEY)

    def test_explicit_protocol_still_rejects_url_smuggling_before_files_or_native_load(self):
        for path in ('/a/../b', '/a/./b', '/a/%2f/b', '/a/%252e%252e/b', '//evil.invalid/x', '/a//b', '/a\\b', '/x?token=secret', '/x#secret'):
            with self.subTest(path=path), patch.object(m, 'Path', side_effect=AssertionError('no files')):
                self.code('invalid_endpoint', self.invoke, protocol='openai', endpoint='https://custom.invalid' + path)
        self.assert_no_connection()

    def test_every_protocol_offline_preflight_does_not_load_any_adapter(self):
        engines = {'openai': 'openai_compatible_audio_transcriptions', 'dashscope_qwen': 'aliyun_qwen_asr',
                   'dashscope_paraformer': 'aliyun_paraformer', 'volcengine_flash': 'volcengine_flash',
                   'tencent_rec_task': 'tencent_rec_task'}
        for protocol, engine in engines.items():
            with self.subTest(protocol=protocol), patch.object(m, 'Path', side_effect=AssertionError('no files')), patch.object(importlib.util, 'spec_from_file_location', side_effect=AssertionError('no modules')):
                state = m.validate_cloud_config(dict(self.config, endpoint='https://custom.invalid/fully-custom',
                                                    protocol=protocol, app_id='PUBLIC_APP_ID', resource_id='CUSTOM_RESOURCE',
                                                    model='未来自定义 model'))
            self.assertEqual(state['engine'], engine)
            self.assertEqual(state['model'], '未来自定义 model')
            self.assertEqual(state['protocol'], protocol)
            self.assertEqual(state['language_parameter_sent'], protocol not in ('volcengine_flash', 'tencent_rec_task'))
            self.assertNotIn('PUBLIC_APP_ID', json.dumps(state))
            self.assertNotIn('CUSTOM_RESOURCE', json.dumps(state))
        self.assert_no_connection()

    def test_protocol_and_custom_fields_require_safe_exact_types(self):
        for changes in ({'provider_name': KEY}, {'provider_name': 'x\r\n'}, {'app_id': 'bad\n'},
                        {'region': KEY}, {'resource_id': 'bad value'}, {'protocol': 'volcengine_flash'},
                        {'protocol': 'tencent_rec_task'}, {'protocol': 'dashscope_paraformer', 'region': 'unsafe-region'}):
            with self.subTest(field=list(changes)), patch.object(m, 'Path', side_effect=AssertionError('no files')):
                self.code('invalid_config', self.invoke, **changes)
        for changes, code in (({'protocol': 'unknown'}, 'invalid_protocol'), ({'protocol': None}, 'invalid_protocol'),
                              ({'response_format': 'text'}, 'invalid_response_format')):
            self.code(code, self.invoke, **changes)
        for protocol in ('volcengine_flash', 'tencent_rec_task'):
            config = dict(self.config, protocol=protocol, api_key='', app_id='APP', resource_id='RESOURCE')
            with patch.object(m, 'Path', side_effect=AssertionError('no files')), patch.object(importlib.util, 'spec_from_file_location', side_effect=AssertionError('no modules')):
                status = m.validate_cloud_config(config)
                self.assertFalse(status['has_api_key'])
                self.code('invalid_api_key', self.invoke, protocol=protocol, api_key='', app_id='APP', resource_id='RESOURCE')
        self.code('invalid_response', m.validate_cloud_config, dict(self.config, protocol='tencent_rec_task',
                  app_id='FAKE_PRIVATE_SECRET_ID', model='FAKE_PRIVATE_SECRET_ID'))
        state = m.validate_cloud_config(dict(self.config, provider_name='长厂商名称' * 100))
        self.assertEqual(state['provider_name'], '长厂商名称' * 100)
        self.assert_no_connection()

    def test_auto_language_omitted_not_translation(self):
        self.invoke(language='auto')
        body = b''.join(self.connection.sent)
        self.assertNotIn(b'name="language"', body)
        self.assertNotIn(b'name="task"', body)
        self.assertNotIn(b'translate', body)

    def test_chinese_forced_request_and_response(self):
        self.connection.response = Response(good(language='chinese'))
        result = self.invoke(language='zh')
        self.assertEqual(result['info']['language'], 'zh')
        self.assertIn(b'name="language"\r\n\r\nzh', b''.join(self.connection.sent))

    def test_config_preflight_does_not_read_files_or_network_or_return_secrets(self):
        with patch.object(m, 'Path', side_effect=AssertionError('file access forbidden')):
            status = m.validate_cloud_config(self.config)
        self.assertTrue(status['configured'])
        self.assertTrue(status['has_api_key'])
        for forbidden in ('endpoint', 'api_key', 'proxy', 'host', 'port'):
            self.assertNotIn(forbidden, status)
        self.assertNotIn(KEY, json.dumps(status))
        self.assertNotIn(ENDPOINT, json.dumps(status))
        self.assert_no_connection()

    def test_default_consent_denies_before_any_file_access(self):
        config = dict(self.config)
        config.pop('upload_consent')
        with patch.object(m, 'Path', side_effect=AssertionError('must not touch file')):
            self.code('upload_consent_required', m.transcribe_cloud, 'not-a-file', **config)
            self.code('upload_consent_required', m.validate_cloud_config, config)
        self.assert_no_connection()

    def test_consent_must_be_true_boolean_not_truthy(self):
        for value in (False, None, 1, 'true', 'yes'):
            with self.subTest(value=value), patch.object(m, 'Path', side_effect=AssertionError('must not touch file')):
                self.code('upload_consent_required', self.invoke, upload_consent=value)
        self.assert_no_connection()

    def test_invalid_config_stops_before_file_or_network(self):
        cases = [({'endpoint': None}, 'invalid_endpoint'), ({'model': ''}, 'invalid_model'),
                 ({'model': 'bad\r\nHEADER'}, 'invalid_model'), ({'language': 'de'}, 'invalid_language'),
                 ({'api_key': KEY + '\r\nInjected: secret'}, 'invalid_api_key'),
                 ({'timeout': 0}, 'invalid_limit'), ({'max_bytes': True}, 'invalid_limit'),
                 ({'max_bytes': 0}, 'invalid_limit'), ({'allow_insecure_loopback': 'true'}, 'invalid_config')]
        for changes, expected in cases:
            with self.subTest(changes=changes), patch.object(m, 'Path', side_effect=AssertionError('must not touch file')):
                self.code(expected, self.invoke, **changes)
        self.assert_no_connection()

    def test_endpoint_must_be_explicit_complete_no_credentials_query_fragment(self):
        endpoints = ['', 'https://speech.example.invalid', 'https://speech.example.invalid/v1/chat/completions',
                     'https://user:pass@speech.example.invalid/v1/audio/transcriptions',
                     ENDPOINT + '?key=' + KEY, ENDPOINT + '?', ENDPOINT + '#',
                     'https://speech.example.invalid/v1/audio/transcriptions/',
                     ENDPOINT + '\n', 'file:///v1/audio/transcriptions',
                     'https://speech.example.invalid:0/v1/audio/transcriptions']
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint):
                self.code('invalid_endpoint', self.invoke, endpoint=endpoint)
        self.assert_no_connection()

    def test_compatible_prefix_path_preserved_on_request_not_public_status(self):
        for path in ('/openai/v1/audio/transcriptions', '/tenant-1/api_v2/audio/transcriptions',
                     '/audio/transcriptions'):
            with self.subTest(path=path):
                endpoint = 'https://speech.example.invalid' + path
                state = m.validate_cloud_config(dict(self.config, endpoint=endpoint))
                self.assertNotIn('path', state)
                self.assertNotIn(path, json.dumps(state))
                self.connection = Connection()
                self.invoke(endpoint=endpoint)
                self.assertEqual(self.connection.request[:2], ('POST', path))
                self.assertEqual(self.https.call_args.args[:2], ('speech.example.invalid', 443))

    def test_ambiguous_encoded_dot_or_wrong_endpoint_paths_rejected(self):
        paths = ('/openai/../v1/audio/transcriptions', '/openai/./v1/audio/transcriptions',
                 '/openai/%2e%2e/v1/audio/transcriptions', '/openai%2fv1/audio/transcriptions',
                 '/openai/%61udio/transcriptions', '/openai//v1/audio/transcriptions',
                 '//openai/v1/audio/transcriptions', '/openai/v1/chat/completions',
                 '/openai/v1/audio/transcriptions/', '/openai/v1/audio/translations',
                 '/云端/v1/audio/transcriptions', '/openai;token/v1/audio/transcriptions')
        for path in paths:
            with self.subTest(path=path), patch.object(m, 'Path', side_effect=AssertionError('no file access')):
                self.code('invalid_endpoint', self.invoke, endpoint='https://speech.example.invalid' + path)
        self.assert_no_connection()

    def test_http_rejected_by_default_including_internal_and_loopback(self):
        for host in ('speech.example.invalid', '192.168.1.2', 'localhost', '127.0.0.1', '[::1]'):
            with self.subTest(host=host):
                self.code('insecure_endpoint', self.invoke, endpoint=f'http://{host}/v1/audio/transcriptions')
        self.assert_no_connection()

    def test_only_explicit_exact_http_loopback_allowed(self):
        for host in ('localhost', '127.0.0.1', '[::1]'):
            with self.subTest(host=host):
                self.connection = Connection()
                result = self.invoke(endpoint=f'http://{host}:9000/v1/audio/transcriptions',
                                     allow_insecure_loopback=True, api_key='')
                self.assertTrue(result['warnings'])
                self.assertNotIn('Authorization', self.connection.headers)
        self.assertEqual(self.http.call_count, 3)
        self.https.assert_not_called()

    def test_insecure_loopback_flag_does_not_allow_other_http_hosts(self):
        for host in ('127.0.0.2', 'localhost.example.invalid', '192.168.1.2', 'speech.example.invalid'):
            with self.subTest(host=host):
                self.code('insecure_endpoint', self.invoke, endpoint=f'http://{host}/v1/audio/transcriptions',
                          allow_insecure_loopback=True)
        self.assert_no_connection()

    def test_missing_public_key_warns_never_reads_environment(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': KEY, 'HTTPS_PROXY': 'http://evil.invalid:7897'}):
            state = m.validate_cloud_config(dict(self.config, api_key=''))
            result = self.invoke(api_key='')
        self.assertFalse(state['has_api_key'])
        self.assertTrue(state['warnings'])
        self.assertTrue(result['warnings'])
        self.assertNotIn('Authorization', self.connection.headers)
        self.assertIsNone(self.connection.tunnel)
        self.assertEqual(self.https.call_args.args[:2], ('speech.example.invalid', 443))

    def test_explicit_http_proxy_connect_without_auth_leak_to_connect_headers(self):
        self.invoke(proxy='http://127.0.0.1:7897')
        self.assertEqual(self.https.call_args.args[:2], ('127.0.0.1', 7897))
        self.assertEqual(self.connection.tunnel, ('speech.example.invalid', 443, {}))
        self.assertEqual(self.connection.headers['Authorization'], 'Bearer ' + KEY)
        self.context.assert_called_once_with()

    def test_https_socks_proxy_explicitly_unsupported_no_downgrade(self):
        for proxy in ('https://proxy.example.invalid:443', 'socks5://127.0.0.1:7897'):
            with self.subTest(proxy=proxy):
                self.code('unsupported_proxy', self.invoke, proxy=proxy)
        self.assert_no_connection()

    def test_proxy_credentials_path_query_and_fragment_rejected(self):
        for proxy in ('http://user:pass@127.0.0.1:7897', 'http://127.0.0.1:7897/path',
                      'http://127.0.0.1:7897?secret=foo', 'http://127.0.0.1:7897#token',
                      'http://127.0.0.1:99999'):
            with self.subTest(proxy=proxy):
                self.code('invalid_proxy', self.invoke, proxy=proxy)
        self.assert_no_connection()

    def test_http_loopback_proxy_mix_rejected(self):
        self.code('proxy_loopback_conflict', self.invoke, endpoint='http://localhost/v1/audio/transcriptions',
                  allow_insecure_loopback=True, proxy='http://127.0.0.1:7897')
        self.assert_no_connection()

    def test_large_file_rejected_before_network_not_split(self):
        self.code('size_limit', self.invoke, max_bytes=3)
        self.assert_no_connection()
        self.assertEqual(self.audio.read_bytes(), FAKE_AUDIO)

    def test_empty_missing_unknown_extension_audio_rejected_before_network(self):
        for path in (self.root / 'missing.m4a', self.root / 'empty.m4a', self.root / 'audio.exe'):
            if path.name != 'missing.m4a':
                path.write_bytes(b'' if path.name == 'empty.m4a' else FAKE_AUDIO)
            with self.subTest(path=path):
                self.code('audio_invalid', m.transcribe_cloud, path, **self.config)
        self.assert_no_connection()

    def test_file_streamed_in_bounded_chunks_not_read_whole(self):
        self.audio.write_bytes(b'x' * (3 * m.CHUNK_BYTES + 7))
        self.invoke()
        file_chunks = self.connection.sent[1:-1]
        self.assertEqual([len(chunk) for chunk in file_chunks], [m.CHUNK_BYTES] * 3 + [7])
        self.assertEqual(sum(map(len, file_chunks)), self.audio.stat().st_size)
        self.assertLessEqual(max(map(len, self.connection.sent)), m.CHUNK_BYTES)

    def test_changing_audio_aborts_without_tail_or_response(self):
        def mutate(payload):
            if payload == FAKE_AUDIO:
                with self.audio.open('ab') as handle:
                    handle.write(b'CHANGED')
        self.connection.on_send = mutate
        self.code('audio_invalid', self.invoke)
        self.assertEqual(self.connection.response.reads, 0)
        self.assertTrue(self.connection.closed)
        self.assertFalse(self.connection.sent[-1].endswith(b'--\r\n'))

    def test_missing_segments_without_text_cannot_fake_timestamps(self):
        for payload in (good(segments=[]), good(segments=None), {'text': ''}):
            with self.subTest(payload=payload):
                self.connection = Connection(Response(payload))
                self.code('unsupported_timestamp', self.invoke)
                self.assertTrue(self.connection.closed)

    def test_text_only_keeps_real_text_without_fabricated_time_or_language(self):
        for payload in ({'text': '  real words  '}, {'text': 'real words', 'segments': []}):
            self.connection = Connection(Response(payload))
            result = self.invoke()
            self.assertTrue(result['text_only'])
            self.assertEqual(result['text'], 'real words')
            self.assertEqual(result['segments'], [])
            self.assertEqual(result['response_format'], 'text_json')
            self.assertEqual(result['info'], {'duration': None, 'language': None})
            self.assertTrue(self.connection.closed)

    def test_text_only_cannot_hide_bad_timestamps_or_actual_language(self):
        for payload, code in (({'text': 'real words', 'segments': 'not list'}, 'invalid_response'),
                              ({'text': 'real words', 'segments': [{'start': -1, 'end': 2, 'text': 'x'}]}, 'invalid_timestamps'),
                              ({'text': 'real words', 'language': 'zh'}, 'language_mismatch'),
                              ({'text': 'real words', 'duration': -1}, 'invalid_timestamps'),
                              ({'text': KEY}, 'invalid_response')):
            self.connection = Connection(Response(payload))
            with self.subTest(code=code):
                self.code(code, self.invoke)

    def test_invalid_segment_times_rejected(self):
        pairs = [(-1, 1), (0, 0), (1, 0), (True, 2), ('0', 1), (0, float('nan')),
                 (0, float('inf')), (0, 0.0001), (0, 1e20)]
        for start, end in pairs:
            with self.subTest(start=start, end=end):
                self.connection = Connection(Response(good(segments=[dict(start=start, end=end, text='bad')])))
                expected = 'invalid_response' if isinstance(end, float) and not m.math.isfinite(end) else 'invalid_timestamps'
                self.code(expected, self.invoke)

    def test_out_of_order_overlap_and_duration_mismatch_rejected(self):
        payloads = [good(segments=[dict(start=1, end=2, text='a'), dict(start=0, end=1, text='b')]),
                    good(segments=[dict(start=0, end=2, text='a'), dict(start=1, end=2.5, text='b')]),
                    good(duration=1), good(duration=-1), good(duration=True)]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.connection = Connection(Response(payload))
                self.code('invalid_timestamps', self.invoke)

    def test_missing_duration_remains_none_not_inferred(self):
        payload = good()
        del payload['duration']
        self.connection = Connection(Response(payload))
        result = self.invoke()
        self.assertIsNone(result['info']['duration'])

    def test_missing_language_remains_none_not_fabricated(self):
        payload = good()
        del payload['language']
        self.connection = Connection(Response(payload))
        self.assertIsNone(self.invoke()['info']['language'])

    def test_language_mismatch_rejected(self):
        self.connection = Connection(Response(good(language='chinese')))
        self.code('language_mismatch', self.invoke)

    def test_ms_normalization_and_whitelisted_fields(self):
        payload = good(duration=1.2346, segments=[dict(start=0.0001, end=1.2346, text='  actual words  ',
                                                    url=ENDPOINT, extra='untrusted')], token='not_a_credential', model='other-model')
        self.connection = Connection(Response(payload))
        result = self.invoke()
        self.assertEqual(result['segments'], [{'start': 0.0, 'end': 1.235, 'text': 'actual words'}])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertNotIn(ENDPOINT, json.dumps(result))

    def test_secret_echo_in_any_provider_field_is_rejected(self):
        payloads = [good(segments=[dict(start=0, end=1, text='Bearer ' + KEY)]),
                    good(model=KEY), good(extra={'Authorization': 'Bearer ' + KEY}),
                    good(**{KEY: 'secret as a field name'})]
        for payload in payloads:
            with self.subTest(payload_kind=list(payload)):
                self.connection = Connection(Response(payload))
                result = None
                with self.assertRaises(m.CloudASRError) as caught:
                    result = self.invoke()
                self.assertIsNone(result)
                self.assertEqual(caught.exception.code, 'invalid_response')
                self.assertNotIn(KEY, str(caught.exception))
                self.assertTrue(self.connection.closed)
                self.assertEqual(list(self.root.iterdir()), [self.audio])

    def test_secret_echo_detection_normalizes_json_escapes(self):
        key = 'AB"CD\\EFG123'
        payload = good(segments=[dict(start=0, end=1, text='Authorization: ' + key)])
        self.connection = Connection(Response(payload))
        error = self.code('invalid_response', self.invoke, api_key=key)
        self.assertNotIn(key, error.message)
        # A provider can encode every character in a normal key with Unicode
        # escapes; JSON decoding must not let that credential through either.
        encoded = ''.join('\\u%04x' % ord(c) for c in KEY)
        raw = ('{"language":"english","segments":[{"start":0,"end":1,"text":"' + encoded + '"}]}').encode()
        self.connection = Connection(Response(raw))
        self.code('invalid_response', self.invoke)

    def test_nonempty_key_has_no_provider_length_assumption_only_header_safety(self):
        for key in ('中文凭据示例很长', 'bad key', 'bad\r\nheader', 'x' * 8193):
            with self.subTest(length=len(key)), patch.object(m, 'Path', side_effect=AssertionError('no file access')):
                self.code('invalid_api_key', self.invoke, api_key=key)
                self.code('invalid_api_key', m.validate_cloud_config, dict(self.config, api_key=key))
        self.assert_no_connection()
        for key in ('a', 'model', 'engine', '1234567', '12345678'):
            with self.subTest(key=key):
                self.connection = Connection()
                state = m.validate_cloud_config(dict(self.config, api_key=key))
                result = self.invoke(api_key=key)
                self.assertEqual(state['engine'], 'openai_compatible_audio_transcriptions')
                self.assertEqual(result['response_format'], 'verbose_json')
                self.assertEqual(self.connection.headers['Authorization'], 'Bearer ' + key)

    def test_short_key_complete_value_or_bearer_echo_rejected(self):
        for text in ('a', 'provider says Bearer a', '1234567'):
            key = '1234567' if text == '1234567' else 'a'
            with self.subTest(text=text):
                self.connection = Connection(Response(good(segments=[dict(start=0, end=1, text=text)])))
                self.code('invalid_response', self.invoke, api_key=key)

    def test_model_is_opaque_unicode_text_not_a_provider_identifier_grammar(self):
        for model in ('中文 模型 (新版)', ' name with spaces ', 'x' * 101, 'x' * 65536):
            with self.subTest(length=len(model)):
                state = m.validate_cloud_config(dict(self.config, model=model))
                result = self.invoke(model=model)
                self.assertEqual(state['model'], model)
                self.assertEqual(result['provider_model'], model)
                self.assertIn(model.encode('utf-8'), b''.join(self.connection.sent))
                self.connection = Connection()
        for model in ('', 'bad\x00name', 'bad\x7fname', 'bad\ud800name', 'x' * 65537, '中' * 22000):
            with self.subTest(length=len(model)), patch.object(m, 'Path', side_effect=AssertionError('no file access')):
                self.code('invalid_model', self.invoke, model=model)

    def test_model_must_not_echo_configured_secret_even_in_preflight(self):
        config = dict(self.config, model='prefix-' + KEY)
        self.code('invalid_model', m.validate_cloud_config, config)
        with patch.object(m, 'Path', side_effect=AssertionError('no file access')):
            self.code('invalid_model', m.transcribe_cloud, 'unused', **config)
        self.assert_no_connection()

    def test_invalid_json_response_and_invalid_text(self):
        payloads = [b'not json ' + KEY.encode(), b'[]', good(segments=[dict(start=0, end=1, text=' ')]),
                    good(segments=[dict(start=0, end=1, text=42)]), good(language=KEY)]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.connection = Connection(Response(payload))
                self.code('invalid_response', self.invoke)

    def test_statuses_classified_without_reading_raw_error_body_or_retry(self):
        for status, expected in ((401, 'authentication_failed'), (403, 'access_denied'), (429, 'rate_limited'),
                                  (413, 'request_too_large'), (500, 'provider_error'), (400, 'provider_error')):
            with self.subTest(status=status):
                self.connection = Connection(Response((KEY + ENDPOINT).encode(), status=status))
                self.code(expected, self.invoke)
                self.assertEqual(self.connection.response.reads, 0)
                self.assertTrue(self.connection.closed)
        self.assertEqual(self.https.call_count, 6)

    def test_redirects_never_followed_or_read(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.connection = Connection(Response((KEY + ENDPOINT).encode(), status=status,
                                                       headers={'Location': 'https://evil.invalid/' + KEY}))
                self.code('redirect_rejected', self.invoke)
                self.assertEqual(self.connection.response.reads, 0)
                self.assertEqual(self.connection.request[1], '/v1/audio/transcriptions')
        self.assertEqual(self.https.call_count, 5)

    def test_content_length_response_bound_prevents_read(self):
        self.connection.response = Response(headers={'Content-Length': str(m.MAX_RESPONSE_BYTES + 1)})
        self.code('response_too_large', self.invoke)
        self.assertEqual(self.connection.response.reads, 0)

    def test_stream_response_size_bound_without_content_length(self):
        self.connection.response = Response(b'x' * 300)
        with patch.object(m, 'MAX_RESPONSE_BYTES', 200):
            self.code('response_too_large', self.invoke)
        self.assertTrue(self.connection.closed)

    def test_response_invalid_encoding_length_or_mime(self):
        for headers in ({'Content-Length': 'abc'}, {'Content-Length': '1'}, {'Content-Encoding': 'gzip'},
                        {'Content-Type': 'text/html'}):
            with self.subTest(headers=headers):
                self.connection = Connection(Response(headers=headers))
                self.code('invalid_response', self.invoke)

    def test_segment_count_bound(self):
        with patch.object(m, 'MAX_SEGMENTS', 1):
            self.code('response_too_large', self.invoke)

    def test_upload_cumulative_timeout_stops_and_closes(self):
        clock = [0]
        self.connection.on_send = lambda payload: clock.__setitem__(0, clock[0] + 2)
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            self.code('timeout', self.invoke, timeout=3)
        self.assertTrue(self.connection.closed)
        self.assertLessEqual(max(self.connection.sock.timeouts), 3)
        self.assertEqual(self.connection.response.reads, 0)

    def test_response_cumulative_timeout_stops_and_closes(self):
        clock = [0]
        self.connection.response = Response(on_read=lambda: clock.__setitem__(0, clock[0] + 2))
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            self.code('timeout', self.invoke, timeout=3)
        self.assertTrue(self.connection.closed)
        self.assertLessEqual(max(self.connection.sock.timeouts), 3)

    def test_synchronous_response_can_wait_over_30s_without_resetting_budget(self):
        for proxy in (None, 'http://127.0.0.1:7897'):
            with self.subTest(proxy=bool(proxy)):
                self.https.reset_mock()
                self.connection = Connection()
                clock, read_budgets = [0], []
                response = self.connection.response

                def headers_after_computation():
                    self.assertEqual(self.connection.timeout, 120)
                    clock[0] += 45
                    return response

                def delayed_body():
                    read_budgets.append(self.connection.timeout)
                    if len(read_budgets) == 1:
                        clock[0] += 40

                response.on_read = delayed_body
                with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
                     patch.object(self.connection, 'getresponse', side_effect=headers_after_computation):
                    result = self.invoke(timeout=120, proxy=proxy)
                self.assertEqual(len(result['segments']), 2)
                self.assertEqual(read_budgets, [75, 35])
                self.assertEqual(self.https.call_args.kwargs['timeout'], 30)
                self.https.assert_called_once()
                self.assertTrue(self.connection.closed)
                self.assertLessEqual(max(self.connection.sock.timeouts[:4]), 30)

    def test_synchronous_header_wait_exhausts_total_budget_without_retry(self):
        clock = [0]

        def late_headers():
            self.assertEqual(self.connection.timeout, 120)
            clock[0] += 121
            return self.connection.response

        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.connection, 'getresponse', side_effect=late_headers):
            self.code('timeout', self.invoke, timeout=120)
        self.assertTrue(self.connection.closed)
        self.assertEqual(self.connection.response.reads, 0)
        self.https.assert_called_once()

    def test_synchronous_response_body_shares_header_deadline_without_retry(self):
        clock = [0]

        def headers():
            clock[0] += 70
            return self.connection.response

        def body():
            self.assertEqual(self.connection.timeout, 50)
            clock[0] += 51

        self.connection.response.on_read = body
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.connection, 'getresponse', side_effect=headers):
            self.code('timeout', self.invoke, timeout=120)
        self.assertTrue(self.connection.closed)
        self.https.assert_called_once()

    def test_response_wait_updates_detached_response_socket(self):
        from types import SimpleNamespace
        clock = [0]
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            budget = m._Budget(120)
            connection = Connection()
            connection.sock = None
            sock = Socket()
            response = Response()
            response.fp = SimpleNamespace(raw=SimpleNamespace(_sock=sock))
            clock[0] = 45
            m._socket_budget(connection, budget, response, response_wait=True)
            self.assertEqual(sock.timeouts, [75])
            self.assertEqual(connection.timeout, 75)
            clock[0] = 121
            self.code('timeout', m._socket_budget, connection, budget, response, response_wait=True)
            self.assertEqual(sock.timeouts, [75])

    def test_network_timeout_and_tls_errors_do_not_leak(self):
        for error, expected in ((OSError(KEY + ENDPOINT), 'network_error'),
                                (http.client.HTTPException(KEY + ENDPOINT), 'network_error'),
                                (TimeoutError(KEY + ENDPOINT), 'timeout')):
            with self.subTest(error=type(error).__name__):
                self.connection = Connection()
                self.connection.error = error
                self.code(expected, self.invoke)
                self.assertTrue(self.connection.closed)

    def test_no_implicit_endpoint_or_model_or_environment_credentials(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': KEY, 'OPENAI_BASE_URL': ENDPOINT}):
            self.code('invalid_endpoint', m.validate_cloud_config, {'upload_consent': True, 'model': 'whisper-1'})
            self.code('invalid_model', m.validate_cloud_config, {'upload_consent': True, 'endpoint': ENDPOINT})
        self.assert_no_connection()


if __name__ == '__main__':
    unittest.main(verbosity=2)
