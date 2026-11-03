"""Offline regression: scratch ownership, no implicit temp fallback, safe cleanup."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import audio_prepare
import audio_sources
import runner
import test_runner as runner_fixtures
import test_transport as transport_fixtures
import ytstudy


class TaskTempTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='task-temp-offline-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.out = self.root / 'session-output' / 'result'
        self.config = {'mode': 'cloud', 'cloudEndpoint': 'https://asr.example.test/v1/audio/transcriptions',
                       'cloudModel': 'whisper-1', 'cloudApiKey': runner_fixtures.KEY,
                       'cloudUploadConsent': True}
        self.request = {'target': runner_fixtures.TARGET, 'out': str(self.out),
                        'language': 'en', 'config': self.config}

    def no_system_temp(self):
        return patch.object(tempfile, 'gettempdir', side_effect=AssertionError('system temp forbidden'))

    def cloud(self, download=None, transcribe=None):
        return runner.cloud_extract(self.request, self.config, self.out, 'user_requested',
                                    download or runner_fixtures.fake_audio,
                                    transcribe or runner_fixtures.fake_cloud)

    def test_cloud_audio_owned_by_output_not_cwd_or_environment(self):
        seen = []
        environment = dict(os.environ)
        def download(target, directory, **kwargs):
            path = Path(directory)
            seen.append(path)
            self.assertEqual(path.parent, self.out)
            self.assertTrue(path.is_absolute())
            self.assertEqual(list(path.iterdir()), [])
            return runner_fixtures.fake_audio(target, directory, **kwargs)
        with self.no_system_temp():
            self.assertEqual(self.cloud(download=download)['status'], 'ok')
        self.assertFalse(seen[0].exists())
        self.assertTrue((self.out / 'transcript.txt').is_file())
        self.assertEqual(dict(os.environ), environment)

    def test_cloud_failures_and_cancellation_clean_only_scratch(self):
        for index, error in enumerate((RuntimeError('fixture'), KeyboardInterrupt())):
            for stage in ('download', 'transcribe'):
                self.out = self.root / f'{index}-{stage}'
                seen = []
                def download(target, directory, **kwargs):
                    seen.append(Path(directory))
                    result = runner_fixtures.fake_audio(target, directory, **kwargs)
                    (self.out / 'preserve.txt').write_text('existing body', encoding='utf-8')
                    if stage == 'download':
                        raise error
                    return result
                def transcribe(*args, **kwargs):
                    raise error
                with self.subTest(stage=stage, error=type(error).__name__), self.no_system_temp():
                    with self.assertRaises(type(error)):
                        self.cloud(download, transcribe)
                self.assertFalse(seen[0].exists())
                self.assertEqual((self.out / 'preserve.txt').read_text(encoding='utf-8'), 'existing body')
                self.assertTrue((self.out / 'failure.json').is_file())

    def test_cloud_temp_write_denied_never_falls_back_or_downloads(self):
        download, transcribe = Mock(), Mock()
        with self.no_system_temp(), patch.object(tempfile, 'mkdtemp', side_effect=PermissionError('denied')) as create:
            with self.assertRaises(PermissionError):
                self.cloud(download, transcribe)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(Path(create.call_args.args[2]), self.out)
        download.assert_not_called()
        transcribe.assert_not_called()
        self.assertTrue((self.out / 'failure.json').is_file())

    def test_pure_status_creates_neither_output_nor_scratch(self):
        with patch.object(Path, 'mkdir', side_effect=AssertionError('status writes')), \
             patch.object(tempfile, 'mkdtemp', side_effect=AssertionError('status temp')):
            result = runner.dispatch({'operation': 'status', 'out': str(self.out), 'config': {}})
        self.assertEqual(result['status'], 'ok')
        self.assertFalse(self.out.exists())
        self.assertFalse(self.out.parent.exists())

    def caption(self, **fake_options):
        fixture = transport_fixtures.TransportTests()
        modules, state = fixture.fake(**fake_options)
        args = fixture.args(self.out.parent)
        args.out = str(self.out)
        return modules, state, args

    def test_caption_cookie_and_ydl_scratch_follow_output_parent(self):
        modules, state, args = self.caption()
        original = self.root / 'authorized-cookie.txt'
        original.write_bytes(b'# Netscape HTTP Cookie File\n')
        args.cookies = str(original)
        with self.no_system_temp(), patch.dict(sys.modules, modules):
            self.assertEqual(ytstudy.extract(args)['status'], 'ok')
        options = state['options']
        scratch = Path(options['paths']['temp'])
        self.assertEqual(scratch.parent, self.out.parent)
        self.assertEqual(options['paths']['home'], str(scratch))
        self.assertEqual(Path(options['outtmpl']).parent, scratch)
        self.assertEqual(Path(options['cookiefile']).parent, scratch)
        self.assertFalse(scratch.exists())
        self.assertEqual(original.read_bytes(), b'# Netscape HTTP Cookie File\n')
        self.assertTrue((self.out / 'original.vtt').exists())

    def test_caption_absence_and_extractor_failure_leave_no_final_output(self):
        for index, fake_options in enumerate(({'meta': {'id': 'bGRhS_f6EdM'}},
                                              {'failure': 'HTTP 403'})):
            self.out = self.root / f'caption-{index}' / 'result'
            modules, state, args = self.caption(**fake_options)
            with self.no_system_temp(), patch.dict(sys.modules, modules):
                with self.assertRaises(ytstudy.StudyError):
                    ytstudy.extract(args)
            self.assertFalse(Path(state['options']['paths']['temp']).exists())
            self.assertFalse(self.out.exists())
            self.assertEqual(list(self.out.parent.iterdir()), [])

    def test_caption_parse_failure_preserves_raw_but_removes_scratch(self):
        modules, state, args = self.caption(payload=b'\xff')
        with self.no_system_temp(), patch.dict(sys.modules, modules):
            with self.assertRaises(ytstudy.StudyError):
                ytstudy.extract(args)
        self.assertEqual((self.out / 'original.vtt').read_bytes(), b'\xff')
        self.assertFalse(Path(state['options']['paths']['temp']).exists())

    def test_caption_temp_denied_does_not_call_dependency_or_fallback(self):
        modules, state, args = self.caption()
        with self.no_system_temp(), patch.dict(sys.modules, modules), \
             patch.object(tempfile, 'mkdtemp', side_effect=PermissionError('denied')) as create:
            with self.assertRaises(PermissionError):
                ytstudy.extract(args)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(Path(create.call_args.args[2]), self.out.parent)
        self.assertIsNone(state['options'])
        self.assertFalse(self.out.exists())

    def prepare(self):
        directory = self.root / 'audio'
        directory.mkdir()
        path = directory / 'audio.m4a'
        path.write_bytes(b'fake audio')
        source = {'duration_seconds': 10, 'audio_bytes': path.stat().st_size,
                  'audio_sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        options = {'protocol': 'volcengine_flash', 'timeout': 30, 'max_bytes': 1024}
        return directory, path, source, options

    def test_ffmpeg_private_temp_cleaned_and_environment_not_inherited(self):
        directory, path, source, options = self.prepare()
        processes = []
        def popen(argv, **kwargs):
            processes.append(runner_fixtures.FakeProcess(argv, **kwargs))
            scratch = Path(kwargs['env']['TMP'])
            self.assertEqual(scratch.parent, directory)
            self.assertEqual(kwargs['env'], {key: str(scratch) for key in ('TMP', 'TEMP', 'TMPDIR')})
            self.assertEqual(kwargs['cwd'], str(scratch))
            (scratch / 'fake-tool-sidecar').write_bytes(b'fake')
            return processes[-1]
        environment = dict(os.environ)
        with self.no_system_temp(), patch.object(audio_prepare.shutil, 'which', return_value='fake-ffmpeg'), \
             patch.object(audio_prepare.subprocess, 'Popen', side_effect=popen):
            output, _ = audio_prepare.prepare_cloud_audio(path, directory, source, options)
        self.assertTrue(output.is_file())
        self.assertFalse(Path(processes[0].kwargs['env']['TMP']).exists())
        self.assertEqual(dict(os.environ), environment)
        self.assertEqual(path.read_bytes(), b'fake audio')

    def test_ffmpeg_failure_and_cancellation_clean_owned_outputs_not_input(self):
        directory, path, source, options = self.prepare()
        sentinel = directory / 'preserve.txt'
        sentinel.write_text('body', encoding='utf-8')
        for error in (RuntimeError('fixture'), KeyboardInterrupt()):
            process = runner_fixtures.FakeProcess([], env={})
            def popen(argv, **kwargs):
                process.argv, process.kwargs = argv, kwargs
                Path(kwargs['env']['TMP'], 'sidecar').write_bytes(b'fake')
                return process
            with self.no_system_temp(), patch.object(audio_prepare.shutil, 'which', return_value='fake-ffmpeg'), \
                 patch.object(audio_prepare.subprocess, 'Popen', side_effect=popen), \
                 patch.object(process, 'wait', side_effect=[error, 0]):
                expected = KeyboardInterrupt if isinstance(error, KeyboardInterrupt) else audio_prepare.CloudASRError
                with self.assertRaises(expected):
                    audio_prepare.prepare_cloud_audio(path, directory, source, options)
            self.assertEqual(set(directory.iterdir()), {path, sentinel})
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'body')
            self.assertIsNotNone(process.returncode)

    def test_ffmpeg_denied_temp_has_no_fallback_or_process(self):
        directory, path, source, options = self.prepare()
        with self.no_system_temp(), patch.object(audio_prepare.shutil, 'which', return_value='fake-ffmpeg'), \
             patch.object(tempfile, 'mkdtemp', side_effect=PermissionError('denied')) as create, \
             patch.object(audio_prepare.subprocess, 'Popen') as process:
            with self.assertRaises(audio_prepare.CloudASRError):
                audio_prepare.prepare_cloud_audio(path, directory, source, options)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(Path(create.call_args.args[2]), directory)
        process.assert_not_called()
        self.assertEqual(list(directory.iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
