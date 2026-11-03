"""Pure fake-process tests for local Volcengine audio preparation (no real ffmpeg)."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from test_cloud_asr import KEY

SPEC = importlib.util.spec_from_file_location('test_audio_prepare_module',
                                              Path(__file__).parents[1] / 'python' / 'audio_prepare.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
MP3 = b'ID3\x04\x00\x00\x00\x00\x00\x00fake-mp3-payload'
SOURCE = {'platform': 'bilibili', 'id': 'BV1xx411c7mD', 'title': 'PRIVATE_TITLE', 'bvid': 'BV1xx411c7mD',
          'page': 1, 'duration_seconds': 120.5, 'warnings': ['platform_duration_not_verified']}


class Process:
    instances = []

    def __init__(self, argv, **kwargs):
        self.argv = list(argv)
        self.kwargs = kwargs
        self.returncode = None
        self.killed = 0
        self.waits = []
        self.payload = MP3
        self.exit_code = 0
        self.always_pending = False
        Process.instances.append(self)

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.always_pending:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        self.returncode = self.exit_code
        if self.exit_code == 0:
            Path(self.argv[-1]).write_bytes(self.payload)
        return self.returncode

    def kill(self):
        self.killed += 1
        self.returncode = -9


class Tests(unittest.TestCase):
    def setUp(self):
        Process.instances = []
        temporary = tempfile.TemporaryDirectory(prefix='fake-prepare-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.audio = self.directory / 'audio.m4a'
        self.audio.write_bytes(b'fake-m4a-container')
        self.source = dict(SOURCE, audio_bytes=self.audio.stat().st_size,
                           audio_sha256=hashlib.sha256(self.audio.read_bytes()).hexdigest())
        self.options = {'protocol': 'volcengine_flash', 'timeout': 30, 'max_bytes': 25 * 1024 * 1024,
                        'api_key': KEY, 'language': 'auto'}
        self.which = patch.object(m, 'shutil', SimpleNamespace(which=lambda name: self.ffmpeg())).start()
        self.popens = patch.object(m, 'subprocess', SimpleNamespace(
            Popen=Process, DEVNULL=subprocess.DEVNULL,
            TimeoutExpired=subprocess.TimeoutExpired)).start()
        self.addCleanup(patch.stopall)
        self.ffmpeg_path = 'C:/fake/bin/ffmpeg.exe'

    def ffmpeg(self):
        return self.ffmpeg_path

    def invoke(self, **changes):
        return m.prepare_cloud_audio(self.audio, self.directory,
                                     dict(self.source, **{k: v for k, v in changes.items() if k in self.source}),
                                     {**self.options, **{k: v for k, v in changes.items() if k in self.options}})

    def error(self, code, **changes):
        with self.assertRaises(m.CloudASRError) as caught:
            self.invoke(**changes)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)
        return caught.exception

    def test_direct_formats_and_other_protocols_never_transcode(self):
        for name, protocol in (('audio.mp3', 'volcengine_flash'), ('audio.wav', 'volcengine_flash'),
                               ('audio.ogg', 'volcengine_flash'), ('audio.opus', 'volcengine_flash'),
                               ('audio.m4a', 'tencent_rec_task'), ('audio.m4a', 'openai')):
            with self.subTest(name=name, protocol=protocol):
                path = self.directory / name
                path.write_bytes(b'x')
                source = dict(self.source, audio_bytes=1, audio_sha256=hashlib.sha256(b'x').hexdigest())
                result = m.prepare_cloud_audio(path, self.directory, source,
                                               dict(self.options, protocol=protocol))
                self.assertEqual(result, (path, source))
        self.assertEqual(Process.instances, [])

    def test_m4a_transcodes_with_fixed_offline_argv(self):
        path, source = self.invoke()
        process = Process.instances[0]
        self.assertEqual(process.argv[0], self.ffmpeg_path)
        self.assertEqual(process.argv[1:5], ['-nostdin', '-hide_banner', '-loglevel', 'error'])
        self.assertEqual(process.argv[process.argv.index('-protocol_whitelist') + 1], 'file,pipe')
        self.assertEqual(process.argv[process.argv.index('-f') + 1], 'mov')
        self.assertEqual(process.argv[process.argv.index('-i') + 1], str(self.audio))
        self.assertEqual(process.argv[process.argv.index('-c:a') + 1], 'libmp3lame')
        self.assertEqual(process.argv[process.argv.index('-ac') + 1], '1')
        self.assertEqual(process.argv[process.argv.index('-ar') + 1], '16000')
        self.assertNotIn('-t', process.argv)
        self.assertNotIn('-fs', process.argv)
        self.assertFalse(any('http' in item or '://' in item for item in process.argv))
        self.assertNotIn(KEY, ' '.join(process.argv))
        self.assertEqual(process.kwargs['stdin'], subprocess.DEVNULL)
        self.assertEqual(process.kwargs['stdout'], subprocess.DEVNULL)
        self.assertEqual(process.kwargs['stderr'], subprocess.DEVNULL)
        child_env = process.kwargs['env']
        self.assertEqual(set(child_env), {'TMP', 'TEMP', 'TMPDIR'})
        scratch = Path(child_env['TMP'])
        self.assertEqual(set(child_env.values()), {str(scratch)})
        self.assertEqual(scratch.parent, self.directory)
        self.assertEqual(process.kwargs['cwd'], str(scratch))
        self.assertFalse(scratch.exists())
        self.assertIs(process.kwargs['shell'], False)
        self.assertEqual(path.suffix, '.mp3')
        self.assertEqual(path.read_bytes(), MP3)
        self.assertEqual(source['audio_bytes'], len(MP3))
        self.assertEqual(source['audio_sha256'], hashlib.sha256(MP3).hexdigest())
        self.assertEqual(source['duration_seconds'], 120.5)
        self.assertEqual(source['warnings'], ['platform_duration_not_verified', 'local_audio_transcoded'])
        self.assertEqual(source['title'], 'PRIVATE_TITLE')
        self.assertEqual(self.audio.read_bytes(), b'fake-m4a-container')
        self.assertEqual(process.killed, 0)

    def test_webm_uses_explicit_matroska_demuxer_and_keeps_source_immutable(self):
        self.audio = self.directory / 'audio.webm'
        self.audio.write_bytes(b'fake-webm')
        self.source.update(audio_bytes=self.audio.stat().st_size,
                           audio_sha256=hashlib.sha256(b'fake-webm').hexdigest())
        _, source = self.invoke()
        argv = Process.instances[0].argv
        self.assertEqual(argv[argv.index('-f') + 1], 'matroska')
        self.assertEqual(self.audio.read_bytes(), b'fake-webm')
        self.assertEqual(source['warnings'].count('local_audio_transcoded'), 1)

    def test_missing_ffmpeg_is_dependency_missing(self):
        self.ffmpeg_path = None
        self.error('dependency_missing')
        self.assertEqual(Process.instances, [])

    def test_failed_conversion_is_fixed_audio_invalid(self):
        def fail(process, timeout=None):
            process.returncode = 1
            return 1

        with patch.object(Process, 'wait', fail):
            self.error('audio_invalid')
        self.assertEqual(Process.instances[0].killed, 0)
        self.assertNotIn('PRIVATE_TITLE', str(self.audio))

    def test_budget_expiry_kills_and_reaps_without_retry(self):
        with patch.object(Process, 'wait', lambda process, timeout=None: (_ for _ in ()).throw(
                subprocess.TimeoutExpired(process.argv, timeout))):
            self.error('timeout', timeout=0.2)
        process = Process.instances[0]
        self.assertGreaterEqual(process.killed, 1)
        self.assertEqual(len(Process.instances), 1)

    def test_oversized_output_is_killed_and_never_truncated(self):
        def big(process, timeout=None):
            # Still running: only the size guard can stop it, then reap it.
            Path(process.argv[-1]).write_bytes(b'z' * 2048)
            return None

        with patch.object(Process, 'wait', big):
            self.error('audio_too_large', max_bytes=1024)
        self.assertGreaterEqual(Process.instances[0].killed, 1)
        self.assertNotIn('-fs', Process.instances[0].argv)

    def test_source_must_match_requested_identity(self):
        self.source['audio_sha256'] = '0' * 64
        self.error('audio_invalid')
        self.assertEqual(Process.instances, [])

    def test_source_size_and_duration_bounds(self):
        for change in ({'audio_bytes': 1}, {'duration_seconds': 7200.5},
                       {'duration_seconds': 0}, {'duration_seconds': '120'}, {'warnings': 'none'}):
            with self.subTest(change=change):
                Process.instances = []
                self.source = dict(SOURCE, audio_bytes=self.audio.stat().st_size,
                                   audio_sha256=hashlib.sha256(self.audio.read_bytes()).hexdigest())
                self.source.update(change)
                code = 'audio_invalid'
                with self.assertRaises(m.CloudASRError) as caught:
                    self.invoke()
                self.assertEqual(caught.exception.code, code)

    def test_unknown_container_and_foreign_directory_rejected(self):
        other = self.directory / 'sub'
        other.mkdir()
        for name in ('audio.m4b', 'audio'):
            audio = other / name
            audio.write_bytes(b'x')
            with self.subTest(name=name), self.assertRaises(m.CloudASRError) as caught:
                m.prepare_cloud_audio(audio, self.directory, dict(self.source, audio_bytes=1,
                                                                   audio_sha256=hashlib.sha256(b'x').hexdigest()),
                                      self.options)
            self.assertEqual(caught.exception.code, 'audio_invalid')
        self.assertEqual(Process.instances, [])

    def test_empty_key_environment_cannot_inherit_credentials(self):
        _, source = self.invoke()
        process = Process.instances[0]
        child_env = process.kwargs['env']
        self.assertEqual(set(child_env), {'TMP', 'TEMP', 'TMPDIR'})
        scratch = Path(child_env['TMP'])
        self.assertEqual(set(child_env.values()), {str(scratch)})
        self.assertEqual(scratch.parent, self.directory)
        self.assertEqual(process.kwargs['cwd'], str(scratch))
        self.assertFalse(scratch.exists())
        dumped = json.dumps({'argv': process.argv, 'env': process.kwargs['env']})
        self.assertNotIn(KEY, dumped)
        self.assertNotIn('PRIVATE_TITLE', dumped)
        self.assertIn('local_audio_transcoded', source['warnings'])


if __name__ == '__main__':
    unittest.main()
