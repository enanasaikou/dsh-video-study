"""Backend routing, consent and portable output integration; no network or ASR."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import runner
import cloud_asr
import audio_prepare
import bilibili_subtitles as bili
import ytstudy

TARGET = 'https://www.youtube.com/watch?v=abcdefghijk'
KEY = 'FAKE_KEY_12345678'
AUDIO = b'FAKE AUDIO, NOT REAL MEDIA'


def caption_ok(target, out, language, config, page):
    out.mkdir()
    (out / 'metadata.json').write_text(json.dumps({'source_url': TARGET, 'language': 'en',
               'caption_kind': 'auto', 'segments': [], 'warnings': []}), encoding='utf-8')
    (out / 'transcript.txt').write_text('[00:00:00.000 --> 00:00:10.000] fixture', encoding='utf-8')
    return {'status': 'ok'}


def no_captions(*args):
    return {'status': 'no_captions'}


def fake_audio(target, directory, **kwargs):
    path = Path(directory) / 'audio.m4a'
    path.write_bytes(AUDIO)
    return path, {'platform': 'youtube', 'id': 'abcdefghijk', 'title': 'Untrusted title',
          'duration_seconds': 10, 'audio_bytes': len(AUDIO),
          'audio_sha256': hashlib.sha256(AUDIO).hexdigest(), 'audio_language': 'unknown',
          'audio_format_id': '140', 'warnings': ['unknown_audio_language']}


def fake_cloud(path, **kwargs):
    return {'segments': [{'start': 0, 'end': 10, 'text': 'Hello world'}],
            'info': {'duration': None, 'language': 'en'}, 'provider_model': kwargs['model'],
            'response_format': 'verbose_json', 'warnings': []}


MP3 = b'ID3\x04fake-offline-mp3'


class FakeProcess:
    """Stand-in ffmpeg: writes the promised MP3 without any real process."""
    def __init__(self, argv, **kwargs):
        self.argv, self.kwargs, self.returncode = list(argv), kwargs, None

    def wait(self, timeout=None):
        Path(self.argv[-1]).write_bytes(MP3)
        self.returncode = 0
        return 0

    def kill(self):
        self.returncode = -9


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='portable-runner-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / 'result'
        self.cloud = {'mode': 'cloud', 'cloudEndpoint': 'https://asr.example.test/v1/audio/transcriptions',
                      'cloudModel': 'whisper-1', 'cloudApiKey': KEY, 'cloudUploadConsent': True}

    def request(self, config=None, **extra):
        return {'operation': 'extract', 'target': TARGET, 'language': 'en', 'out': str(self.out),
                'config': config or {}, **extra}

    def test_default_caption_success_no_asr(self):
        cloud = Mock()
        result = runner.dispatch(self.request(), caption_ok, cloud)
        self.assertEqual(result['status'], 'ok')
        self.assertFalse(result['audio_downloaded'])
        self.assertFalse(result['audio_uploaded'])
        self.assertFalse(result['content_verified'])
        cloud.assert_not_called()

    def test_default_missing_captions_does_not_enable_asr(self):
        cloud = Mock()
        result = runner.dispatch(self.request(), no_captions, cloud)
        self.assertEqual(result['status'], 'no_captions')
        self.assertFalse(result['asr_attempted'])
        cloud.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_cloud_incomplete_config_still_allows_published_captions(self):
        result = runner.dispatch(self.request({'mode': 'cloud', 'cloudUploadConsent': False}), caption_ok,
                                 Mock(side_effect=AssertionError))
        self.assertEqual(result['status'], 'ok')

    def test_local_and_unknown_backends_rejected_before_caption_or_cloud(self):
        for mode in ('local', 'invalid', '', None, 123, {}, []):
            for extra in ({}, {'captionsOnly': True}, {'forceAsr': True}, {'operation': 'status'}):
                with self.subTest(mode=mode, extra=extra):
                    caption, cloud = Mock(), Mock()
                    with self.assertRaises(runner.RunnerError) as caught:
                        runner.dispatch(self.request({'mode': mode}, **extra), caption, cloud)
                    self.assertEqual(caught.exception.code, 'unsupported_backend')
                    self.assertIn('captions/cloud', str(caught.exception))
                    caption.assert_not_called()
                    cloud.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_request_cannot_turn_caption_settings_into_asr(self):
        with self.assertRaises(runner.RunnerError) as caught:
            runner.dispatch(self.request(forceAsr=True), Mock(side_effect=AssertionError))
        self.assertEqual(caught.exception.code, 'asr_disabled')
        self.assertFalse(self.out.exists())

    def test_captions_only_overrides_cloud_and_force(self):
        with self.assertRaises(runner.RunnerError) as caught:
            runner.dispatch(self.request(self.cloud, forceAsr=True, captionsOnly=True), Mock())
        self.assertEqual(caught.exception.code, 'asr_disabled')

    def test_invalid_asr_values_do_not_block_existing_captions(self):
        for config in ({'mode': 'captions', 'asrTimeout': 0},
                       {'mode': 'cloud', 'cloudMaxAudioMiB': 0, 'asrTimeout': -1}):
            with self.subTest(config=config):
                out = self.root / ('result-' + config['mode'])
                result = runner.dispatch(self.request(config, out=str(out)), caption_ok,
                                         Mock(side_effect=AssertionError))
                self.assertEqual(result['status'], 'ok')

    def test_cloud_bad_limits_fail_before_key_file_or_download(self):
        config = {**self.cloud, 'cloudMaxAudioMiB': 0, 'cloudApiKeyFile': str(self.root / 'private-key')}
        with self.assertRaises(runner.RunnerError):
            runner.cloud_extract(self.request(config), config, self.out, 'user_requested',
                                 Mock(side_effect=AssertionError), Mock(side_effect=AssertionError))
        self.assertFalse(self.out.exists())

    def test_explicit_force_uses_only_configured_cloud_backend(self):
        cloud = Mock(return_value={'status': 'cloud_fixture'})
        caption = Mock(side_effect=AssertionError)
        result = runner.dispatch(self.request(self.cloud, forceAsr=True, reason='unreliable_captions'),
                                 caption, cloud)
        self.assertEqual(result['status'], 'cloud_fixture')
        self.assertEqual(cloud.call_args.args[-1], 'unreliable_captions')
        caption.assert_not_called()

    def test_safe_absence_only_triggers_selected_fallback(self):
        for code in ('no_captions', 'language_unavailable'):
            with self.subTest(code=code):
                cloud = Mock(return_value={'status': 'cloud_fixture'})
                result = runner.dispatch(self.request(self.cloud), lambda *args: {'status': code}, cloud)
                self.assertEqual(result['status'], 'cloud_fixture')
                self.assertEqual(cloud.call_args.args[-1], code)

    def test_network_login_format_parse_identity_errors_never_fallback(self):
        for code in ('network_error', 'rate_limited', 'login_required', 'platform_restricted',
                     'video_identity_mismatch', 'parse_error', 'incomplete_metadata', 'unsupported_subtitle_format'):
            with self.subTest(code=code):
                cloud = Mock()
                result = runner.dispatch(self.request(self.cloud), lambda *args: {'status': code}, cloud)
                self.assertFalse(result['asr_attempted'])
                self.assertEqual(result['status'], code)
                cloud.assert_not_called()

    def test_failed_caption_output_not_overwritten_by_fallback(self):
        def failed(*args):
            self.out.mkdir()
            (self.out / 'original.vtt').write_text('preserve raw', encoding='utf-8')
            return {'status': 'no_captions'}
        cloud = Mock()
        runner.dispatch(self.request(self.cloud), failed, cloud)
        cloud.assert_not_called()
        self.assertTrue((self.out / 'original.vtt').is_file())

    def test_existing_output_rejected_before_backend(self):
        self.out.mkdir()
        caption = Mock()
        with self.assertRaises(runner.RunnerError) as caught:
            runner.dispatch(self.request(), caption)
        self.assertEqual(caught.exception.code, 'output_exists')
        caption.assert_not_called()

    def test_bad_request_validated_without_network(self):
        for extra in ({'language': 'fr'}, {'forceAsr': 'true'}, {'captionsOnly': 'false'}, {'out': 'relative'},
                      {'target': 'https://evil.test/watch?v=abcdefghijk'}):
            with self.subTest(extra=extra), self.assertRaises(Exception):
                runner.dispatch(self.request(**extra), Mock(side_effect=AssertionError))

    def test_cloud_consent_before_key_file_read_or_download(self):
        config = {**self.cloud, 'cloudApiKey': '', 'cloudApiKeyFile': str(self.root / 'private-key'),
                  'cloudUploadConsent': False}
        with patch.object(Path, 'read_text', side_effect=AssertionError('credential file read')), \
             self.assertRaises(cloud_asr.CloudASRError) as caught:
            runner.cloud_extract(self.request(config), config, self.out, 'user_requested', Mock(), Mock())
        self.assertEqual(caught.exception.code, 'upload_consent_required')
        self.assertFalse(self.out.exists())

    def test_cloud_success_bundle_and_temp_cleanup_no_secret_persisted(self):
        directories = []
        def download(target, directory, **kwargs):
            directories.append(directory)
            return fake_audio(target, directory, **kwargs)
        result = runner.cloud_extract(self.request(self.cloud), self.cloud, self.out,
                                      'unreliable_captions', download, fake_cloud)
        self.assertEqual(result['status'], 'ok')
        self.assertTrue(result['audio_uploaded'])
        self.assertFalse(Path(directories[0]).exists())
        metadata = json.loads((self.out / 'metadata.json').read_text(encoding='utf-8'))
        self.assertEqual(metadata['caption_kind'], 'cloud_asr')
        self.assertFalse(metadata['duration_from_api'])
        self.assertIsNone(metadata['forced_language'])
        self.assertEqual(metadata['language_hint'], 'en')
        self.assertTrue(metadata['timestamps_available'])
        for file in self.out.iterdir():
            value = file.read_text(encoding='utf-8')
            self.assertNotIn(KEY, value)
            self.assertNotIn('asr.example.test', value)
        self.assertNotIn('本地', (self.out / 'transcript.txt').read_text(encoding='utf-8'))

    def test_ali_native_engine_and_language_hint_metadata_are_not_generic_or_forced(self):
        config = {**self.cloud, 'cloudEndpoint': 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
                  'cloudModel': 'paraformer-v2'}
        def native(path, **kwargs):
            self.assertEqual(kwargs['model'], 'paraformer-v2')
            return {**fake_cloud(path, **kwargs), 'info': {'language': None, 'duration': 10},
                    'engine': 'untrusted-provider-engine', 'response_format': 'sentences_json',
                    'warnings': ['阿里临时OSS约48小时清理；远端任务可能继续并产生费用。']}
        result = runner.cloud_extract(self.request(config), config, self.out, 'user_requested', fake_audio, native)
        self.assertEqual(result['status'], 'ok')
        metadata = json.loads((self.out / 'metadata.json').read_text(encoding='utf-8'))
        self.assertEqual(metadata['engine'], 'aliyun_paraformer')
        self.assertEqual(metadata['response_format'], 'sentences_json')
        self.assertEqual(metadata['requested_language'], 'en')
        self.assertEqual(metadata['language_hint'], 'en')
        self.assertIsNone(metadata['forced_language'])
        self.assertEqual(metadata['language'], 'unknown')
        self.assertNotIn(KEY, json.dumps(metadata))
        self.assertNotIn('untrusted-provider-engine', json.dumps(metadata))

    def test_ali_failure_warns_remote_task_may_continue_without_task_ids_or_url(self):
        config = {**self.cloud, 'cloudEndpoint': 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
                  'cloudModel': 'paraformer-v2'}
        def fail(*args, **kwargs):
            raise cloud_asr.CloudASRError('timeout', cloud_asr._MESSAGES['timeout'])
        with self.assertRaises(cloud_asr.CloudASRError):
            runner.cloud_extract(self.request(config), config, self.out, 'user_requested', fake_audio, fail)
        failure = json.loads((self.out / 'failure.json').read_text(encoding='utf-8'))
        self.assertIn('48小时', failure['note'])
        self.assertIn('远端任务可能继续并产生费用', failure['note'])
        self.assertNotIn(KEY, json.dumps(failure))
        self.assertNotIn('dashscope', json.dumps(failure))
        self.assertFalse((self.out / 'metadata.json').exists())

    def test_unsupported_protocol_preflights_before_key_file_download_or_directory(self):
        config = {**self.cloud, 'cloudProtocol': 'not-a-protocol',
                  'cloudModel': 'qwen3-asr-flash', 'cloudApiKeyFile': str(self.root / 'never-read')}
        with patch.object(Path, 'read_text', side_effect=AssertionError('credential read')), \
             self.assertRaises(cloud_asr.CloudASRError) as caught:
            runner.cloud_extract(self.request(config), config, self.out, 'user_requested',
                                 Mock(side_effect=AssertionError), Mock(side_effect=AssertionError))
        self.assertEqual(caught.exception.code, 'invalid_protocol')
        self.assertFalse(self.out.exists())

    def test_ali_offline_status_reports_protocol_without_key_read_or_network(self):
        config = {**self.cloud, 'cloudEndpoint': 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription',
                  'cloudModel': 'paraformer-v2', 'cloudApiKeyFile': str(self.root / 'never-read')}
        with patch.object(Path, 'read_text', side_effect=AssertionError('credential read')):
            result = runner.dispatch({'operation': 'status', 'config': config})
        self.assertEqual(result['backend']['engine'], 'aliyun_paraformer')
        self.assertEqual(result['backend']['response_format'], 'sentences_json')
        self.assertFalse(result['backend']['credential_file_read'])
        self.assertNotIn(KEY, json.dumps(result))

    def test_text_only_protocols_never_fabricate_timestamps_or_srt(self):
        for protocol, response_format, model in [('openai', 'provider_default', '自定义模型'),
                                                  ('dashscope_qwen', 'verbose_json', 'qwen3-asr-flash')]:
            with self.subTest(protocol=protocol):
                out = self.root / protocol
                config = {**self.cloud, 'cloudProtocol': protocol, 'cloudResponseFormat': response_format,
                          'cloudProviderName': '任意显示名称', 'cloudEndpoint': 'https://gateway.example.test/my/asr', 'cloudModel': model}
                def transcript(path, **kwargs):
                    self.assertEqual(kwargs['protocol'], protocol)
                    self.assertEqual(kwargs['provider_name'], '任意显示名称')
                    self.assertEqual(kwargs['response_format'], response_format)
                    return {'text_only': True, 'text': '完整正文，不编造时间。', 'segments': [],
                            'info': {'duration': None, 'language': None}, 'warnings': []}
                result = runner.cloud_extract(self.request(config), config, out, 'user_requested', fake_audio, transcript)
                self.assertEqual(result['status'], 'ok')
                metadata = json.loads((out / 'metadata.json').read_text(encoding='utf-8'))
                self.assertEqual(metadata['segments'], [])
                self.assertFalse(metadata['timestamps_available'])
                self.assertEqual(metadata['transcript_kind'], 'plain_text')
                self.assertEqual(metadata['language'], 'unknown')
                self.assertIsNone(metadata['forced_language'])
                self.assertFalse((out / 'transcript.srt').exists())
                self.assertIn('完整正文', (out / 'transcript.txt').read_text(encoding='utf-8'))
                self.assertNotIn('-->', (out / 'transcript.txt').read_text(encoding='utf-8'))
                for file in out.iterdir(): self.assertNotIn(KEY, file.read_text(encoding='utf-8'))

    def test_native_protocol_config_reaches_adapter_but_not_metadata_or_caption_selection(self):
        config = {**self.cloud, 'cloudProtocol': 'volcengine_flash', 'cloudAppId': 'FAKEAPPID',
                  'cloudRegion': '', 'cloudResourceId': 'volc.bigasr.auc_turbo', 'cloudModel': 'bigmodel'}
        def audio(target, directory, **kwargs):
            path = Path(directory) / 'audio.mp3'
            path.write_bytes(AUDIO)
            return path, {**fake_audio(target, directory, **kwargs)[1], 'audio_bytes': len(AUDIO)}
        def transcript(path, **kwargs):
            self.assertEqual(kwargs['app_id'], 'FAKEAPPID')
            self.assertEqual(kwargs['resource_id'], 'volc.bigasr.auc_turbo')
            return fake_cloud(path, **kwargs)
        result = runner.cloud_extract(self.request(config), config, self.out, 'user_requested', audio, transcript)
        self.assertEqual(result['status'], 'ok')
        metadata = (self.out / 'metadata.json').read_text(encoding='utf-8')
        self.assertNotIn('FAKEAPPID', metadata)
        self.assertNotIn(KEY, metadata)
        self.assertIn('volcengine', metadata)

    def test_volcengine_m4a_is_prepared_offline_and_charged_to_the_asr_budget(self):
        config = {**self.cloud, 'cloudProtocol': 'volcengine_flash', 'cloudAppId': 'FAKEAPPID',
                  'cloudRegion': '', 'cloudResourceId': 'volc.bigasr.auc_turbo', 'cloudModel': 'bigmodel'}
        seen = {}
        def transcript(path, **kwargs):
            seen['suffix'] = Path(path).suffix
            seen['timeout'] = kwargs['timeout']
            return fake_cloud(path, **kwargs)
        fake = SimpleNamespace(which=lambda name: 'ffmpeg')
        processes = []
        popen = lambda argv, **kwargs: processes.append(FakeProcess(argv, **kwargs)) or processes[-1]
        with patch.object(audio_prepare, 'shutil', fake), \
             patch.object(audio_prepare, 'subprocess', SimpleNamespace(
                 Popen=popen, DEVNULL=subprocess.DEVNULL, TimeoutExpired=subprocess.TimeoutExpired)):
            result = runner.cloud_extract(self.request(config), config, self.out, 'user_requested', fake_audio, transcript)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(seen['suffix'], '.mp3')
        self.assertLessEqual(seen['timeout'], 3600)
        argv = processes[0].argv
        self.assertEqual(argv[argv.index('-c:a') + 1], 'libmp3lame')
        child_env = processes[0].kwargs['env']
        self.assertEqual(set(child_env), {'TMP', 'TEMP', 'TMPDIR'})
        self.assertEqual(len(set(child_env.values())), 1)
        scratch = Path(child_env['TMP'])
        self.assertEqual(scratch.parent.parent, self.out)
        self.assertFalse(scratch.exists())
        metadata = json.loads((self.out / 'metadata.json').read_text(encoding='utf-8'))
        self.assertIn('audio_source: local_audio_transcoded', metadata['warnings'])
        self.assertIn('duration_from_platform', ' '.join(metadata['warnings']))
        self.assertNotIn(KEY, json.dumps(metadata))

    def test_native_protocol_m4a_without_ffmpeg_fails_before_upload(self):
        config = {**self.cloud, 'cloudProtocol': 'volcengine_flash', 'cloudAppId': 'FAKEAPPID',
                  'cloudRegion': '', 'cloudResourceId': 'volc.bigasr.auc_turbo', 'cloudModel': 'bigmodel'}
        with patch.object(audio_prepare, 'shutil', SimpleNamespace(which=lambda name: None)):
            with self.assertRaises(cloud_asr.CloudASRError) as caught:
                runner.cloud_extract(self.request(config), config, self.out, 'user_requested',
                                     fake_audio, Mock(side_effect=AssertionError('must not upload')))
        self.assertEqual(caught.exception.code, 'dependency_missing')
        self.assertFalse((self.out / 'metadata.json').exists())
        self.assertTrue((self.out / 'failure.json').exists())

    def test_cloud_extract_rejects_bad_download_budget_before_reading_credentials(self):
        config = {**self.cloud, 'cloudApiKey': '', 'cloudApiKeyFile': str(self.root / 'never-read'),
                  'downloadTimeout': 0}
        with patch.object(Path, 'read_text', side_effect=AssertionError('credential read')):
            with self.assertRaises(runner.RunnerError) as caught:
                runner.cloud_extract(self.request(config), config, self.out, 'user_requested',
                                     Mock(side_effect=AssertionError('must not download')), Mock())
        self.assertEqual(caught.exception.code, 'invalid_input')
        self.assertFalse(self.out.exists())

    def test_invalid_cloud_segments_keep_raw_without_success_marker(self):
        def invalid(*args, **kwargs):
            return {**fake_cloud(*args, **kwargs), 'segments': [{'start': 10, 'end': 1, 'text': 'invalid'}]}
        with self.assertRaises(Exception):
            runner.cloud_extract(self.request(self.cloud), self.cloud, self.out, 'user_requested', fake_audio, invalid)
        self.assertFalse((self.out / 'metadata.json').exists())
        self.assertTrue((self.out / 'failure.json').exists())
        self.assertTrue((self.out / 'raw-asr.json').exists())

    def test_json_bridge_survives_ascii_windows_pipe_locale(self):
        from types import SimpleNamespace
        raw = io.BytesIO()
        output = io.TextIOWrapper(raw, encoding='ascii')
        incoming = SimpleNamespace(buffer=io.BytesIO(b'{"operation":"status"}'))
        with patch.object(sys, 'stdin', incoming), patch.object(sys, 'stdout', output), \
             patch.object(runner, 'dispatch', return_value={'status': 'ok', 'message': '中文输出'}):
            self.assertEqual(runner.main(), 0)
        output.flush()
        data = raw.getvalue().decode('ascii')
        output.detach()
        self.assertEqual(json.loads(data)['message'], '中文输出')

    def test_direct_status_rejects_local_before_config_or_dependency_access(self):
        with patch.object(runner.importlib.metadata, 'version', side_effect=AssertionError('dependency scan')), \
             self.assertRaises(runner.RunnerError) as caught:
            runner.status({}, 'local')
        self.assertEqual(caught.exception.code, 'unsupported_backend')

    def test_json_bridge_explicitly_rejects_local_without_io(self):
        incoming = SimpleNamespace(buffer=io.BytesIO(b'{"operation":"status","config":{"mode":"local"}}'))
        output = io.StringIO()
        with patch.object(sys, 'stdin', incoming), patch.object(sys, 'stdout', output), \
             patch.object(Path, 'read_text', side_effect=AssertionError('no credentials')), \
             patch.object(runner, 'cloud_extract', side_effect=AssertionError('no cloud')):
            self.assertEqual(runner.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'unsupported_backend')
        self.assertIn('captions/cloud', result['message'])
        self.assertFalse(result['success'])

    def test_caption_status_reports_missing_dependencies_not_false_readiness(self):
        def missing(name):
            raise runner.importlib.metadata.PackageNotFoundError(name)
        with patch.object(runner.importlib.metadata, 'version', side_effect=missing):
            result = runner.status({}, 'captions')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['backend']['status'], 'dependency_missing')
        self.assertEqual(result['backend']['missing_dependencies'], ['yt-dlp', 'python-docx'])
        self.assertEqual(result['backend']['python_executable'], sys.executable)
        self.assertFalse(result['network_used'])

    def test_caption_status_requires_both_subtitle_and_word_dependencies(self):
        for absent in ('yt-dlp', 'python-docx', None):
            with self.subTest(absent=absent):
                def version(name):
                    if name == absent:
                        raise runner.importlib.metadata.PackageNotFoundError(name)
                    return 'FAKE_VERSION'
                with patch.object(runner.importlib.metadata, 'version', side_effect=version):
                    result = runner.status({}, 'captions')
                self.assertEqual(result['backend']['status'], 'dependency_missing' if absent else 'ok')
                self.assertEqual(result['backend']['missing_dependencies'], [absent] if absent else [])

    def test_status_caption_does_not_import_asr_backend(self):
        class ForbiddenConfig(dict):
            def get(self, key, default=None):
                if key.startswith(('cloud', 'local')):
                    raise AssertionError('unselected backend accessed')
                return super().get(key, default)
        result = runner.dispatch({'operation': 'status', 'config': ForbiddenConfig()})
        self.assertEqual(result['mode'], 'captions')
        self.assertFalse(result['asr_enabled'])
        self.assertEqual(result['backend']['kind'], 'none')

    def test_both_cookie_files_configured_route_only_matching_platform(self):
        config = {'youtubeCookieFile': 'explicit-youtube.txt', 'biliCookieFile': 'explicit-bili.json'}
        self.assertEqual(runner.audio_cookie_options(self.request(), config),
                         {'cookies': 'explicit-youtube.txt', 'bili_cookie_file': None})
        request = self.request(target='https://www.bilibili.com/video/BV17K411P7hC/?p=27')
        self.assertEqual(runner.audio_cookie_options(request, config),
                         {'cookies': None, 'bili_cookie_file': 'explicit-bili.json'})

    def test_caption_backend_receives_private_override_not_argv_or_cookie_file(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        config = {'biliSessdata': secret}
        target = 'https://www.bilibili.com/video/BV17K411P7hC/?p=27'
        original_argv = sys.argv
        def main(*, session_override=None):
            self.assertEqual(session_override, secret)
            self.assertNotIn(secret, ' '.join(sys.argv))
            self.assertNotIn('--cookie-file', sys.argv)
            self.assertIn('27', sys.argv)
            print(json.dumps({'status': 'ok'}))
        with patch.object(bili, 'main', side_effect=main) as backend, \
             patch.object(Path, 'write_text', side_effect=AssertionError('no secret file')):
            result = runner.caption_extract(target, self.out, 'zh', config)
        self.assertEqual(result['status'], 'ok')
        backend.assert_called_once_with(session_override=secret)
        self.assertIs(sys.argv, original_argv)

    def test_bilibili_private_and_file_conflict_rejected_before_backend_or_read(self):
        config = {'biliSessdata': 'FAKE_PRIVATE_MEMORY_SESSION', 'biliCookieFile': 'never-read.json'}
        target = 'https://www.bilibili.com/video/BV17K411P7hC/?p=27'
        with patch.object(bili, 'main') as backend, patch.object(Path, 'read_text', side_effect=AssertionError):
            with self.assertRaises(runner.RunnerError) as caught:
                runner.caption_extract(target, self.out, 'zh', config)
            self.assertEqual(caught.exception.code, 'credential_conflict')
            with self.assertRaises(runner.RunnerError) as caught:
                runner.audio_cookie_options(self.request(target=target), config)
            self.assertEqual(caught.exception.code, 'credential_conflict')
        backend.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_private_audio_options_only_present_for_bilibili_non_none(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        target = 'https://www.bilibili.com/video/BV17K411P7hC/?p=27'
        options = runner.audio_cookie_options(self.request(target=target), {'biliSessdata': secret})
        self.assertEqual(options, {'cookies': None, 'bili_cookie_file': None, 'bili_sessdata': secret})
        options = runner.audio_cookie_options(self.request(target=target), {'biliSessdata': None})
        self.assertNotIn('bili_sessdata', options)

    def test_youtube_never_reads_bilibili_config_even_when_invalid_or_conflicting(self):
        class Config(dict):
            def get(self, key, default=None):
                if key.startswith('bili'):
                    raise AssertionError('YouTube read Bilibili config')
                return super().get(key, default)
        config = Config(youtubeCookieFile='explicit-youtube.txt')
        with patch.object(ytstudy, 'extract', return_value={'status': 'ok'}) as extract:
            self.assertEqual(runner.caption_extract(TARGET, self.out, 'en', config)['status'], 'ok')
        self.assertEqual(extract.call_args.args[0].cookies, 'explicit-youtube.txt')
        self.assertEqual(runner.audio_cookie_options(self.request(), config),
                         {'cookies': 'explicit-youtube.txt', 'bili_cookie_file': None})

    def test_private_invalid_values_rejected_without_echo_or_network(self):
        target = 'https://www.bilibili.com/video/BV17K411P7hC/?p=27'
        for value in ('', ' PRIVATE', 'PRIVATE;', 'PRIVATE\n', 123, {}):
            with self.subTest(value_type=type(value).__name__), \
                 patch.object(bili, 'main') as backend, self.assertRaises(runner.RunnerError) as caught:
                runner.caption_extract(target, self.out, 'zh', {'biliSessdata': value})
            self.assertEqual(caught.exception.code, 'invalid_session')
            self.assertNotIn('PRIVATE', str(caught.exception))
            backend.assert_not_called()

    def test_cloud_private_transport_stays_in_downloader_not_api_or_files(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        config = {**self.cloud, 'biliSessdata': secret}
        request = self.request(config, target='https://www.bilibili.com/video/BV17K411P7hC/?p=27')
        directories = []
        def download(target, directory, **kwargs):
            directories.append(directory)
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertEqual(kwargs['bili_sessdata'], secret)
            self.assertIsNone(kwargs['bili_cookie_file'])
            audio, source = fake_audio(target, directory)
            source.update(platform='bilibili', id='BV17K411P7hC', bvid='BV17K411P7hC', page=27, cid=254923561)
            return audio, source
        def transcribe(path, **kwargs):
            self.assertNotIn(secret, json.dumps(kwargs))
            self.assertNotIn('bili_sessdata', kwargs)
            return fake_cloud(path, **kwargs)
        result = runner.cloud_extract(request, config, self.out, 'user_requested', download, transcribe)
        self.assertEqual(result['status'], 'ok')
        self.assertFalse(Path(directories[0]).exists())
        for path in self.out.iterdir():
            self.assertNotIn(secret, path.read_text(encoding='utf-8'))

    def test_safe_result_drops_secret_fields_not_normal_body(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        value = {'status': 'ok', 'biliSessdata': secret, 'nested': {'Cookie': 'SESSDATA=' + secret},
                 'text': '正文 cookie=是课程内容；SESSDATA是术语；其余不删除 ' + secret,
                 'segments': [{'text': '正常字幕完整保留'}]}
        cleaned = runner.safe_result(value, secret)
        self.assertNotIn(secret, json.dumps(cleaned))
        self.assertNotIn('biliSessdata', cleaned)
        self.assertEqual(cleaned['nested'], {})
        self.assertIn('正文 cookie=是课程内容；SESSDATA是术语；其余不删除', cleaned['text'])
        self.assertEqual(cleaned['segments'], value['segments'])

    def test_json_stdin_private_session_reaches_backend_and_final_json_is_scrubbed(self):
        from types import SimpleNamespace
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        request = self.request({'biliSessdata': secret}, target='BV17K411P7hC')
        incoming = SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode('utf-8')))
        def caption(target, out, language, config, page):
            self.assertEqual(config['biliSessdata'], secret)
            return {'status': 'no_captions', 'message': '保持正文 ' + secret}
        output = io.StringIO()
        with patch.object(sys, 'stdin', incoming), patch.object(sys, 'stdout', output), \
             patch.object(runner, 'caption_extract', side_effect=caption), \
             patch.object(Path, 'write_text', side_effect=AssertionError('no temp file')):
            self.assertEqual(runner.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'no_captions')
        self.assertEqual(result['message'], '保持正文 [redacted]')
        self.assertNotIn(secret, output.getvalue())
        self.assertFalse(self.out.exists())

    def test_private_backend_error_not_echoed_by_json_bridge(self):
        from types import SimpleNamespace
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        incoming = SimpleNamespace(buffer=io.BytesIO(json.dumps(self.request({'biliSessdata': secret})).encode()))
        output = io.StringIO()
        with patch.object(sys, 'stdin', incoming), patch.object(sys, 'stdout', output), \
             patch.object(runner, 'dispatch', side_effect=RuntimeError(secret)):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['status'], 'operation_failed')
        self.assertNotIn(secret, output.getvalue())

    def test_status_cloud_never_reads_key_file(self):
        config = {**self.cloud, 'cloudApiKey': '', 'cloudApiKeyFile': str(self.root / 'private-key')}
        with patch.object(Path, 'read_text', side_effect=AssertionError('no credential reads')), \
             patch.object(runner.importlib.metadata, 'version', return_value='offline-test'):
            result = runner.dispatch({'operation': 'status', 'config': config})
        self.assertFalse(result['network_used'])
        self.assertFalse(result['runtime_ready'])
        self.assertTrue(result['backend']['api_key_file_configured'])


class PublishedCaptionTests(unittest.TestCase):
    def test_youtube_translated_track_is_not_accepted_as_source(self):
        from test_transport import TransportTests
        fixture = TransportTests()
        meta = {'id': 'bGRhS_f6EdM', 'automatic_captions': {
            'en': [{'ext': 'vtt', 'url': 'https://captions.test/timedtext?tlang=en'}]}}
        modules, state = fixture.fake(meta=meta)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, modules):
            args = fixture.args(Path(tmp), reject_translated=True)
            with self.assertRaises(ytstudy.StudyError) as caught:
                ytstudy.extract(args)
        self.assertEqual(caught.exception.code, 'language_unavailable')
        self.assertFalse(state['requests'])

    def test_bilibili_explicit_english_does_not_silently_select_chinese(self):
        from test_bilibili_subtitles import Tests, m
        fixture = Tests()
        fixture.setUp()
        try:
            original_parse = m.argparse.ArgumentParser.parse_args
            def english(parser, *args, **kwargs):
                result = original_parse(parser, *args, **kwargs)
                result.lang = 'en'
                return result
            with patch.object(m.argparse.ArgumentParser, 'parse_args', english), \
                 self.assertRaises(m.SafeFailure) as caught:
                fixture.run_fixture()
            self.assertEqual(caught.exception.payload['status'], 'language_unavailable')
        finally:
            fixture.doCleanups()


if __name__ == '__main__':
    unittest.main()
