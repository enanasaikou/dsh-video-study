"""Pure fake-network Tencent tests; NOT real service contract acceptance."""
import base64
import copy
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from test_cloud_asr import Connection, Response, FAKE_AUDIO, KEY, m as cloud

SPEC = importlib.util.spec_from_file_location('test_native_tencent', Path(__file__).parents[1] / 'python' / 'tencent_asr.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
APP_ID = 'FAKE_PUBLIC_TENCENT_SECRET_ID'
TASK_ID = 1234567890123


def envelope(data): return {'Response': {'Data': data, 'RequestId': 'never-return-id'}}
def created(): return envelope({'TaskId': TASK_ID})
def pending(): return envelope({'TaskId': TASK_ID, 'Status': 1})
def good():
    return envelope({'TaskId': TASK_ID, 'Status': 2, 'AudioDuration': 2.5,
                     'Result': 'must not parse synthetic timestamps',
                     'ResultDetail': [{'StartMs': 100, 'EndMs': 1200, 'FinalSentence': ' first ',
                                       'Words': [{'OffsetStartMs': 9000, 'OffsetEndMs': 9999}]},
                                      {'StartMs': 1300, 'EndMs': 2500, 'FinalSentence': 'second'}]})


class Tests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='fake-tencent-asr-')
        self.addCleanup(temporary.cleanup)
        self.audio = Path(temporary.name) / 'PRIVATE_TITLE.m4a'
        self.audio.write_bytes(FAKE_AUDIO)
        self.config = dict(scheme='https', host='tc-custom.example.invalid', port=443,
                           path='/custom/full/asr', proxy=None, model='16k_zh', api_key=KEY,
                           app_id=APP_ID, resource_id='', region='ap-guangzhou',
                           language='auto', timeout=30, max_bytes=100_000_000, warnings=[])
        self.connections = [Connection(Response(created())), Connection(Response(good()))]
        self.used = []
        self.addCleanup(patch.stopall)
        self.https = patch.object(cloud.http.client, 'HTTPSConnection', side_effect=self.connect).start()
        self.http = patch.object(cloud.http.client, 'HTTPConnection', side_effect=AssertionError('firewall HTTP')).start()
        patch.object(cloud.ssl, 'create_default_context', return_value=object()).start()
        self.firewall = patch.object(socket, 'create_connection', side_effect=AssertionError('firewall socket')).start()
        patch.object(socket.socket, 'connect', side_effect=AssertionError('firewall connect')).start()
        self.sleep = patch.object(m.time, 'sleep').start()
        patch.object(m.time, 'time', return_value=1551113065).start()

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

    def responses(self, *payloads):
        self.connections = [Connection(item if isinstance(item, Response) else Response(item)) for item in payloads]

    def test_inline_data_submit_once_same_custom_endpoint_and_true_milliseconds(self):
        self.responses(created(), pending(), good())
        result = self.invoke()
        self.assertEqual(len(self.used), 3)
        self.assertEqual([c.headers['X-TC-Action'] for c in self.used],
                         ['CreateRecTask', 'DescribeTaskStatus', 'DescribeTaskStatus'])
        for connection in self.used:
            self.assertEqual(connection.request[:2], ('POST', '/custom/full/asr'))
            self.assertTrue(connection.request[2]['skip_host'])
            self.assertEqual(connection.headers['Host'], 'tc-custom.example.invalid')
            self.assertEqual(connection.headers['X-TC-Region'], 'ap-guangzhou')
            self.assertEqual(connection.headers['X-TC-Version'], '2019-06-14')
            self.assertEqual(connection.headers['X-TC-Timestamp'], '1551113065')
            self.assertTrue(connection.closed)
            self.assertNotIn(KEY, json.dumps(connection.headers))
            body = b''.join(connection.sent)
            self.assertEqual(int(connection.headers['Content-Length']), len(body))
            self.assertNotIn(b'PRIVATE_TITLE', body)
            self.assertNotIn(KEY.encode(), body)
            self.assertNotIn(APP_ID.encode(), body)
        body = json.loads(b''.join(self.used[0].sent))
        self.assertEqual(body['SourceType'], 1)
        self.assertEqual(body['ResTextFormat'], 3)
        self.assertEqual(body['ChannelNum'], 1)
        self.assertEqual(body['EngineModelType'], '16k_zh')
        self.assertEqual(body['DataLen'], len(FAKE_AUDIO))
        self.assertEqual(base64.b64decode(body['Data']), FAKE_AUDIO)
        self.assertNotIn('Url', body)
        self.assertEqual(json.loads(b''.join(self.used[1].sent)), {'TaskId': TASK_ID})
        self.assertEqual(result['segments'][0], {'start': .1, 'end': 1.2, 'text': 'first'})
        self.assertEqual(result['info'], {'duration': 2.5, 'language': None})
        self.assertEqual(result['engine'], 'tencent_rec_task')
        self.assertEqual(result['response_format'], 'result_detail_json')
        self.sleep.assert_called_once_with(1.0)
        for item in (KEY, APP_ID, str(TASK_ID), 'never-return-id', 'synthetic', self.config['host']):
            self.assertNotIn(item, json.dumps(result))
        self.firewall.assert_not_called()
        self.http.assert_not_called()

    def test_cloud_route_runs_validated_native_adapter_and_explicit_proxy(self):
        result = cloud.transcribe_cloud(self.audio, endpoint='https://tc-custom.example.invalid/custom/full/asr',
            api_key=KEY, model='16k_zh', language='auto', upload_consent=True,
            protocol='tencent_rec_task', app_id=APP_ID, region='ap-guangzhou',
            proxy='http://proxy.example.invalid:8080')
        self.assertEqual(result['engine'], 'tencent_rec_task')
        self.assertEqual(self.used[0].tunnel, ('tc-custom.example.invalid', 443, {}))
        self.assertEqual(self.https.call_args.args[:2], ('proxy.example.invalid', 8080))
        self.assertEqual(self.used[0].headers['Host'], 'tc-custom.example.invalid')

    def test_audio_identity_checked_before_network_and_deadline_includes_send(self):
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
        self.audio.write_bytes(FAKE_AUDIO)
        now = [10.0]
        def send(_): now[0] = 100.0
        self.connections[0].on_send = send
        with patch.object(cloud.time, 'monotonic', side_effect=lambda: now[0]):
            self.error('timeout', timeout=1)
        self.assertEqual(len(self.used), 1)
        self.assertEqual(self.used[0].response.reads, 0)
        self.assertTrue(self.used[0].closed)

    def test_tc3_signature_independently_recomputed_over_actual_bytes_path_host_and_action(self):
        self.invoke(port=8443)
        for connection in self.used:
            body = b''.join(connection.sent)
            action = connection.headers['X-TC-Action'].lower()
            host = connection.headers['Host']
            self.assertEqual(host, 'tc-custom.example.invalid:8443')
            signed = 'content-type;host;x-tc-action'
            canonical = '\n'.join(('POST', '/custom/full/asr', '',
                'content-type:application/json; charset=utf-8\nhost:' + host + '\nx-tc-action:' + action + '\n',
                signed, hashlib.sha256(body).hexdigest()))
            scope = '2019-02-25/asr/tc3_request'
            to_sign = '\n'.join(('TC3-HMAC-SHA256', '1551113065', scope,
                                 hashlib.sha256(canonical.encode()).hexdigest()))
            key = ('TC3' + KEY).encode()
            for component in ('2019-02-25', 'asr', 'tc3_request'):
                key = hmac.digest(key, component.encode(), 'sha256')
            expected = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
            self.assertEqual(connection.headers['Authorization'],
                'TC3-HMAC-SHA256 Credential=' + APP_ID + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + expected)

    def test_ipv6_host_signing_and_optional_region(self):
        config = dict(self.config, host='2001:db8::1', region='')
        m.transcribe(self.audio, config, cloud)
        self.assertEqual(self.used[0].headers['Host'], '[2001:db8::1]')
        self.assertNotIn('X-TC-Region', self.used[0].headers)

    def test_custom_model_passed_without_fake_whitelist(self):
        self.invoke(model='custom-timed-model')
        self.assertEqual(json.loads(b''.join(self.used[0].sent))['EngineModelType'], 'custom-timed-model')

    def test_validated_opaque_models_preserve_spaces_unicode_and_64kib(self):
        for model in (' custom model 模型 v1 ', '模型 with spaces ' * 200, '模' * 21845 + 'x'):
            with self.subTest(model_bytes=len(model.encode('utf-8'))):
                self.responses(created(), good())
                result = cloud.transcribe_cloud(self.audio,
                    endpoint='https://tc-custom.example.invalid/custom/full/asr',
                    api_key=KEY, model=model, language='auto', upload_consent=True,
                    protocol='tencent_rec_task', app_id=APP_ID)
                self.assertEqual(json.loads(b''.join(self.used[-2].sent))['EngineModelType'], model)
                self.assertEqual(result['provider_model'], model)

    def test_documented_untimed_models_rejected_before_upload(self):
        for model in ('16k_ja', '16k_multi_lang', '16k_zh_medical'):
            self.error('unsupported_timestamp', model=model)
        self.https.assert_not_called()

    def test_invalid_credentials_plaintext_and_static_size_limit_before_network(self):
        for changes, code in [({'app_id': ''}, 'invalid_config'), ({'api_key': ''}, 'invalid_config'),
                              ({'region': 'x\r\ny'}, 'invalid_config'), ({'scheme': 'http'}, 'insecure_endpoint'),
                              ({'max_bytes': 1}, 'size_limit')]:
            self.error(code, **changes)
        with patch.object(m, 'MAX_AUDIO_BYTES', len(FAKE_AUDIO) - 1):
            self.error('size_limit')
        self.https.assert_not_called()

    def test_redirect_and_http_errors_never_retried(self):
        for status, code in [(302, 'redirect_rejected'), (401, 'authentication_failed'),
                             (403, 'access_denied'), (429, 'rate_limited'), (413, 'request_too_large')]:
            self.responses(Response({}, status=status, headers={'Location': 'https://evil.invalid/'}))
            before = len(self.used)
            self.error(code)
            self.assertEqual(len(self.used), before + 1)
            self.assertTrue(self.used[-1].closed)

    def test_api_error_messages_are_sanitized_and_create_not_retried(self):
        for code, expected in [('AuthFailure.SignatureFailure', 'authentication_failed'),
                               ('RequestLimitExceeded', 'rate_limited'), ('InternalError', 'provider_error')]:
            self.responses({'Response': {'Error': {'Code': code, 'Message': 'REMOTE PRIVATE DETAIL'}}})
            before = len(self.used)
            self.error(expected)
            self.assertEqual(len(self.used), before + 1)
            self.assertTrue(self.used[-1].closed)

    def test_task_id_and_state_validation_and_failure_no_resubmit(self):
        for bad in (None, False, 0, -1, '123', 2 ** 64):
            self.responses(envelope({'TaskId': bad}))
            self.error('invalid_response')
        for data, code in [({'TaskId': TASK_ID + 1, 'Status': 2}, 'invalid_response'),
                           ({'TaskId': TASK_ID, 'Status': True}, 'invalid_response'),
                           ({'TaskId': TASK_ID, 'Status': 5}, 'invalid_response'),
                           ({'TaskId': TASK_ID, 'Status': 3, 'ErrorMsg': KEY}, 'invalid_response'),
                           ({'TaskId': TASK_ID, 'Status': 3, 'ErrorMsg': 'private'}, 'task_failed')]:
            self.responses(created(), envelope(data))
            self.error(code)

    def test_missing_result_detail_never_parses_result_text(self):
        for details in (None, [], 'text'):
            payload = good()
            payload['Response']['Data']['ResultDetail'] = details
            self.responses(created(), payload)
            self.error('unsupported_timestamp')

    def test_bad_true_timestamp_fields_rejected(self):
        for start, end in [(-1, 100), (False, 100), (0.1, 100), (100, 100), (1, 2600), (1, '100')]:
            payload = good()
            payload['Response']['Data']['ResultDetail'][0].update(StartMs=start, EndMs=end)
            self.responses(created(), payload)
            self.error('invalid_timestamps')
        payload = good()
        payload['Response']['Data']['ResultDetail'][1]['StartMs'] = 1199
        self.responses(created(), payload)
        self.error('invalid_timestamps')

    def test_missing_duration_not_fabricated_and_secret_echo_denied(self):
        payload = good()
        del payload['Response']['Data']['AudioDuration']
        self.responses(created(), payload)
        self.assertIsNone(self.invoke()['info']['duration'])
        for secret in (KEY, APP_ID):
            payload = good()
            payload['Response']['Data']['ResultDetail'][0]['FinalSentence'] = secret
            self.responses(created(), payload)
            self.error('invalid_response')

    def test_response_and_cumulative_poll_bytes_are_bounded(self):
        self.responses(Response(created(), headers={'Content-Length': str(cloud.MAX_RESPONSE_BYTES + 1)}))
        self.error('response_too_large')
        payloads = [created(), pending(), good()]
        maximum = max(len(json.dumps(item).encode()) for item in payloads)
        # Each response individually fits, the cumulative response budget does not.
        self.responses(*payloads)
        with patch.object(cloud, 'MAX_RESPONSE_BYTES', maximum):
            self.error('response_too_large')

    def test_monotonic_deadline_includes_pending_sleep_and_prevents_resubmission(self):
        now = [10.0]
        self.responses(created(), pending())
        def sleep(seconds): now[0] += seconds
        self.sleep.side_effect = sleep
        with patch.object(cloud.time, 'monotonic', side_effect=lambda: now[0]):
            self.error('timeout', timeout=.5)
        self.assertEqual([item.headers['X-TC-Action'] for item in self.used], ['CreateRecTask', 'DescribeTaskStatus'])
        self.assertTrue(all(item.closed for item in self.used))
        self.sleep.assert_called_with(.5)
        self.assertEqual(now[0], 10.5)  # Not a full poll interval beyond deadline.

    def test_more_than_1000_seconds_can_succeed_with_full_3600_second_budget(self):
        now = [10.0]
        self.responses(created(), *[pending() for _ in range(1001)], good())
        def sleep(seconds): now[0] += seconds
        self.sleep.side_effect = sleep
        with patch.object(cloud.time, 'monotonic', side_effect=lambda: now[0]):
            result = self.invoke(timeout=3600)
        self.assertTrue(result['segments'])
        self.assertEqual(now[0], 1011.0)
        self.assertEqual(self.sleep.call_count, 1001)
        self.assertEqual(len(self.used), 1003)
        self.assertEqual(sum(item.headers['X-TC-Action'] == 'CreateRecTask' for item in self.used), 1)

    def test_poll_count_is_derived_from_timeout_even_with_frozen_fake_clock(self):
        self.responses(created(), pending(), pending())
        with patch.object(cloud.time, 'monotonic', return_value=10.0):
            self.error('timeout', timeout=1)
        self.assertEqual(len(self.used), 3)  # ceil(1 / 1) + 1 polls, plus create.

    def test_network_exception_sanitized_and_no_automatic_resubmit(self):
        for exception, code in [(OSError(KEY), 'network_error'), (TimeoutError(KEY), 'timeout')]:
            self.responses(created())
            self.connections[0].error = exception
            before = len(self.used)
            self.error(code)
            self.assertEqual(len(self.used), before + 1)
            self.assertTrue(self.used[-1].closed)

    def test_invalid_json_encoding_and_length_rejected(self):
        for response in (Response(b'{bad'), Response(b'{"x":NaN}'),
                         Response(created(), headers={'Content-Encoding': 'gzip'}),
                         Response(created(), headers={'Content-Length': '1'})):
            self.responses(response)
            self.error('invalid_response')



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
