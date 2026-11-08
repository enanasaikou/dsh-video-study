"""Pure fake-network Volcengine tests; NOT real service contract acceptance."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from test_cloud_asr import Connection, Response, FAKE_AUDIO, KEY, m as cloud

SPEC = importlib.util.spec_from_file_location('test_native_volcengine', Path(__file__).parents[1] / 'python' / 'volcengine_asr.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
APP_ID = 'FAKE_PUBLIC_VOLC_APP_ID'
HEADERS = {'Content-Type': 'application/json', 'X-Api-Status-Code': '20000000'}


def good():
    return {'audio_info': {'duration': 2500}, 'result': {'text': 'not used', 'utterances': [
        {'start_time': 100, 'end_time': 1200, 'text': ' first ', 'words': []},
        {'start_time': 1300, 'end_time': 2500, 'text': 'second'}]}}


class Tests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='fake-volc-asr-')
        self.addCleanup(temporary.cleanup)
        self.audio = Path(temporary.name) / 'PRIVATE_TITLE.mp3'
        self.audio.write_bytes(FAKE_AUDIO)
        self.config = dict(scheme='https', host='volc-custom.example.invalid', port=443,
                           path='/custom/full/flash', proxy=None, model='bigmodel', api_key=KEY,
                           app_id=APP_ID, resource_id='volc.bigasr.auc_turbo', region='',
                           language='auto', timeout=30, max_bytes=100_000_000, warnings=[])
        self.connections = [Connection(Response(good(), headers=HEADERS))]
        self.used = []
        self.addCleanup(patch.stopall)
        self.https = patch.object(cloud.http.client, 'HTTPSConnection', side_effect=self.connect).start()
        self.http = patch.object(cloud.http.client, 'HTTPConnection', side_effect=AssertionError('firewall HTTP')).start()
        patch.object(cloud.ssl, 'create_default_context', return_value=object()).start()
        self.firewall = patch.object(socket, 'create_connection', side_effect=AssertionError('firewall socket')).start()
        patch.object(socket.socket, 'connect', side_effect=AssertionError('firewall connect')).start()

    def connect(self, *args, **kwargs):
        if not self.connections:
            raise AssertionError('firewall unexpected extra request')
        connection = self.connections.pop(0)
        self.used.append(connection)
        return connection

    def invoke(self, **changes):
        return m.transcribe(self.audio, dict(self.config, **changes), vars(cloud))

    def error(self, code, **changes):
        with self.assertRaises(cloud.CloudASRError) as caught:
            self.invoke(**changes)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertNotIn(APP_ID, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertIsNone(caught.exception.__cause__)

    def response(self, payload=None, status=200, headers=None):
        self.connections = [Connection(Response(good() if payload is None else payload,
                                                 status=status, headers=HEADERS if headers is None else headers))]

    def test_synchronous_wait_over_30s_shares_upload_header_and_body_deadline(self):
        connection = self.connections[0]
        response = connection.response
        clock, read_budgets = [0], []

        def headers():
            self.assertEqual(connection.timeout, 120)
            clock[0] += 45
            return response

        def body():
            read_budgets.append(connection.timeout)
            if len(read_budgets) == 1:
                clock[0] += 40

        response.on_read = body
        with patch.object(cloud.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(connection, 'getresponse', side_effect=headers):
            result = self.invoke(timeout=120)
        self.assertEqual(len(result['segments']), 2)
        self.assertEqual(read_budgets, [75, 35])
        self.assertEqual(self.https.call_args.kwargs['timeout'], 30)
        self.assertTrue(connection.closed)
        self.https.assert_called_once()

    def test_synchronous_header_timeout_closes_without_resubmitting(self):
        connection = self.connections[0]
        clock = [0]

        def headers():
            self.assertEqual(connection.timeout, 120)
            clock[0] += 121
            return connection.response

        with patch.object(cloud.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(connection, 'getresponse', side_effect=headers):
            self.error('timeout', timeout=120)
        self.assertEqual(connection.response.reads, 0)
        self.assertTrue(connection.closed)
        self.https.assert_called_once()

    def test_inline_base64_exact_headers_custom_endpoint_and_real_timestamps(self):
        result = self.invoke()
        connection = self.used[0]
        self.assertEqual(connection.request[:2], ('POST', '/custom/full/flash'))
        self.https.assert_called_once()
        self.assertEqual(self.https.call_args.args[:2], ('volc-custom.example.invalid', 443))
        self.assertEqual(connection.headers['X-Api-App-Key'], APP_ID)
        self.assertEqual(connection.headers['X-Api-Access-Key'], KEY)
        self.assertEqual(connection.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo')
        self.assertEqual(connection.headers['X-Api-Sequence'], '-1')
        self.assertNotIn('Authorization', connection.headers)
        raw = b''.join(connection.sent)
        self.assertEqual(int(connection.headers['Content-Length']), len(raw))
        body = json.loads(raw)
        self.assertEqual(base64.b64decode(body['audio']['data']), FAKE_AUDIO)
        self.assertNotIn('url', body['audio'])
        self.assertEqual(body['request'], {'model_name': 'bigmodel', 'show_utterances': True})
        self.assertNotIn(b'PRIVATE_TITLE', raw)
        self.assertNotIn(KEY.encode(), raw)
        self.assertEqual(result['segments'][0], {'start': .1, 'end': 1.2, 'text': 'first'})
        self.assertEqual(result['info'], {'duration': 2.5, 'language': None})
        self.assertEqual(result['engine'], 'volcengine_flash')
        self.assertEqual(result['response_format'], 'utterances_json')
        self.assertTrue(connection.closed)
        self.firewall.assert_not_called()
        self.http.assert_not_called()
        for forbidden in (KEY, APP_ID, self.config['host'], 'not used', 'PRIVATE_TITLE'):
            self.assertNotIn(forbidden, json.dumps(result))

    def test_cloud_route_runs_validated_native_adapter_without_openai_payload(self):
        result = cloud.transcribe_cloud(self.audio, endpoint='https://volc-custom.example.invalid/custom/full/flash',
            api_key=KEY, model='bigmodel', language='auto', upload_consent=True,
            protocol='volcengine_flash', app_id=APP_ID, resource_id='volc.bigasr.auc_turbo')
        self.assertEqual(result['engine'], 'volcengine_flash')
        body = json.loads(b''.join(self.used[0].sent))
        self.assertIn('audio', body)
        self.assertNotIn('response_format', body)

    def test_model_not_artificially_whitelisted_and_no_language_guess(self):
        result = self.invoke(model='custom-model-v99', language='en')
        self.assertIsNone(result['info']['language'])
        self.assertEqual(json.loads(b''.join(self.used[0].sent))['request']['model_name'], 'custom-model-v99')

    def test_validated_opaque_models_preserve_spaces_unicode_and_64kib(self):
        for model in (' custom model 模型 v1 ', '模型 with spaces ' * 200, '模' * 21845 + 'x'):
            with self.subTest(model_bytes=len(model.encode('utf-8'))):
                self.response()
                result = cloud.transcribe_cloud(self.audio,
                    endpoint='https://volc-custom.example.invalid/custom/full/flash',
                    api_key=KEY, model=model, language='auto', upload_consent=True,
                    protocol='volcengine_flash', app_id=APP_ID, resource_id='volc.bigasr.auc_turbo')
                self.assertEqual(json.loads(b''.join(self.used[-1].sent))['request']['model_name'], model)
                self.assertEqual(result['provider_model'], model)

    def test_module_shared_interface_and_explicit_proxy(self):
        self.config['proxy'] = ('proxy.example.invalid', 8080)
        result = m.transcribe(self.audio, self.config, cloud)
        self.assertTrue(result['segments'])
        self.assertEqual(self.used[0].tunnel, ('volc-custom.example.invalid', 443, {}))
        self.assertEqual(self.https.call_args.args[:2], ('proxy.example.invalid', 8080))

    def test_missing_credentials_and_plaintext_fail_before_network(self):
        for changes, code in [({'app_id': ''}, 'invalid_config'), ({'api_key': ''}, 'invalid_config'),
                              ({'resource_id': ''}, 'invalid_config'), ({'app_id': 'x\r\ny'}, 'invalid_config'),
                              ({'scheme': 'http'}, 'insecure_endpoint')]:
            with self.subTest(changes=changes):
                self.error(code, **changes)
        self.https.assert_not_called()

    def test_size_and_format_limits_before_any_connection(self):
        self.error('size_limit', max_bytes=1)
        with patch.object(m, 'MAX_AUDIO_BYTES', len(FAKE_AUDIO) - 1):
            self.error('size_limit')
        self.audio = self.audio.with_suffix('.m4a')
        self.audio.write_bytes(FAKE_AUDIO)
        self.error('audio_invalid')
        self.https.assert_not_called()

    def test_identity_and_size_rechecked_during_read(self):
        original = cloud._check_audio_identity
        calls = []
        def check(audio, path, identity):
            calls.append(1)
            if len(calls) == 2:
                path.write_bytes(b'CHANGED')
            return original(audio, path, identity)
        with patch.object(cloud, '_check_audio_identity', side_effect=check):
            self.error('audio_invalid')
        self.https.assert_not_called()

    def test_redirect_status_auth_rate_and_no_retry(self):
        for status, code in [(302, 'redirect_rejected'), (401, 'authentication_failed'),
                             (403, 'access_denied'), (429, 'rate_limited'), (413, 'request_too_large')]:
            with self.subTest(status=status):
                self.response(status=status, headers=dict(HEADERS, Location='https://evil.invalid/'))
                before = len(self.used)
                self.error(code)
                self.assertEqual(len(self.used), before + 1)
                self.assertTrue(self.used[-1].closed)

    def test_provider_header_errors_are_not_returned_or_retried(self):
        for header, code in [('45000151', 'audio_invalid'), ('55000031', 'rate_limited'),
                             ('55000001', 'provider_error'), (None, 'invalid_response')]:
            headers = {'Content-Type': 'application/json', 'X-Api-Message': KEY}
            if header is not None:
                headers['X-Api-Status-Code'] = header
            self.response(headers=headers)
            self.error(code)
            self.assertTrue(self.used[-1].closed)

    def test_invalid_json_content_length_encoding_and_large_response(self):
        cases = [(b'{bad', HEADERS, 'invalid_response'),
                 (b'{"x":NaN}', HEADERS, 'invalid_response'),
                 (good(), dict(HEADERS, **{'Content-Encoding': 'gzip'}), 'invalid_response'),
                 (good(), dict(HEADERS, **{'Content-Length': '1'}), 'invalid_response'),
                 (good(), dict(HEADERS, **{'Content-Length': str(cloud.MAX_RESPONSE_BYTES + 1)}), 'response_too_large')]
        for body, headers, code in cases:
            with self.subTest(code=code, headers=headers):
                self.response(body, headers=headers)
                self.error(code)
                self.assertTrue(self.used[-1].closed)

    def test_missing_or_invalid_genuine_timestamps_never_fabricated(self):
        for value, code in [(None, 'unsupported_timestamp'), ([], 'unsupported_timestamp'),
                            ([{'text': 'only text'}], 'invalid_timestamps')]:
            payload = good()
            payload['result']['utterances'] = value
            self.response(payload)
            self.error(code)
        for start, end in [(-1, 3), (False, 100), (1.1, 100), (100, 100), (10, 2600), (100, '200')]:
            with self.subTest(start=start, end=end):
                payload = good()
                payload['result']['utterances'][0].update(start_time=start, end_time=end)
                self.response(payload)
                self.error('invalid_timestamps')
        payload = good()
        payload['result']['utterances'][1]['start_time'] = 1199
        self.response(payload)
        self.error('invalid_timestamps')

    def test_no_duration_invented_and_secret_echo_rejected(self):
        payload = good()
        del payload['audio_info']
        self.response(payload)
        self.assertIsNone(self.invoke()['info']['duration'])
        for secret in (KEY, APP_ID):
            payload = good()
            payload['result']['utterances'][0]['text'] = secret
            self.response(payload)
            self.error('invalid_response')

    def test_single_deadline_covers_upload_response_and_parse(self):
        now = [10.0]
        def send(_): now[0] = 50.0
        self.connections[0].on_send = send
        with patch.object(cloud.time, 'monotonic', side_effect=lambda: now[0]):
            self.error('timeout', timeout=1)
        self.assertTrue(self.used[-1].closed)
        self.assertEqual(self.used[-1].response.reads, 0)

    def test_timeout_network_exception_sanitized_and_no_retry(self):
        for error, code in [(TimeoutError(KEY), 'timeout'), (OSError(KEY), 'network_error')]:
            self.response()
            self.connections[0].error = error
            self.error(code)
            self.assertTrue(self.used[-1].closed)



class FieldLimitTests(unittest.TestCase):
    """Adapter header limits must never be tighter than cloud_asr preflight."""

    def test_credential_limits_match_preflight_not_1024(self):
        self.assertEqual(m._field({'api_key': 'K' * 1025}, 'api_key', cloud, 8192), 'K' * 1025)
        self.assertEqual(m._field({'app_id': 'A' * 1025}, 'app_id', cloud), 'A' * 1025)
        self.assertEqual(m._field({'region': 'R' * 2048}, 'region', cloud), 'R' * 2048)
        for name, value, limit in (('api_key', 'K' * 8193, 8192), ('app_id', 'A' * 2049, 2048),
                                   ('app_id', 'has space', 2048), ('region', '', 2048)):
            with self.subTest(name=name, length=len(value)):
                try:
                    m._field({name: value}, name, cloud, limit)
                except cloud.CloudASRError as exc:
                    self.assertEqual(exc.code, 'invalid_config')
                else:
                    self.fail('expected invalid_config')


if __name__ == '__main__':
    unittest.main()
