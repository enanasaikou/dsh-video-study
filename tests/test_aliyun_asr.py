"""Offline fake-network protocol/security regression: no real media or credentials."""
import copy
import http.client
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_cloud_asr import Connection, Response, FAKE_AUDIO, KEY

SPEC = importlib.util.spec_from_file_location('aliyun_test_cloud', Path(__file__).parents[1] / 'python' / 'cloud_asr.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription'
UPLOAD = 'https://dashscope-file.oss-cn-beijing.aliyuncs.com'
RESULT = ('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/pre/filetrans-16k/20260901/15%3A11/result.json'
          '?Expires=1999999999&OSSAccessKeyId=FAKE_OSS_RESULT_KEY&Signature=FAKE%2BSIGNATURE%3D')
TASK_ID = '00000000-0000-0000-0000-000000000001'


def policy(**changes):
    data = dict(upload_host=UPLOAD, upload_dir='dashscope-instant/fake/2026-09-01',
                oss_access_key_id='FAKE_OSS_UPLOAD_KEY', signature='FAKE_UPLOAD_SIGNATURE',
                policy='FAKE_POLICY_BASE64', x_oss_object_acl='private', x_oss_forbid_overwrite='true')
    data.update(changes)
    return {'data': data}


def task(status='PENDING', **changes):
    output = dict(task_id=TASK_ID, task_status=status)
    if status == 'SUCCEEDED':
        output['results'] = [dict(subtask_status='SUCCEEDED', transcription_url=RESULT, file_url='oss://fake-private-object')]
    output.update(changes)
    return {'output': output}


def transcript(**changes):
    obj = dict(properties={'original_duration_in_milliseconds': 2501},
               transcripts=[dict(channel_id=0, text='untrusted full text NOT used', sentences=[
                   dict(begin_time=1, end_time=1250, text=' first '),
                   dict(begin_time=1250, end_time=2501, text='second')])])
    obj.update(changes)
    return obj


class AliyunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='aliyun-asr-offline-')
        self.addCleanup(self.tmp.cleanup)
        self.audio = Path(self.tmp.name) / 'PRIVATE_LOCAL_FILENAME.m4a'
        self.audio.write_bytes(FAKE_AUDIO)
        self.config = dict(endpoint=ENDPOINT, api_key=KEY, model='paraformer-v2', language='en', upload_consent=True)
        self.connections = []
        self.responses = []
        self.sequence()
        self.addCleanup(patch.stopall)
        self.https = patch.object(m.http.client, 'HTTPSConnection', side_effect=self.connect).start()
        self.http = patch.object(m.http.client, 'HTTPConnection', side_effect=AssertionError('HTTP forbidden')).start()
        patch.object(m.ssl, 'create_default_context', return_value=object()).start()
        self.sleep = patch.object(m.time, 'sleep').start()

    def sequence(self, *responses):
        self.responses = list(responses) or [Response(policy()), Response(b''), Response(task()),
                                            Response(task('SUCCEEDED')), Response(transcript())]

    def connect(self, *args, **kwargs):
        if not self.responses:
            raise AssertionError('unexpected network request / retry')
        conn = Connection(self.responses.pop(0))
        conn.destination = args[:2]
        self.connections.append(conn)
        return conn

    def invoke(self, **changes):
        return m.transcribe_cloud(self.audio, **dict(self.config, **changes))

    def code(self, expected, function=None, **changes):
        with self.assertRaises(m.CloudASRError) as caught:
            (function or self.invoke)(**changes)
        self.assertEqual(caught.exception.code, expected)
        message = str(caught.exception)
        for secret in (KEY, ENDPOINT, UPLOAD, RESULT, TASK_ID, 'FAKE_UPLOAD_SIGNATURE', 'FAKE_OSS_UPLOAD_KEY'):
            self.assertNotIn(secret, message)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(all(conn.closed for conn in self.connections))

    def test_preflight_static_engine_format_all_api_origins_and_opaque_models(self):
        for host in ('dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'workspace-123.cn-beijing.maas.aliyuncs.com'):
            cfg = dict(self.config, endpoint='https://' + host + '/api/v1/services/audio/asr/transcription')
            with patch.object(m, 'Path', side_effect=AssertionError('must not read files')):
                state = m.validate_cloud_config(cfg)
            self.assertEqual(state['engine'], 'aliyun_paraformer')
            self.assertEqual(state['response_format'], 'sentences_json')
            self.assertEqual(state['model'], 'paraformer-v2')
            self.assertIn('48', ''.join(state['warnings']))
            self.assertIn('远端任务可能继续', ''.join(state['warnings']))
            self.assertNotIn(host, json.dumps(state))
        for model in ('whisper-1', 'paraformer-v1', 'paraformer-8k-v2', '中文 模型', 'x' * 101):
            with patch.object(m, 'Path', side_effect=AssertionError('must not read files')):
                state = m.validate_cloud_config(dict(self.config, model=model))
            self.assertEqual(state['model'], model)
        self.https.assert_not_called()

    def test_native_endpoint_cannot_escape_to_other_hosts_ports_paths_or_http(self):
        path = '/api/v1/services/audio/asr/transcription'
        for endpoint in ('https://evil.invalid' + path, 'http://dashscope.aliyuncs.com' + path,
                         'https://dashscope.aliyuncs.com:444' + path,
                         'https://dashscope.aliyuncs.com.evil.invalid' + path,
                         'https://dashscope.aliyuncs.com.' + path,
                         'https://a.b.cn-beijing.maas.aliyuncs.com' + path,
                         ENDPOINT + '/', ENDPOINT + '?', ENDPOINT + '#',
                         'https://user:pass@dashscope.aliyuncs.com' + path,
                         'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/%74ranscription'):
            with self.subTest(endpoint=endpoint):
                self.code('invalid_endpoint', endpoint=endpoint)
        self.https.assert_not_called()

    def test_complete_protocol_sequence_timestamp_units_and_secret_isolation(self):
        result = self.invoke()
        self.assertEqual([c.request[:2] for c in self.connections], [
            ('GET', '/api/v1/uploads?action=getPolicy&model=paraformer-v2'), ('POST', '/'),
            ('POST', '/api/v1/services/audio/asr/transcription'), ('GET', '/api/v1/tasks/' + TASK_ID),
            ('GET', RESULT.split('.com', 1)[1])])
        for i, conn in enumerate(self.connections):
            self.assertEqual(conn.headers.get('Authorization'), 'Bearer ' + KEY if i in (0, 2, 3) else None)
            self.assertEqual(conn.headers['Accept-Encoding'], 'identity')
            self.assertTrue(conn.closed)
            self.assertIsNone(conn.tunnel)
        upload = self.connections[1]
        sent = b''.join(upload.sent)
        self.assertEqual(int(upload.headers['Content-Length']), len(sent))
        self.assertIn(FAKE_AUDIO, sent)
        self.assertIn(b'FAKE_OSS_UPLOAD_KEY', sent)
        self.assertIn(b'FAKE_UPLOAD_SIGNATURE', sent)
        self.assertNotIn(KEY.encode(), sent)
        self.assertNotIn(b'PRIVATE_LOCAL_FILENAME', sent)
        self.assertEqual(upload.response.reads, 0)
        submitted = self.connections[2]
        body = json.loads(b''.join(submitted.sent))
        self.assertEqual(body['model'], 'paraformer-v2')
        self.assertEqual(body['parameters'], {'channel_id': [0], 'language_hints': ['en']})
        self.assertEqual(len(body['input']['file_urls']), 1)
        self.assertTrue(body['input']['file_urls'][0].startswith('oss://dashscope-instant/fake/2026-09-01/audio-'))
        self.assertEqual(submitted.headers['X-DashScope-Async'], 'enable')
        self.assertEqual(submitted.headers['X-DashScope-OssResourceResolve'], 'enable')
        self.assertEqual(result['engine'], 'aliyun_paraformer')
        self.assertEqual(result['response_format'], 'sentences_json')
        self.assertEqual(result['segments'], [dict(start=.001, end=1.25, text='first'), dict(start=1.25, end=2.501, text='second')])
        self.assertEqual(result['info'], {'duration': 2.501, 'language': None})
        for private in (KEY, RESULT, TASK_ID, UPLOAD, 'FAKE_OSS_UPLOAD_KEY', 'FAKE_UPLOAD_SIGNATURE', 'oss://'):
            self.assertNotIn(private, json.dumps(result))
        self.assertEqual(self.audio.read_bytes(), FAKE_AUDIO)
        self.assertEqual(list(self.audio.parent.iterdir()), [self.audio])

    def test_explicit_custom_origin_route_and_model_are_not_allowlisted_or_overwritten(self):
        model = '中文/custom model&query'
        result = self.invoke(protocol='dashscope_paraformer', endpoint='https://custom.invalid:8443/arbitrary/transcribe', model=model)
        self.assertEqual(result['provider_model'], model)
        self.assertEqual(self.connections[0].request[:2], ('GET', '/api/v1/uploads?action=getPolicy&model=%E4%B8%AD%E6%96%87%2Fcustom%20model%26query'))
        self.assertEqual(self.connections[2].request[:2], ('POST', '/arbitrary/transcribe'))
        self.assertEqual(json.loads(b''.join(self.connections[2].sent))['model'], model)
        for i in (0, 2, 3):
            self.assertEqual(self.connections[i].destination, ('custom.invalid', 8443))
            self.assertEqual(self.connections[i].headers['Authorization'], 'Bearer ' + KEY)
        for i in (1, 4):
            self.assertNotIn('Authorization', self.connections[i].headers)

    def test_custom_api_matching_storage_host_different_port_does_not_leak_key(self):
        result_host = 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com'
        self.invoke(protocol='dashscope_paraformer', endpoint='https://' + result_host + ':8443/custom')
        self.assertEqual(self.connections[4].destination, (result_host, 443))
        self.assertNotIn('Authorization', self.connections[4].headers)

    def test_same_origin_custom_api_and_oss_never_share_main_key_by_origin_alone(self):
        # All five requests use the exact same TLS origin, not merely the same
        # host with different ports. Only explicit API roles may receive a key.
        host = 'dashscope-file.oss-cn-beijing.aliyuncs.com'
        same_origin_result = RESULT.replace('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', host)
        self.sequence(Response(policy()), Response(b''), Response(task()),
                      Response(task('SUCCEEDED', results=[dict(subtask_status='SUCCEEDED', transcription_url=same_origin_result)])),
                      Response(transcript()))
        self.invoke(protocol='dashscope_paraformer', endpoint='https://' + host + '/custom-api')
        self.assertEqual(len(self.connections), 5)
        for i, conn in enumerate(self.connections):
            self.assertEqual(conn.destination, (host, 443))
            self.assertTrue(conn.closed)
            if i in (0, 2, 3):
                self.assertEqual(conn.headers.get('Authorization'), 'Bearer ' + KEY)
            else:
                self.assertNotIn('Authorization', conn.headers)
                self.assertNotIn(KEY.encode(), b''.join(conn.sent))

    def test_explicit_singapore_region_with_custom_api_keeps_auxiliary_oss_region_bound(self):
        sg = RESULT.replace('oss-cn-beijing', 'oss-ap-southeast-1')
        self.sequence(Response(policy(upload_host=UPLOAD.replace('oss-cn-beijing', 'oss-ap-southeast-1'))),
                      Response(b''), Response(task()), Response(task('SUCCEEDED', results=[dict(subtask_status='SUCCEEDED', transcription_url=sg)])),
                      Response(transcript()))
        self.invoke(protocol='dashscope_paraformer', endpoint='https://custom.invalid/private-asr', region='ap-southeast-1')
        self.assertEqual(self.connections[0].destination, ('custom.invalid', 443))
        self.assertEqual(self.connections[1].destination, ('dashscope-file.oss-ap-southeast-1.aliyuncs.com', 443))
        self.assertNotIn('Authorization', self.connections[1].headers)
        self.assertNotIn('Authorization', self.connections[4].headers)

    def test_auto_omits_language_hint_not_translation_or_multiple_charged_channels(self):
        self.invoke(language='auto')
        body = json.loads(b''.join(self.connections[2].sent))
        self.assertEqual(body['parameters'], {'channel_id': [0]})
        self.assertNotIn('translate', str(body))

    def test_singapore_requires_matching_region_and_keeps_key_on_original_api_host(self):
        sg = RESULT.replace('oss-cn-beijing', 'oss-ap-southeast-1')
        self.sequence(Response(policy(upload_host=UPLOAD.replace('oss-cn-beijing', 'oss-ap-southeast-1'))),
                      Response(b''), Response(task()),
                      Response(task('SUCCEEDED', results=[dict(subtask_status='SUCCEEDED', transcription_url=sg)])),
                      Response(transcript()))
        self.invoke(endpoint=ENDPOINT.replace('dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'))
        self.assertEqual(self.connections[0].destination, ('dashscope-intl.aliyuncs.com', 443))
        self.assertEqual(self.connections[3].destination, ('dashscope-intl.aliyuncs.com', 443))
        self.assertEqual(self.connections[4].destination, ('dashscope-result-bj.oss-ap-southeast-1.aliyuncs.com', 443))

    def test_workspace_domain_never_sends_key_to_default_api_domain(self):
        host = 'workspace-123.cn-beijing.maas.aliyuncs.com'
        self.invoke(endpoint=ENDPOINT.replace('dashscope.aliyuncs.com', host))
        for i in (0, 2, 3):
            self.assertEqual(self.connections[i].destination, (host, 443))

    def test_explicit_http_proxy_used_for_every_tls_origin_without_connect_auth(self):
        self.invoke(proxy='http://127.0.0.1:7897')
        for conn in self.connections:
            self.assertEqual(conn.destination, ('127.0.0.1', 7897))
            self.assertEqual(conn.tunnel[1:], (443, {}))
        self.assertEqual(self.connections[1].tunnel[0], 'dashscope-file.oss-cn-beijing.aliyuncs.com')
        self.assertNotIn('Authorization', self.connections[1].headers)
        self.assertNotIn('Authorization', self.connections[4].headers)

    def test_consent_config_audio_and_size_rejected_before_policy_network(self):
        with patch.object(m, 'Path', side_effect=AssertionError('file access forbidden')):
            self.code('upload_consent_required', upload_consent=False)
            self.code('invalid_model', model='invalid\r\nHEADER')
        self.code('size_limit', max_bytes=3)
        self.audio.write_bytes(b'')
        self.code('audio_invalid')
        self.https.assert_not_called()

    def test_storage_upload_url_attacks_rejected_before_audio_bytes(self):
        bad = ['http://dashscope-file.oss-cn-beijing.aliyuncs.com', 'https://127.0.0.1/',
               'https://dashscope.aliyuncs.com/', UPLOAD + '.evil.invalid', UPLOAD + '.',
               UPLOAD + ':443', UPLOAD + '/object', UPLOAD + '?', UPLOAD + '?Signature=x', UPLOAD + '#',
               UPLOAD.replace('https://', 'https://user:pass@'),
               UPLOAD.replace('oss-cn-beijing', 'oss-ap-southeast-1'),
               UPLOAD.replace('oss-cn-beijing', 'oss-cn-beijing-internal'),
               UPLOAD + '\\@evil.invalid', UPLOAD + '/%0d%0aInjected:yes', UPLOAD + '\n']
        for url in bad:
            with self.subTest(url=url):
                self.connections.clear()
                self.sequence(Response(policy(upload_host=url)))
                self.code('unsafe_provider_url')
                self.assertEqual(len(self.connections), 1)
                self.assertFalse(self.connections[0].sent)

    def test_storage_result_url_attacks_never_receive_authorization_or_get_followed(self):
        host = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com'
        signed = '?Expires=1999999999&OSSAccessKeyId=FAKE&Signature=FAKE'
        bad = ['http://evil.invalid/result.json', 'https://127.0.0.1/result.json',
               RESULT.replace('.aliyuncs.com', '.aliyuncs.com.evil.invalid'),
               RESULT.replace('https://', 'https://user:pass@'),
               RESULT.replace('.aliyuncs.com/', '.aliyuncs.com:443/'),
               RESULT.replace('oss-cn-beijing', 'oss-ap-southeast-1'),
               host + '/a/../result.json' + signed, host + '/%2e%2e/result.json' + signed,
               host + '/a%2fb/result.json' + signed, host + '/a%5cb/result.json' + signed,
               host + '/%252e%252e/result.json' + signed, host + '//result.json' + signed,
               host + '/%00/result.json' + signed, host + '/%xy/result.json' + signed,
               host + '/result.json' + signed + '&redirect=https%3A%2F%2Fevil.invalid',
               RESULT + '&Signature=duplicate', RESULT + '#x',
               host + '/result.json?Expires=1&OSSAccessKeyId=k&Signature=x%0d%0aInjected',
               host + '/result.json?Expires=1&OSSAccessKeyId=k&Signature=%00',
               host + '/result.json?Expires=1&OSSAccessKeyId=k&Signature=%2',
               host + '/result.json', host + '/result.txt' + signed]
        for url in bad:
            with self.subTest(url=url):
                self.connections.clear()
                self.sequence(Response(policy()), Response(b''), Response(task()),
                              Response(task('SUCCEEDED', results=[dict(subtask_status='SUCCEEDED', transcription_url=url)])))
                self.code('unsafe_provider_url')
                self.assertEqual(len(self.connections), 4)

    def test_each_redirect_stops_without_reading_body_following_or_retrying(self):
        for index in range(5):
            for status in (301, 302, 303, 307, 308):
                with self.subTest(stage=index, status=status):
                    self.connections.clear()
                    self.sequence()
                    error_response = Response((KEY + RESULT).encode(), status=status, headers={'Location': 'https://evil.invalid/' + KEY})
                    self.responses[index] = error_response
                    self.code('redirect_rejected')
                    self.assertEqual(len(self.connections), index + 1)
                    self.assertEqual(error_response.reads, 0)

    def test_status_or_transport_failure_never_resubmits_chargeable_request(self):
        for index in range(5):
            for status, expected in ((401, 'authentication_failed'), (403, 'access_denied'),
                                     (429, 'rate_limited'), (500, 'provider_error'), (413, 'request_too_large')):
                with self.subTest(index=index, status=status):
                    self.connections.clear()
                    self.sequence()
                    error = Response((KEY + RESULT).encode(), status=status)
                    self.responses[index] = error
                    self.code(expected)
                    self.assertEqual(len(self.connections), index + 1)
                    self.assertEqual(error.reads, 0)
        self.connections.clear()
        self.sequence()
        original = self.connect
        def network_failure(*args, **kwargs):
            conn = original(*args, **kwargs)
            if len(self.connections) == 3:
                conn.error = OSError(KEY + RESULT)
            return conn
        self.https.side_effect = network_failure
        self.code('network_error')
        self.assertEqual(len(self.connections), 3)

    def test_task_terminal_failure_and_subtask_failure_are_safe(self):
        for output in (task('FAILED'), task('CANCELED'), task('UNKNOWN'),
                       task('SUCCEEDED', results=[dict(subtask_status='FAILED', message=KEY + RESULT)])):
            self.connections.clear()
            self.sequence(Response(policy()), Response(b''), Response(task()), Response(output))
            # Key echoes in ANY response are rejected even if it also reports failure.
            self.code('invalid_response' if KEY in json.dumps(output) else 'task_failed')
            self.assertEqual(len(self.connections), 4)

    def test_task_id_path_injection_and_mismatched_task_id_rejected(self):
        for output in (task(task_id='../other'), task(task_id='id?key=x'), task(task_id='id\r\nHeader:x')):
            self.connections.clear()
            self.sequence(Response(policy()), Response(b''), Response(output))
            self.code('invalid_response')
            self.assertEqual(len(self.connections), 3)
        self.connections.clear()
        self.sequence(Response(policy()), Response(b''), Response(task()), Response(task('RUNNING', task_id='other-task')))
        self.code('invalid_response')
        self.assertEqual(len(self.connections), 4)

    def test_pending_polling_cap_is_budget_derived_and_only_queries_are_repeated(self):
        # Even a broken clock/sleep fake cannot cause an unbounded polling loop.
        self.sequence(Response(policy()), Response(b''), Response(task()), *[Response(task('RUNNING')) for _ in range(4)])
        self.code('timeout', timeout=6)
        self.assertEqual(len(self.connections), 7)
        self.assertEqual(sum(c.request[:2] == ('POST', '/api/v1/services/audio/asr/transcription') for c in self.connections), 1)
        self.assertEqual(sum(c.request[0] == 'GET' and '/tasks/' in c.request[1] for c in self.connections), 4)
        self.assertEqual(self.sleep.call_count, 3)

    def test_long_running_task_can_succeed_after_six_minutes_within_total_budget(self):
        self.sequence(Response(policy()), Response(b''), Response(task()),
                      *[Response(task('RUNNING')) for _ in range(200)],
                      Response(task('SUCCEEDED')), Response(transcript()))
        clock = [0]
        self.sleep.side_effect = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            result = self.invoke(timeout=900)
        self.assertEqual(clock[0], 400)
        self.assertEqual(result['engine'], 'aliyun_paraformer')
        self.assertEqual(sum(c.request[:2] == ('POST', '/api/v1/services/audio/asr/transcription') for c in self.connections), 1)
        self.assertEqual(sum(c.request[0] == 'GET' and '/tasks/' in c.request[1] for c in self.connections), 201)
        self.assertTrue(all(call.args == (2,) for call in self.sleep.call_args_list))

    def test_poll_sleep_respects_remaining_deadline_and_timeout_never_resubmits(self):
        self.sequence(Response(policy()), Response(b''), Response(task()),
                      *[Response(task('RUNNING')) for _ in range(20)])
        clock = [0]
        self.sleep.side_effect = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            self.code('timeout', timeout=7)
        self.assertEqual(clock[0], 7)
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [2, 2, 2, 1])
        self.assertEqual(sum(c.request[:2] == ('POST', '/api/v1/services/audio/asr/transcription') for c in self.connections), 1)
        self.assertEqual(sum(c.request[0] == 'GET' and '/tasks/' in c.request[1] for c in self.connections), 4)

    def test_total_monotonic_budget_includes_policy_upload_task_poll_and_result(self):
        for stage in (0, 2, 3, 4):
            self.connections.clear()
            self.sequence()
            clock = [0]
            self.responses[stage].on_read = lambda: clock.__setitem__(0, clock[0] + 2)
            with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
                self.code('timeout', timeout=1)
            self.assertEqual(len(self.connections), stage + 1)
        self.connections.clear()
        self.sequence()
        clock = [0]
        original = self.connect
        def upload_timeout(*args, **kwargs):
            conn = original(*args, **kwargs)
            if len(self.connections) == 2:
                conn.on_send = lambda _: clock.__setitem__(0, clock[0] + 2)
            return conn
        self.https.side_effect = upload_timeout
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            self.code('timeout', timeout=1)
        self.assertEqual(len(self.connections), 2)

    def test_file_replaced_or_mutated_after_policy_or_while_uploading_aborts(self):
        self.responses[0].on_read = lambda: self.audio.write_bytes(FAKE_AUDIO + b'changed')
        self.code('audio_invalid')
        self.assertEqual(len(self.connections), 2)
        self.assertEqual(self.connections[1].sent, [])
        self.connections.clear()
        self.audio.write_bytes(FAKE_AUDIO)
        self.sequence()
        original = self.connect
        def mutate(*args, **kwargs):
            conn = original(*args, **kwargs)
            if len(self.connections) == 2:
                def on_send(chunk):
                    if chunk == FAKE_AUDIO:
                        with self.audio.open('ab') as file:
                            file.write(b'changed')
                conn.on_send = on_send
            return conn
        self.https.side_effect = mutate
        self.code('audio_invalid')
        self.assertEqual(len(self.connections), 2)
        self.assertEqual(self.connections[1].response.reads, 0)
        self.assertEqual(self.connections[1].sent[-1], FAKE_AUDIO)

    def test_audio_stream_is_bounded_and_not_rewritten(self):
        data = b'x' * (3 * m.CHUNK_BYTES + 7)
        self.audio.write_bytes(data)
        self.invoke()
        chunks = self.connections[1].sent[1:-1]
        self.assertEqual([len(c) for c in chunks], [m.CHUNK_BYTES] * 3 + [7])
        self.assertEqual(self.audio.read_bytes(), data)

    def test_response_limits_encoding_and_aggregate_bound(self):
        self.responses[0] = Response(policy(), headers={'Content-Length': str(m.MAX_RESPONSE_BYTES + 1)})
        self.code('response_too_large')
        self.assertEqual(self.connections[0].response.reads, 0)
        for headers in ({'Content-Type': 'text/html'}, {'Content-Encoding': 'gzip'}, {'Content-Length': '-1'}):
            self.connections.clear()
            self.sequence(Response(policy(), headers=headers))
            self.code('invalid_response')
        self.connections.clear()
        self.sequence()
        # Each response individually fits but the whole operation does not.
        limit = max(len(r.buffer.getvalue()) for i, r in enumerate(self.responses) if i != 1) + 1
        with patch.object(m, 'MAX_RESPONSE_BYTES', limit):
            self.code('response_too_large')

    def test_sentences_required_not_whole_transcript_or_words_fabricated_times(self):
        for obj in (dict(text='no timestamp'), transcript(transcripts=[]),
                    transcript(transcripts=[dict(channel_id=0, text='full transcript only')]),
                    transcript(transcripts=[dict(channel_id=1, sentences=[dict(begin_time=0, end_time=1, text='wrong channel')])])):
            self.connections.clear()
            self.sequence(Response(policy()), Response(b''), Response(task()), Response(task('SUCCEEDED')), Response(obj))
            self.code('unsupported_timestamp')

    def test_integer_ms_sentence_timestamps_order_and_source_duration_validated(self):
        for begin, end in ((-1, 100), (True, 100), (0, True), ('0', 100), (0, 1.5), (10, 10), (100, 10), (0, 2502)):
            self.connections.clear()
            obj = transcript(transcripts=[dict(channel_id=0, sentences=[dict(begin_time=begin, end_time=end, text='bad')])])
            self.sequence(Response(policy()), Response(b''), Response(task()), Response(task('SUCCEEDED')), Response(obj))
            self.code('invalid_timestamps')
        for duration in (True, 0, -1, 1.5, m.MAX_TIMESTAMP_MS + 1):
            self.connections.clear()
            self.sequence(Response(policy()), Response(b''), Response(task()), Response(task('SUCCEEDED')),
                          Response(transcript(properties={'original_duration_in_milliseconds': duration})))
            self.code('invalid_timestamps')
        self.connections.clear()
        obj = transcript()
        obj['transcripts'][0]['sentences'][1]['begin_time'] = 1249
        self.sequence(Response(policy()), Response(b''), Response(task()), Response(task('SUCCEEDED')), Response(obj))
        self.code('invalid_timestamps')

    def test_missing_duration_language_not_inferred_and_actual_language_mismatch_rejected(self):
        self.responses[-1] = Response(transcript(properties={}))
        result = self.invoke()
        self.assertEqual(result['info'], {'duration': None, 'language': None})
        self.connections.clear()
        self.sequence()
        self.responses[-1] = Response(transcript(language='zh'))
        self.code('language_mismatch')

    def test_no_private_key_policy_url_or_task_echo_can_enter_output_text(self):
        for text in (KEY, TASK_ID, RESULT, 'FAKE_UPLOAD_SIGNATURE', 'FAKE_OSS_UPLOAD_KEY', 'FAKE_POLICY_BASE64', UPLOAD,
                     'FAKE_OSS_RESULT_KEY', 'FAKE+SIGNATURE=', 'FAKE%2BSIGNATURE%3D'):
            self.connections.clear()
            obj = transcript()
            obj['transcripts'][0]['sentences'][0]['text'] = 'provider echo ' + text
            self.sequence(Response(policy()), Response(b''), Response(task()), Response(task('SUCCEEDED')), Response(obj))
            self.code('invalid_response')
            self.assertEqual(list(self.audio.parent.iterdir()), [self.audio])

    def test_short_api_key_is_usable_even_if_model_or_public_fields_contain_letter(self):
        state = m.validate_cloud_config(dict(self.config, api_key='a'))
        self.assertEqual(state['engine'], 'aliyun_paraformer')
        self.assertEqual(self.invoke(api_key='a')['engine'], 'aliyun_paraformer')
        self.assertEqual(self.connections[0].headers['Authorization'], 'Bearer a')
        self.assertNotIn('Authorization', self.connections[1].headers)

    def test_policy_fields_cannot_inject_multipart_or_weaken_private_upload(self):
        for changes in ({'signature': 'secret\r\nInjected:x'}, {'upload_dir': '../escape'},
                        {'upload_dir': 'a/../escape'}, {'upload_dir': 'a/%2e%2e'},
                        {'x_oss_object_acl': 'public-read'}, {'x_oss_forbid_overwrite': 'false'},
                        {'policy': 'x' * 16385}):
            self.connections.clear()
            self.sequence(Response(policy(**changes)))
            self.code('invalid_response')
            self.assertEqual(len(self.connections), 1)


    def test_filetrans_model_rejected_on_openai_compatible_route(self):
        self.code('protocol_model_mismatch', protocol='dashscope_qwen', endpoint=ENDPOINT,
                  model='qwen3-asr-flash-filetrans')
        self.assertEqual(self.connections, [])
        state = m.validate_cloud_config(dict(self.config, protocol='dashscope_paraformer', region='',
                                             model='qwen3-asr-flash-filetrans'))
        self.assertEqual(state['engine'], 'aliyun_paraformer')
        self.assertNotIn('所选模型未标明', ' '.join(state['warnings']))

    def test_qwen_filetrans_uses_single_file_url_and_output_result(self):
        relay = 'https://relay.example.com/api/v1/services/audio/asr/transcription'
        upload = 'https://dashscope-file.oss-cn-shanghai.aliyuncs.com'
        result_url = ('https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/pre/20260901/result.json'
                      '?Expires=1999999999&OSSAccessKeyId=FAKE_OSS_RESULT_KEY&Signature=FAKE%2BSIGNATURE%3D')
        self.sequence(Response(policy(upload_host=upload)), Response(b''),
                      Response({'output': dict(task_id=TASK_ID, task_status='PENDING')}),
                      Response({'output': dict(task_id=TASK_ID, task_status='SUCCEEDED',
                                               result=dict(transcription_url=result_url))}),
                      Response(transcript()))
        out = self.invoke(protocol='dashscope_paraformer', endpoint=relay, region='',
                          model='qwen3-asr-flash-filetrans')
        submitted = self.connections[2]
        body = json.loads(b''.join(submitted.sent))
        self.assertEqual(body['model'], 'qwen3-asr-flash-filetrans')
        self.assertEqual(body['parameters'], {'channel_id': [0], 'enable_itn': False, 'language': 'en'})
        self.assertEqual(list(body['input']), ['file_url'])
        self.assertTrue(body['input']['file_url'].startswith('oss://dashscope-instant/fake/2026-09-01/audio-'))
        self.assertEqual(submitted.destination, ('relay.example.com', 443))
        self.assertEqual(self.connections[1].destination, ('dashscope-file.oss-cn-shanghai.aliyuncs.com', 443))
        self.assertEqual(self.connections[4].destination, ('dashscope-result-sh.oss-cn-shanghai.aliyuncs.com', 443))
        self.assertEqual(out['engine'], 'aliyun_paraformer')
        self.assertEqual(out['response_format'], 'sentences_json')
        self.assertEqual(out['segments'], [dict(start=.001, end=1.25, text='first'), dict(start=1.25, end=2.501, text='second')])
        self.assertEqual(out['provider_model'], 'qwen3-asr-flash-filetrans')
        for private in (KEY, result_url, TASK_ID, upload, 'FAKE_OSS_RESULT_KEY'):
            self.assertNotIn(private, json.dumps(out))

    def filetrans_sequence(self, result_url):
        self.sequence(Response(policy()), Response(b''), Response(task()),
                      Response(task('SUCCEEDED', result=dict(transcription_url=result_url))),
                      Response(transcript()))

    def filetrans_invoke(self, **changes):
        return self.invoke(**dict(dict(protocol='dashscope_paraformer', region='',
                                      model='qwen3-asr-flash-filetrans'), **changes))

    def test_official_http_filetrans_result_uses_https443_without_plaintext_warning(self):
        insecure = RESULT.replace('https://', 'http://')
        self.filetrans_sequence(insecure)
        out = self.filetrans_invoke()
        fetched = self.connections[4]
        self.assertEqual(fetched.destination, ('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 443))
        self.assertEqual(fetched.request[:2], ('GET', RESULT.split('.com', 1)[1]))
        self.assertNotIn('Authorization', fetched.headers)
        self.assertNotIn('result_url_used_plain_http_from_provider', out['warnings'])
        self.assertEqual(len(self.connections), 5)
        self.assertEqual(self.https.call_count, 5)
        self.http.assert_not_called()
        for private in (KEY, insecure, RESULT, 'FAKE_OSS_RESULT_KEY', 'FAKE%2BSIGNATURE%3D'):
            self.assertNotIn(private, json.dumps(out))
        # The legacy Paraformer job keeps the stricter HTTPS-only result origin.
        self.connections.clear()
        self.sequence(Response(policy()), Response(b''), Response(task()),
                      Response(task('SUCCEEDED', results=[dict(subtask_status='SUCCEEDED', transcription_url=insecure)])),
                      Response(transcript()))
        self.code('unsafe_provider_url')
        self.assertEqual(len(self.connections), 4)
        self.http.assert_not_called()

    def test_http_upgrade_preserves_signed_path_query_order_case_and_proxy_key_isolation(self):
        relay = 'https://relay.example.com/api/v1/services/audio/asr/transcription'
        suffix = ('/pre/filetrans-16k/20260901/15%3a11/result.json'
                  '?Signature=A+b%2fc%3D&Expires=1999999999&OSSAccessKeyId=FAKE_OSS_RESULT_KEY'
                  '&x-oss-security-token=TOKEN%2b%2F%3d'
                  '&response-content-type=application%2fjson')
        url = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com' + suffix
        self.filetrans_sequence(url)
        out = self.filetrans_invoke(endpoint=relay, proxy='http://127.0.0.1:7897')
        self.assertEqual(len(out['segments']), 2)
        fetched = self.connections[4]
        self.assertEqual(fetched.destination, ('127.0.0.1', 7897))
        self.assertEqual(fetched.tunnel, ('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 443, {}))
        self.assertEqual(fetched.request[:2], ('GET', suffix))
        self.assertNotIn('Authorization', fetched.headers)
        self.assertNotIn('Proxy-Authorization', fetched.headers)
        self.assertNotIn(KEY.encode(), b''.join(fetched.sent))
        for index in (0, 2, 3):
            self.assertEqual(self.connections[index].headers.get('Authorization'), 'Bearer ' + KEY)
        self.assertTrue(all(conn.closed for conn in self.connections))
        self.http.assert_not_called()

    def test_http_upgrade_keeps_v4_signed_request_bytes_verbatim(self):
        suffix = ('/pre/15%3A11/result.json?x-oss-signature-version=OSS4-HMAC-SHA256'
                  '&x-oss-credential=FAKE_ACCESS%2f20261108%2fcn-beijing%2foss%2faliyun_v4_request'
                  '&x-oss-date=20261108T000000Z&x-oss-expires=3600'
                  '&x-oss-signature=ABCdef0123&x-oss-security-token=TOKEN%2Bwith+plus%3d')
        url = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com' + suffix
        self.filetrans_sequence(url)
        self.filetrans_invoke()
        self.assertEqual(self.connections[4].request[:2], ('GET', suffix))
        self.assertEqual(self.connections[4].destination, ('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 443))
        self.http.assert_not_called()

    def test_http_upgrade_same_origin_still_does_not_authorize_storage_role(self):
        host = 'dashscope-file.oss-cn-beijing.aliyuncs.com'
        insecure = RESULT.replace('https://', 'http://').replace('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', host)
        self.filetrans_sequence(insecure)
        self.filetrans_invoke(endpoint='https://' + host + '/custom-api')
        for index, conn in enumerate(self.connections):
            self.assertEqual(conn.destination, (host, 443))
            if index in (0, 2, 3):
                self.assertEqual(conn.headers.get('Authorization'), 'Bearer ' + KEY)
            else:
                self.assertNotIn('Authorization', conn.headers)
                self.assertNotIn(KEY.encode(), b''.join(conn.sent))
        self.http.assert_not_called()

    def test_official_http_result_fallback_array_also_uses_https(self):
        insecure = RESULT.replace('https://', 'http://')
        self.sequence(Response(policy()), Response(b''), Response(task()),
                      Response(task('SUCCEEDED', results=[dict(subtask_status='SUCCEEDED', transcription_url=insecure)])),
                      Response(transcript()))
        self.filetrans_invoke()
        self.assertEqual(self.connections[4].destination, ('dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 443))
        self.assertEqual(self.connections[4].request[:2], ('GET', RESULT.split('.com', 1)[1]))
        self.http.assert_not_called()

    def test_official_http_result_tls_failure_never_downgrades_retries_or_leaks_signature(self):
        insecure = RESULT.replace('https://', 'http://')
        original = self.connect
        for proxy in (None, 'http://127.0.0.1:7897'):
            with self.subTest(proxy=bool(proxy)):
                self.connections.clear()
                self.filetrans_sequence(insecure)
                def tls_failure(*args, **kwargs):
                    conn = original(*args, **kwargs)
                    if len(self.connections) == 5:
                        conn.error = m.ssl.SSLCertVerificationError(KEY + insecure)
                    return conn
                self.https.side_effect = tls_failure
                self.code('network_error', function=self.filetrans_invoke, proxy=proxy)
                self.assertEqual(len(self.connections), 5)
                self.assertEqual(self.connections[-1].response.reads, 0)
                self.assertNotIn('Authorization', self.connections[-1].headers)
                self.assertTrue(all(conn.closed for conn in self.connections))
                self.http.assert_not_called()

    def test_gateway_http_result_is_rejected_even_on_same_host_or_site(self):
        relay = 'https://maas.example-gateway.test/api/v1/services/audio/asr/transcription'
        for host in ('maas.example-gateway.test', 'cdn.example-gateway.test'):
            with self.subTest(host=host):
                self.connections.clear()
                self.filetrans_sequence('http://' + host + '/files/result.json?token=FAKE_TOKEN')
                self.code('unsafe_provider_url', function=self.filetrans_invoke, endpoint=relay)
                self.assertEqual(len(self.connections), 4)
                self.http.assert_not_called()

    def test_http_result_upgrade_does_not_bypass_oss_url_validation(self):
        insecure = RESULT.replace('https://', 'http://')
        host = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com'
        signed = '?Expires=1999999999&OSSAccessKeyId=FAKE&Signature=FAKE'
        bad = [insecure.replace('.aliyuncs.com', '.aliyuncs.com.evil.invalid'),
               insecure.replace('http://', 'http://user:pass@'),
               insecure.replace('http://', 'http://@'),
               insecure.replace('.aliyuncs.com/', '.aliyuncs.com:80/'),
               insecure.replace('.aliyuncs.com/', '.aliyuncs.com:443/'),
               insecure.replace('oss-cn-beijing', 'oss-ap-southeast-1'),
               host + '/a/../result.json' + signed,
               host + '/%2e%2e/result.json' + signed,
               host + '/a%2fb/result.json' + signed,
               host + '/%252e%252e/result.json' + signed,
               host + '//result.json' + signed,
               insecure + '#fragment', insecure + '&Signature=duplicate',
               insecure + '&redirect=https%3A%2F%2Fevil.invalid',
               host + '/result.json?Expires=1&OSSAccessKeyId=k&Signature=%00',
               host + '/result.json', host + '/result.txt' + signed,
               insecure.replace('http://', 'ftp://'),
               'http://127.0.0.1/result.json' + signed]
        for url in bad:
            with self.subTest(attack=bad.index(url)):
                self.connections.clear()
                self.filetrans_sequence(url)
                self.code('unsafe_provider_url', function=self.filetrans_invoke)
                self.assertEqual(len(self.connections), 4)
                self.http.assert_not_called()

    def test_upgraded_result_redirect_still_stops_without_following_or_downgrading(self):
        insecure = RESULT.replace('https://', 'http://')
        self.filetrans_sequence(insecure)
        redirected = Response((KEY + insecure).encode(), status=302,
                              headers={'Location': insecure})
        self.responses[-1] = redirected
        self.code('redirect_rejected', function=self.filetrans_invoke)
        self.assertEqual(len(self.connections), 5)
        self.assertEqual(redirected.reads, 0)
        self.http.assert_not_called()

    def test_filetrans_result_must_use_the_region_named_by_the_upload_policy(self):
        relay = 'https://relay.example.com/api/v1/services/audio/asr/transcription'
        self.sequence(Response(policy(upload_host='https://dashscope-file.oss-cn-shanghai.aliyuncs.com')), Response(b''),
                      Response({'output': dict(task_id=TASK_ID, task_status='PENDING')}),
                      Response({'output': dict(task_id=TASK_ID, task_status='SUCCEEDED',
                                               result=dict(transcription_url=RESULT))}),
                      Response(transcript()))
        self.code('unsafe_provider_url', protocol='dashscope_paraformer', endpoint=relay, region='',
                  model='qwen3-asr-flash-filetrans')


    def test_gateway_hosted_result_is_fetched_without_credentials(self):
        relay = 'https://maas.example-gateway.test/api/v1/services/audio/asr/transcription'
        hosted = 'https://cdn.example-gateway.test/files/20261102/result.json'
        self.sequence(Response(policy()), Response(b''),
                      Response({'output': dict(task_id=TASK_ID, task_status='PENDING')}),
                      Response({'output': dict(task_id=TASK_ID, task_status='SUCCEEDED',
                                               result=dict(transcription_url=hosted))}),
                      Response(transcript()))
        out = self.invoke(protocol='dashscope_paraformer', endpoint=relay, region='',
                          model='qwen3-asr-flash-filetrans')
        fetched = self.connections[4]
        self.assertEqual(fetched.destination, ('cdn.example-gateway.test', 443))
        self.assertNotIn(KEY.encode(), b''.join(fetched.sent))
        self.assertEqual(len(out['segments']), 2)
        self.assertNotIn(hosted, json.dumps(out))

    def test_result_query_accepts_oss_params_and_base64_plus(self):
        relay = 'https://maas.example-gateway.test/api/v1/services/audio/asr/transcription'
        url = ('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/pre/20260901/result.json'
               '?OSSAccessKeyId=FAKE&Expires=1999999999&Signature=a+b%2Fc%3D'
               '&response-content-type=application%2Fjson&x-oss-process=style%2Fplain')
        self.sequence(Response(policy()), Response(b''),
                      Response({'output': dict(task_id=TASK_ID, task_status='PENDING')}),
                      Response({'output': dict(task_id=TASK_ID, task_status='SUCCEEDED',
                                               result=dict(transcription_url=url))}),
                      Response(transcript()))
        out = self.invoke(protocol='dashscope_paraformer', endpoint=relay, region='',
                          model='qwen3-asr-flash-filetrans')
        self.assertEqual(len(out['segments']), 2)

    def test_result_query_still_rejects_unknown_and_duplicate_keys(self):
        relay = 'https://maas.example-gateway.test/api/v1/services/audio/asr/transcription'
        signed = '?Expires=1999999999&OSSAccessKeyId=FAKE&Signature=FAKE'
        for suffix in ('&redirect=https%3A%2F%2Fevil.invalid', '&Signature=again',
                       '&response-content-type=%00'):
            with self.subTest(suffix=suffix):
                self.connections.clear()
                self.sequence(Response(policy()), Response(b''),
                              Response({'output': dict(task_id=TASK_ID, task_status='PENDING')}),
                              Response({'output': dict(task_id=TASK_ID, task_status='SUCCEEDED',
                                                       result=dict(transcription_url=RESULT + suffix))}))
                self.code('unsafe_provider_url', protocol='dashscope_paraformer', endpoint=relay,
                          region='', model='qwen3-asr-flash-filetrans')

    def test_alibaba_platform_hosts_never_inherit_gateway_trust(self):
        relay = 'https://maas.example-gateway.test/api/v1/services/audio/asr/transcription'
        self.sequence(Response(policy()), Response(b''),
                      Response({'output': dict(task_id=TASK_ID, task_status='PENDING')}),
                      Response({'output': dict(task_id=TASK_ID, task_status='SUCCEEDED',
                                               result=dict(transcription_url='https://evil.aliyuncs.com/result.json'))}))
        self.code('unsafe_provider_url', protocol='dashscope_paraformer', endpoint=relay, region='',
                  model='qwen3-asr-flash-filetrans')


if __name__ == '__main__':
    unittest.main(verbosity=2)
