"""Offline Qwen fake requests; no media, network, SDK, secrets or config files."""
import base64
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_cloud_asr import Connection, Response, FAKE_AUDIO, KEY

SPEC = importlib.util.spec_from_file_location('qwen_test_cloud', Path(__file__).parents[1] / 'python' / 'cloud_asr.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'


def completion(text='real recognized words', **changes):
    obj = {'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': text}}]}
    obj.update(changes)
    return obj


class QwenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='qwen-offline-')
        self.addCleanup(self.tmp.cleanup)
        self.audio = Path(self.tmp.name) / 'PRIVATE_NAME.wav'
        self.audio.write_bytes(FAKE_AUDIO)
        self.config = dict(endpoint=ENDPOINT, api_key=KEY, model='qwen3-asr-flash',
                           language='en', protocol='dashscope_qwen', upload_consent=True)
        self.conn = Connection(Response(completion()))
        self.addCleanup(patch.stopall)
        self.https = patch.object(m.http.client, 'HTTPSConnection', side_effect=lambda *a, **kw: self.conn).start()
        self.http = patch.object(m.http.client, 'HTTPConnection', side_effect=AssertionError('HTTP forbidden')).start()
        patch.object(m.ssl, 'create_default_context', return_value=object()).start()

    def invoke(self, **changes):
        return m.transcribe_cloud(self.audio, **dict(self.config, **changes))

    def code(self, code, **changes):
        with self.assertRaises(m.CloudASRError) as caught:
            self.invoke(**changes)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertNotIn(ENDPOINT, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_offline_preflight_no_adapter_import_or_files(self):
        with patch.object(m, 'Path', side_effect=AssertionError('no files')), patch.object(importlib.util, 'spec_from_file_location', side_effect=AssertionError('no adapter')):
            state = m.validate_cloud_config(self.config)
        self.assertEqual(state['engine'], 'aliyun_qwen_asr')
        self.assertEqual(state['response_format'], 'chat_completion_json')
        self.assertEqual(state['timestamps_capability'], 'optional')
        self.assertTrue(state['language_parameter_sent'])
        self.assertNotIn(KEY, json.dumps(state))
        self.https.assert_not_called()

    def test_real_data_uri_single_json_post_and_no_fake_time(self):
        result = self.invoke()
        self.assertEqual(result['text'], 'real recognized words')
        self.assertTrue(result['text_only'])
        self.assertEqual(result['segments'], [])
        self.assertEqual(result['info'], {'duration': None, 'language': None})
        self.assertEqual(result['response_format'], 'chat_completion_json')
        self.assertEqual(self.conn.request[:2], ('POST', '/compatible-mode/v1/chat/completions'))
        self.assertEqual(self.conn.headers['Authorization'], 'Bearer ' + KEY)
        body = b''.join(self.conn.sent)
        self.assertEqual(len(body), int(self.conn.headers['Content-Length']))
        obj = json.loads(body)
        self.assertFalse(obj['stream'])
        self.assertEqual(obj['asr_options'], {'enable_itn': False, 'language': 'en'})
        data = obj['messages'][0]['content'][0]
        self.assertEqual(data['type'], 'input_audio')
        uri = data['input_audio']['data']
        self.assertTrue(uri.startswith('data:audio/wav;base64,'))
        self.assertEqual(base64.b64decode(uri.split(',', 1)[1]), FAKE_AUDIO)
        self.assertNotIn(b'PRIVATE_NAME', body)
        self.assertNotIn(KEY.encode(), body)
        self.assertTrue(self.conn.closed)
        self.https.assert_called_once()

    def test_custom_endpoint_model_and_proxy_preserved(self):
        result = self.invoke(endpoint='https://custom.example.invalid:8443/tenant/custom-asr', model='自定义 模型', proxy='http://127.0.0.1:7897')
        self.assertEqual(result['provider_model'], '自定义 模型')
        self.assertEqual(self.conn.request[1], '/tenant/custom-asr')
        self.assertEqual(self.conn.tunnel, ('custom.example.invalid', 8443, {}))
        self.assertEqual(json.loads(b''.join(self.conn.sent))['model'], '自定义 模型')

    def test_auto_language_omitted_no_invented_detected_language(self):
        self.invoke(language='auto')
        obj = json.loads(b''.join(self.conn.sent))
        self.assertEqual(obj['asr_options'], {'enable_itn': False})
        self.assertNotIn('translate', json.dumps(obj))

    def test_audio_limits_before_network_include_base64_expansion(self):
        self.code('size_limit', max_bytes=1)
        self.https.assert_not_called()
        # 7.5 MB source expands to 10 MB before even the Data URI prefix.
        with self.audio.open('wb') as file:
            file.truncate(7_500_000)
        self.code('size_limit', max_bytes=20_000_000)
        self.https.assert_not_called()

    def test_mutation_during_send_aborts_without_reading_response(self):
        self.conn.on_send = lambda _: self.audio.write_bytes(FAKE_AUDIO + b'changed')
        self.code('audio_invalid')
        self.assertEqual(self.conn.response.reads, 0)
        self.assertTrue(self.conn.closed)

    def test_redirect_and_errors_never_retry_or_read_error_body(self):
        for status, code in ((302, 'redirect_rejected'), (401, 'authentication_failed'),
                             (403, 'access_denied'), (429, 'rate_limited'), (500, 'provider_error')):
            self.conn = Connection(Response(KEY.encode(), status=status))
            with self.subTest(status=status):
                self.code(code)
                self.assertEqual(self.conn.response.reads, 0)
                self.assertTrue(self.conn.closed)
        self.assertEqual(self.https.call_count, 5)

    def test_invalid_empty_truncated_or_secret_response(self):
        bad = [completion(''), completion(None), completion(KEY), {'choices': []},
               completion(choices=[{'finish_reason': 'length', 'message': {'role': 'assistant', 'content': 'partial'}}]),
               completion(choices=[{'finish_reason': 'stop', 'message': {'content': 'missing role'}}]),
               completion(secret=KEY), b'not json']
        for obj in bad:
            self.conn = Connection(Response(obj))
            with self.subTest(obj_type=type(obj).__name__):
                self.code('invalid_response')
                self.assertTrue(self.conn.closed)

    def test_actual_language_annotation_and_mismatch_not_request_inference(self):
        obj = completion()
        obj['choices'][0]['message']['annotations'] = [{'type': 'audio_info', 'language': 'en'}]
        self.conn = Connection(Response(obj))
        self.assertEqual(self.invoke()['info']['language'], 'en')
        obj['choices'][0]['message']['annotations'][0]['language'] = 'zh'
        self.conn = Connection(Response(obj))
        self.code('language_mismatch')

    def test_cumulative_timeout_includes_send_and_response(self):
        clock = [0]
        self.conn.on_send = lambda _: clock.__setitem__(0, clock[0] + 2)
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            self.code('timeout', timeout=1)
        self.assertTrue(self.conn.closed)

    def test_synchronous_wait_over_30s_keeps_one_shared_budget(self):
        for proxy in (None, 'http://127.0.0.1:7897'):
            with self.subTest(proxy=bool(proxy)):
                self.https.reset_mock()
                self.conn = Connection(Response(completion()))
                clock, read_budgets = [0], []
                response = self.conn.response

                def headers():
                    self.assertEqual(self.conn.timeout, 120)
                    clock[0] += 45
                    return response

                def body():
                    read_budgets.append(self.conn.timeout)
                    if len(read_budgets) == 1:
                        clock[0] += 40

                response.on_read = body
                with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
                     patch.object(self.conn, 'getresponse', side_effect=headers):
                    result = self.invoke(timeout=120, proxy=proxy)
                self.assertEqual(result['text'], 'real recognized words')
                self.assertEqual(read_budgets, [75, 35])
                self.assertEqual(self.https.call_args.kwargs['timeout'], 30)
                self.assertTrue(self.conn.closed)
                self.https.assert_called_once()

    def test_synchronous_timeout_after_headers_closes_without_retry(self):
        clock = [0]

        def headers():
            clock[0] += 70
            return self.conn.response

        def body():
            self.assertEqual(self.conn.timeout, 50)
            clock[0] += 51

        self.conn.response.on_read = body
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(self.conn, 'getresponse', side_effect=headers):
            self.code('timeout', timeout=120)
        self.assertTrue(self.conn.closed)
        self.https.assert_called_once()

    def test_consent_and_https_required_before_file_read(self):
        with patch.object(m, 'Path', side_effect=AssertionError('must not read file')):
            self.code('upload_consent_required', upload_consent=False)
            self.code('insecure_endpoint', endpoint='http://localhost/custom', allow_insecure_loopback=True)
        self.https.assert_not_called()
        self.http.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
