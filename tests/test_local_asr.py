"""Offline unittest suite. No engine installation, model/media download or network.

Run: python -B -m unittest test_local_asr -v
Real spawned child tests use protocol fakes, never faster-whisper or real audio.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import multiprocessing
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import local_asr as asr


DATA = b'OFFLINE TEST BYTES: NOT AUDIO'
SOURCE = {'platform': 'youtube', 'source_url': 'https://example.invalid/?signature=SECRET',
          'id': 'abcdefghijk', 'title': '# Untrusted\n[click](https://evil.invalid)',
          'duration_seconds': 10.0, 'audio_format_id': '251', 'audio_language': 'en',
          'audio_track_note': 'offline fixture', 'audio_sha256': hashlib.sha256(DATA).hexdigest(),
          'audio_bytes': len(DATA), 'signature': 'SECRET', 'secret': 'SECRET'}
SEGMENT = {'id': 0, 'seek': 0, 'start': 0.0, 'end': 10.0, 'text': ' Hello world.',
           'tokens': [123, 456], 'temperature': 0.0, 'avg_logprob': -0.1,
           'no_speech_prob': 0.01, 'compression_ratio': 1.0, 'words': None}
INFO = {'duration': 10.0, 'duration_after_vad': 7.0, 'language': 'en', 'language_probability': 0.99}


def create_model(root):
    model = root / 'model'
    model.mkdir()
    for filename in asr.MODEL_FILES:
        (model / filename).write_bytes(b'offline-test-not-a-real-model')
    return model


def options(model, out, *extra):
    return asr.build_parser().parse_args([
        'transcribe', 'https://www.youtube.com/watch?v=abcdefghijk',
        '--model-dir', str(model), '--language', 'en', '--reason', 'user_requested',
        '--out', str(out), *extra])


def fake_download(target, directory, **kwargs):
    path = Path(directory) / 'audio.webm'
    path.write_bytes(DATA)
    return path, dict(SOURCE)


class FakeWorker:
    def __init__(self, config, timeout):
        self.config, self.timeout = config, timeout
        self.closed = False

    def __enter__(self):
        return self

    def ready(self):
        return {'event': 'ready', 'model': {'path': self.config['model_dir'], 'fixture': True},
                'engine_version': 'test-only'}

    def transcribe(self, audio, callback):
        callback({'event': 'info', 'info': dict(INFO)})
        callback({'event': 'segment', 'segment': dict(SEGMENT)})

    def close(self):
        self.closed = True

    def __exit__(self, *args):
        self.close()


class FailingWorker(FakeWorker):
    def ready(self):
        raise asr.ASRError('engine_not_ready')


class EngineFailingWorker(FakeWorker):
    def transcribe(self, audio, callback):
        super().transcribe(audio, callback)
        raise RuntimeError('https://bad.invalid/?token=DO-NOT-LEAK')


class InterruptedWorker(FakeWorker):
    def transcribe(self, audio, callback):
        raise KeyboardInterrupt


class InvalidWorker(FakeWorker):
    def transcribe(self, audio, callback):
        callback({'event': 'info', 'info': dict(INFO)})
        callback({'event': 'segment', 'segment': dict(SEGMENT, start=float('nan'))})


class AutoWorker(FakeWorker):
    def transcribe(self, audio, callback):
        callback({'event': 'info', 'info': dict(INFO, language='zh')})
        callback({'event': 'segment', 'segment': dict(SEGMENT, text=' 你好。')})


# Importable top-level targets are required by multiprocessing's actual spawn.
def hang_before_ready(connection, config):
    connection.recv()  # parent never sends before ready; native-load-hang stand-in


def hang_during_generation(connection, config):
    asr.send_event(connection, {'event': 'ready', 'model': {'fixture': True}, 'engine_version': 'test'})
    connection.recv()
    asr.send_event(connection, {'event': 'info', 'info': INFO})
    asr.send_event(connection, {'event': 'segment', 'segment': SEGMENT})
    threading.Event().wait()  # stand-in for blocked native generator, not a timed sleep


def successful_child(connection, config):
    asr.send_event(connection, {'event': 'ready', 'model': {'fixture': True}, 'engine_version': 'test'})
    connection.recv()
    asr.send_event(connection, {'event': 'info', 'info': INFO})
    asr.send_event(connection, {'event': 'segment', 'segment': SEGMENT})
    asr.send_event(connection, {'event': 'done'})
    connection.close()


def abrupt_child(connection, config):
    asr.send_event(connection, {'event': 'ready', 'model': {'fixture': True}, 'engine_version': 'test'})
    connection.recv()
    asr.send_event(connection, {'event': 'info', 'info': INFO})
    asr.send_event(connection, {'event': 'segment', 'segment': SEGMENT})
    connection.close()  # early exit, no done marker


class TargetContext:
    def __init__(self, target):
        self.context = multiprocessing.get_context('spawn')
        self.target = target
        self.last_process = None

    def Pipe(self, duplex=True):
        return self.context.Pipe(duplex=duplex)

    def Process(self, target, args):
        self.last_process = self.context.Process(target=self.target, args=args)
        return self.last_process


class LocalASRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='asr-offline-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.model = create_model(self.root)
        self.out = self.root / 'new-output'

    def result(self, worker=FakeWorker, downloader=fake_download, extra=()):
        return asr.transcribe(options(self.model, self.out, *extra), downloader, worker)

    def metadata(self):
        return json.loads((self.out / 'metadata.json').read_text(encoding='utf-8'))

    def failure(self):
        data = json.loads((self.out / 'failure.json').read_text(encoding='utf-8'))
        self.assertFalse(data['success'])
        self.assertFalse((self.out / 'metadata.json').exists())
        return data

    def test_model_missing_precedes_download(self):
        args = options(self.root / 'missing', self.out)
        downloader, worker = Mock(), Mock()
        result = asr.transcribe(args, downloader, worker)
        self.assertEqual(result['status'], 'model_missing')
        downloader.assert_not_called()
        worker.assert_not_called()
        self.assertEqual(self.failure()['code'], 'model_missing')

    def test_missing_tokenizer_precedes_engine_or_download(self):
        # Remove only a verified test fixture, never a user model.
        tokenizer = self.model / 'tokenizer.json'
        self.assertEqual(tokenizer.parent, self.model)
        tokenizer.unlink()
        downloader, worker = Mock(), Mock()
        result = asr.transcribe(options(self.model, self.out), downloader, worker)
        self.assertEqual(result['status'], 'model_missing')
        worker.assert_not_called()
        downloader.assert_not_called()

    def test_empty_model_is_not_ready(self):
        (self.model / 'model.bin').write_bytes(b'')
        result = self.result()
        self.assertEqual(result['status'], 'model_invalid')
        self.failure()

    def test_engine_load_forces_local_files_only(self):
        factory = Mock(return_value=SimpleNamespace(supported_languages=['en', 'zh']))
        config = {'model_dir': str(self.model), 'device': 'cpu', 'compute_type': 'int8',
                  'language': 'en', 'vad_filter': True}
        asr.load_engine(config, factory)
        factory.assert_called_once_with(str(self.model.resolve()), device='cpu',
                                        compute_type='int8', local_files_only=True)

    def test_model_load_failure_is_sanitized(self):
        factory = Mock(side_effect=RuntimeError('TOKEN https://bad.invalid'))
        config = {'model_dir': str(self.model), 'device': 'cpu', 'compute_type': 'int8',
                  'language': 'en', 'vad_filter': True}
        with self.assertRaises(asr.ASRError) as raised:
            asr.load_engine(config, factory)
        self.assertNotIn('TOKEN', str(raised.exception))

    def test_forced_en_and_transcribe_task(self):
        model = Mock()
        model.transcribe.return_value = (iter([SEGMENT]), INFO)
        config = {'language': 'en', 'vad_filter': True, 'beam_size': 5}
        segments, info = asr.iter_engine(model, 'offline.webm', config)
        self.assertEqual(list(segments), [SEGMENT])
        model.transcribe.assert_called_once_with('offline.webm', task='transcribe', language='en',
                                                 beam_size=5, vad_filter=True, word_timestamps=False)

    def test_auto_is_explicit_language_none(self):
        self.assertIsNone(asr.transcription_parameters({'language': 'auto', 'vad_filter': False})['language'])
        self.assertEqual(self.result(AutoWorker, extra=('--language', 'auto'))['status'], 'ok')
        meta = self.metadata()
        self.assertIsNone(meta['forced_language'])
        self.assertEqual(meta['language'], 'zh')
        self.assertIn('auto_language_detection_requested_language_not_forced', meta['warnings'])

    def test_ready_failure_prevents_download(self):
        downloader = Mock()
        result = self.result(FailingWorker, downloader)
        self.assertEqual(result['status'], 'engine_not_ready')
        downloader.assert_not_called()
        self.failure()

    def test_success_metadata_and_raw_engine_segments(self):
        result = self.result()
        self.assertEqual(result['status'], 'ok')
        meta = self.metadata()
        self.assertEqual(meta['caption_kind'], 'local_asr')
        self.assertEqual(meta['forced_language'], 'en')
        self.assertFalse(meta['content_verified'])
        self.assertFalse(meta['coverage_verified'])
        self.assertEqual(meta['segments'][0]['text'], SEGMENT['text'])
        self.assertEqual(meta['segments'][0]['duration'], 10)
        self.assertEqual(meta['model']['path'], str(self.model.resolve()))
        raw = json.loads((self.out / 'raw-asr.json').read_text(encoding='utf-8'))
        self.assertEqual(raw['segments'], [SEGMENT])
        self.assertEqual(raw['info']['duration_after_vad'], 7)
        self.assertEqual(raw['parameters']['task'], 'transcribe')
        self.assertEqual(raw['parameters']['language'], 'en')
        self.assertTrue(raw['parameters']['local_files_only'])
        self.assertFalse((self.out / 'failure.json').exists())
        for name in ('transcript.txt', 'transcript.md', 'transcript.srt'):
            self.assertTrue((self.out / name).is_file())

    def test_source_whitelist_canonical_url_and_no_markdown_title(self):
        self.result()
        meta = self.metadata()
        self.assertNotIn('signature', meta['source'])
        self.assertNotIn('secret', meta['source'])
        self.assertEqual(meta['source_url'], 'https://www.youtube.com/watch?v=abcdefghijk')
        md = (self.out / 'transcript.md').read_text(encoding='utf-8')
        self.assertNotIn('Untrusted', md)
        self.assertNotIn('evil.invalid', md)
        self.assertEqual(meta['title'], SOURCE['title'])

    def test_markdown_asr_text_escaped(self):
        literal = asr.markdown_literal('# h\n[x](url) <script> *b* `c`')
        self.assertIn('\\#', literal)
        self.assertIn('\\[x\\]', literal)
        self.assertIn('&lt;script&gt;', literal)
        self.assertIn('\\*b\\*', literal)

    def test_existing_output_never_overwritten(self):
        self.out.mkdir()
        original = self.out / 'original.txt'
        original.write_text('do not touch', encoding='utf-8')
        with self.assertRaises(asr.ASRError) as raised:
            self.result()
        self.assertEqual(raised.exception.code, 'output_exists')
        self.assertEqual(list(self.out.iterdir()), [original])
        self.assertEqual(original.read_text(encoding='utf-8'), 'do not touch')

    def test_relative_output_rejected(self):
        args = options(self.model, Path('not-an-absolute-path'))
        with self.assertRaises(asr.ASRError) as raised:
            asr.transcribe(args, Mock(), Mock())
        self.assertEqual(raised.exception.code, 'invalid_input')

    def test_bad_limits_fail_with_failure_file(self):
        for name in ('--asr-timeout', '--max-duration', '--max-audio-mib', '--download-timeout'):
            out = self.root / name[2:]
            result = asr.transcribe(options(self.model, out, name, 'nan'), Mock(), Mock())
            self.assertEqual(result['status'], 'invalid_input')
            self.assertTrue((out / 'failure.json').exists())

    def test_download_options_and_temporary_cleanup_success(self):
        calls = []
        def download(target, directory, **kwargs):
            self.assertEqual(list(Path(directory).iterdir()), [])
            calls.append((directory, kwargs))
            return fake_download(target, directory, **kwargs)
        self.result(downloader=download, extra=('--page', '2', '--audio-language', 'en',
                    '--audio-format', '251', '--proxy', 'http://127.0.0.1:7897',
                    '--cookies', 'explicit.txt', '--bili-cookie-file', 'explicit-bili.txt'))
        directory, kwargs = calls[0]
        self.assertFalse(Path(directory).exists())
        self.assertEqual(kwargs, {'page': 2, 'audio_language': 'en', 'audio_format': '251',
                         'proxy': 'http://127.0.0.1:7897', 'cookies': 'explicit.txt',
                         'bili_cookie_file': 'explicit-bili.txt', 'max_bytes': 536870912,
                         'max_duration': 14400, 'timeout': 300})
        self.assertTrue((self.model / 'model.bin').exists())

    def test_backend_private_session_forwarded_only_to_downloader_not_worker_or_files(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        args = options(self.model, self.out)
        args.target = 'https://www.bilibili.com/video/BV17K411P7hC/?p=27'
        args.page = 27
        args.bili_sessdata = secret
        directories = []
        def download(target, directory, **kwargs):
            self.assertEqual(kwargs['bili_sessdata'], secret)
            self.assertEqual(list(Path(directory).iterdir()), [])
            directories.append(directory)
            path, source = fake_download(target, directory, **kwargs)
            source.update(platform='bilibili', id='BV17K411P7hC', bvid='BV17K411P7hC', page=27, cid=254923561)
            return path, source
        def factory(config, timeout):
            self.assertNotIn(secret, json.dumps(config))
            self.assertNotIn('bili_sessdata', config)
            return FakeWorker(config, timeout)
        result = asr.transcribe(args, download, factory)
        self.assertEqual(result['status'], 'ok')
        self.assertFalse(Path(directories[0]).exists())
        for path in self.out.iterdir():
            self.assertNotIn(secret, path.read_text(encoding='utf-8'))
        self.assertNotIn(secret, json.dumps(result))

    def test_cli_namespace_without_private_attribute_omits_downloader_kwarg(self):
        args = options(self.model, self.out)
        self.assertFalse(hasattr(args, 'bili_sessdata'))
        def download(target, directory, **kwargs):
            self.assertNotIn('bili_sessdata', kwargs)
            return fake_download(target, directory, **kwargs)
        self.assertEqual(asr.transcribe(args, download, FakeWorker)['status'], 'ok')

    def test_backend_none_private_value_omits_downloader_kwarg(self):
        args = options(self.model, self.out)
        args.bili_sessdata = None
        def download(target, directory, **kwargs):
            self.assertNotIn('bili_sessdata', kwargs)
            return fake_download(target, directory, **kwargs)
        self.assertEqual(asr.transcribe(args, download, FakeWorker)['status'], 'ok')

    def test_private_session_downloader_exception_never_echoed_or_written(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        args = options(self.model, self.out)
        args.bili_sessdata = secret
        def download(target, directory, **kwargs):
            raise RuntimeError(secret)
        result = asr.transcribe(args, download, FakeWorker)
        self.assertEqual(result['status'], 'download_error')
        self.assertNotIn(secret, json.dumps(result))
        for path in self.out.iterdir():
            self.assertNotIn(secret, path.read_text(encoding='utf-8'))

    def test_private_session_is_not_a_cli_option(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            options(self.model, self.out, '--bili-sessdata', 'FAKE_PRIVATE_MEMORY_SESSION')
        self.assertEqual(caught.exception.code, 2)

    def test_download_failure_safe_and_cleanup(self):
        directories = []
        def download(target, directory, **kwargs):
            directories.append(directory)
            (Path(directory) / 'partial').write_bytes(DATA)
            raise RuntimeError('https://bad.invalid/?token=SECRET')
        result = self.result(downloader=download)
        self.assertEqual(result['status'], 'download_error')
        self.assertFalse(Path(directories[0]).exists())
        failure = self.failure()
        self.assertNotIn('SECRET', json.dumps(failure))

    def test_known_audio_source_error_candidates_preserved(self):
        from audio_sources import AudioSourceError
        safe_message = '请明确选择音轨；可选格式 140/en, 251/zh。'
        def download(*args, **kwargs):
            raise AudioSourceError('audio_track_ambiguous', safe_message)
        result = self.result(downloader=download)
        self.assertEqual(result['status'], 'audio_track_ambiguous')
        self.assertEqual(result['message'], safe_message)
        self.assertEqual(result['audio_error'], {'code': 'audio_track_ambiguous', 'message': safe_message})
        self.assertEqual(self.failure()['audio_error'], result['audio_error'])

    def test_audio_source_warnings_promoted_to_metadata_and_cli(self):
        def download(target, directory, **kwargs):
            path, source = fake_download(target, directory, **kwargs)
            source['warnings'] = ['unknown audio language: manually verify']
            source['identity_verification'] = 'api_cid'
            return path, source
        result = self.result(downloader=download)
        warning = 'audio_source: unknown audio language: manually verify'
        self.assertIn(warning, result['warnings'])
        self.assertIn(warning, self.metadata()['warnings'])
        self.assertEqual(self.metadata()['source']['identity_verification'], 'api_cid')

    def test_srt_rounding_cannot_create_zero_duration(self):
        with self.assertRaises(asr.ASRError) as raised:
            asr.validate_segments([dict(SEGMENT, start=1.00001, end=1.00002)], INFO, SOURCE, 14400)
        self.assertEqual(raised.exception.code, 'invalid_timestamp')

    def test_engine_exception_preserves_partial_raw_and_cleanup(self):
        directories = []
        def download(target, directory, **kwargs):
            directories.append(directory)
            return fake_download(target, directory, **kwargs)
        result = self.result(EngineFailingWorker, download)
        self.assertEqual(result['status'], 'asr_error')
        self.assertFalse(Path(directories[0]).exists())
        self.failure()
        raw = (self.out / 'raw-asr.json').read_text(encoding='utf-8')
        self.assertNotIn('DO-NOT-LEAK', raw)
        self.assertEqual(json.loads(raw)['status'], 'failed')
        self.assertEqual(json.loads(raw)['segments'], [SEGMENT])

    def test_keyboard_interrupt_cleanup(self):
        directories = []
        workers = []
        def factory(config, timeout):
            worker = InterruptedWorker(config, timeout)
            workers.append(worker)
            return worker
        def download(target, directory, **kwargs):
            directories.append(directory)
            return fake_download(target, directory, **kwargs)
        result = self.result(factory, download)
        self.assertEqual(result['status'], 'cancelled')
        self.assertTrue(workers[0].closed)
        self.assertFalse(Path(directories[0]).exists())
        self.failure()

    def test_nan_raw_is_preserved_safely_and_failure(self):
        result = self.result(InvalidWorker)
        self.assertEqual(result['status'], 'invalid_timestamp')
        raw = json.loads((self.out / 'raw-asr.json').read_text(encoding='utf-8'))
        self.assertEqual(raw['segments'][0]['start'], 'nan')
        self.failure()

    def test_invalid_time_values(self):
        bad = ((-1, 1), (0, 0), (2, 1), (float('nan'), 1), (0, float('inf')),
               (True, 1), ('0', 1), (0, 10.1))
        for start, end in bad:
            with self.subTest(start=start, end=end), self.assertRaises(asr.ASRError):
                asr.validate_segments([dict(SEGMENT, start=start, end=end)], INFO, SOURCE, 14400)

    def test_segment_declared_duration_must_match(self):
        with self.assertRaises(asr.ASRError) as raised:
            asr.validate_segments([dict(SEGMENT, duration=9)], INFO, SOURCE, 14400)
        self.assertEqual(raised.exception.code, 'duration_mismatch')

    def test_source_and_decoded_duration_must_match(self):
        with self.assertRaises(asr.ASRError):
            asr.validate_segments([SEGMENT], dict(INFO, duration=20), SOURCE, 14400)

    def test_empty_output_explicit_failure(self):
        for segments in ([], [dict(SEGMENT, text='  ')]):
            with self.assertRaises(asr.ASRError) as raised:
                asr.validate_segments(segments, INFO, SOURCE, 14400)
            self.assertEqual(raised.exception.code, 'empty_output')

    def test_vad_timestamps_not_rebased(self):
        segment = dict(SEGMENT, start=5.0, end=10.0)
        normalized, _, _ = asr.validate_segments([segment], INFO, SOURCE, 14400)
        self.assertEqual(normalized[0]['start'], 5.0)
        self.assertEqual(normalized[0]['end'], 10.0)

    def test_low_confidence_and_repetition_preserved(self):
        one = dict(SEGMENT, end=5, avg_logprob=-2, no_speech_prob=0.8, compression_ratio=3)
        two = dict(one, start=5, end=10)
        normalized, _, warnings = asr.validate_segments([one, two], INFO, SOURCE, 14400)
        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[0]['text'], normalized[1]['text'])
        self.assertTrue(any('low_confidence' in warning for warning in warnings))
        self.assertTrue(any('repeated_text_preserved' in warning for warning in warnings))

    def test_early_end_warned_not_false_complete_claim(self):
        _, _, warnings = asr.validate_segments([dict(SEGMENT, end=5)],
                dict(INFO, duration=120), dict(SOURCE, duration_seconds=120), 14400)
        self.assertIn('trailing_audio_without_transcribed_text_possible_early_stop', warnings)

    def test_wrong_audio_hash_fails(self):
        def download(target, directory, **kwargs):
            audio, meta = fake_download(target, directory, **kwargs)
            meta['audio_sha256'] = '0' * 64
            return audio, meta
        self.assertEqual(self.result(downloader=download)['status'], 'audio_invalid')
        self.failure()

    def test_audio_outside_temporary_directory_rejected_without_delete(self):
        original = self.root / 'original-audio'
        original.write_bytes(DATA)
        def download(*args, **kwargs):
            return original, SOURCE
        self.assertEqual(self.result(downloader=download)['status'], 'audio_invalid')
        self.assertEqual(original.read_bytes(), DATA)

    def test_status_is_static_honest_and_no_network(self):
        args = asr.build_parser().parse_args(['status', '--model-dir', str(self.model)])
        with patch.object(asr, 'dependency_versions', return_value={name: None for name in asr.DEPENDENCIES}):
            report = asr.status_report(args)
        self.assertEqual(report['status'], 'dependency_missing')
        self.assertFalse(report['runtime_ready'])
        self.assertFalse(report['network_used'])
        self.assertTrue(report['model']['exists'])

    def test_status_does_not_confuse_present_files_with_runtime_success(self):
        args = asr.build_parser().parse_args(['status', '--model-dir', str(self.model)])
        with patch.object(asr, 'dependency_versions', return_value={name: 'test' for name in asr.DEPENDENCIES}):
            report = asr.status_report(args)
        self.assertEqual(report['status'], 'not_runtime_checked')
        self.assertFalse(report['runtime_ready'])

    def test_cli_status_returns_non_success_json(self):
        with contextlib.redirect_stdout(io.StringIO()) as captured, \
                patch.object(asr, 'dependency_versions', return_value={name: None for name in asr.DEPENDENCIES}):
            code = asr.main(['status'])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(captured.getvalue())['status'], 'dependency_missing')


class SpawnedWorkerTests(unittest.TestCase):
    def test_real_spawn_load_hang_timeout_and_reap(self):
        context = TargetContext(hang_before_ready)
        session = asr.WorkerSession({}, 0.4, context=context)
        started = time.monotonic()
        with self.assertRaises(asr.ASRError) as raised:
            with session:
                session.ready()
        self.assertEqual(raised.exception.code, 'asr_timeout')
        self.assertTrue(session.closed)
        self.assertLess(time.monotonic() - started, 8)
        session.close()  # idempotent, even after Process.close()

    def test_real_spawn_generator_hang_timeout_and_reap(self):
        context = TargetContext(hang_during_generation)
        events = []
        session = asr.WorkerSession({}, 5, context=context)
        with self.assertRaises(asr.ASRError) as raised:
            with session:
                session.ready()
                session.timeout = 0.4
                session.transcribe('unused-test-path', events.append)
        self.assertEqual(raised.exception.code, 'asr_timeout')
        self.assertTrue(session.closed)
        self.assertTrue(any(event['event'] == 'segment' for event in events))

    def test_real_spawn_abrupt_exit_does_not_mean_success(self):
        context = TargetContext(abrupt_child)
        session = asr.WorkerSession({}, 5, context=context)
        with self.assertRaises(asr.ASRError) as raised:
            with session:
                session.ready()
                session.transcribe('unused-test-path', lambda event: None)
        self.assertEqual(raised.exception.code, 'worker_failed')
        self.assertTrue(session.closed)

    def test_real_spawn_success_protocol(self):
        context = TargetContext(successful_child)
        events = []
        session = asr.WorkerSession({}, 5, context=context)
        with session:
            self.assertEqual(session.ready()['event'], 'ready')
            session.transcribe('unused-test-path', events.append)
        self.assertEqual([e['event'] for e in events], ['info', 'segment'])
        self.assertTrue(session.closed)

    def test_partial_pipe_frame_cannot_block_deadline_thread(self):
        released = threading.Event()
        parent, child, process, context = Mock(), Mock(), Mock(), Mock()
        def blocked_recv(maxlength):
            released.wait()
            raise EOFError
        parent.recv_bytes.side_effect = blocked_recv
        parent.close.side_effect = released.set
        process.is_alive.side_effect = [True, False, False, False]
        context.Pipe.return_value = (parent, child)
        context.Process.return_value = process
        session = asr.WorkerSession({}, 0.1, context=context)
        with self.assertRaises(asr.ASRError) as raised:
            with session:
                session.ready()
        self.assertEqual(raised.exception.code, 'asr_timeout')
        process.terminate.assert_called_once()
        self.assertFalse(session.reader.is_alive())
        self.assertTrue(session.closed)

    def test_oversized_ipc_record_is_rejected_before_send(self):
        connection = Mock()
        with patch.object(asr, 'MAX_IPC_BYTES', 16), self.assertRaises(asr.ASRError):
            asr.send_event(connection, {'event': 'segment', 'segment': 'large payload'})
        connection.send_bytes.assert_not_called()

    def test_real_spawn_timeout_bundle_has_failure_and_audio_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='asr-spawn-bundle-test-') as directory:
            root = Path(directory)
            model = create_model(root)
            out = root / 'new-output'
            audio_directories = []
            sessions = []
            def factory(config, timeout):
                session = asr.WorkerSession(config, 5, context=TargetContext(hang_during_generation))
                original_ready = session.ready
                def ready():
                    event = original_ready()
                    session.timeout = 0.2
                    return event
                session.ready = ready
                sessions.append(session)
                return session
            def download(target, audio_dir, **kwargs):
                audio_directories.append(audio_dir)
                return fake_download(target, audio_dir, **kwargs)
            result = asr.transcribe(options(model, out), download, factory)
            self.assertEqual(result['status'], 'asr_timeout')
            self.assertTrue(sessions[0].closed)
            self.assertFalse(sessions[0].reader.is_alive())
            self.assertFalse(Path(audio_directories[0]).exists())
            failure = json.loads((out / 'failure.json').read_text(encoding='utf-8'))
            self.assertFalse(failure['success'])
            self.assertEqual(failure['code'], 'asr_timeout')
            self.assertFalse((out / 'metadata.json').exists())
            self.assertTrue((model / 'model.bin').exists())

    def test_terminate_then_kill_and_join_if_required(self):
        process = Mock()
        process.is_alive.side_effect = [True, True, False, False]
        session = asr.WorkerSession({}, 1)
        session.process, session.started = process, True
        session.connection, session.child_connection = Mock(), Mock()
        session.close()
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.join.call_count, 2)
        process.close.assert_called_once()
        self.assertTrue(session.closed)


if __name__ == '__main__':
    multiprocessing.freeze_support()
    unittest.main()
