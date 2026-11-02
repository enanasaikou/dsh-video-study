"""Offline transport contract tests; no yt-dlp installation or network needed."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import ytstudy as y


class Request:
    def __init__(self, url, headers=None):
        self.url, self.headers = url, headers


class TransportTests(unittest.TestCase):
    def args(self, root, **extra):
        values = dict(target='bGRhS_f6EdM', proxy='http://127.0.0.1:7897', cookies=None,
                      lang='en,zh', allow_other=True, list_languages=False, no_dedupe=False,
                      out=str(root / 'result'))
        values.update(extra)
        return argparse.Namespace(**values)

    def fake(self, meta=None, payload=None, failure=None, warning=False, exit_failure=False):
        state = {'requests': [], 'downloads': [], 'options': None}
        if meta is None:
            meta = {'id': 'bGRhS_f6EdM', 'title': 'Offline fixture', 'http_headers': {'Referer': 'source'},
                    'automatic_captions': {'en': [{'ext': 'vtt', 'url': 'https://captions.test/en',
                                                  'http_headers': {'User-Agent': 'fixture'}}]}}
        if payload is None:
            payload = b'WEBVTT\n\n00:00.000 --> 00:01.000\n123\n'
        class YDL:
            def __init__(self, opts):
                state['options'] = opts
            def __enter__(self):
                if warning:
                    state['options']['logger'].warning('fixture warning')
                return self
            def __exit__(self, *args):
                cookie = state['options']['cookiefile']
                if cookie:
                    Path(cookie).write_text('changed by dependency', encoding='utf-8')
                if exit_failure:
                    raise RuntimeError('cookie save failure')
            def extract_info(self, url, download):
                state['downloads'].append(download)
                if failure:
                    raise RuntimeError(failure)
                return meta
            def urlopen(self, request):
                state['requests'].append(request)
                return io.BytesIO(payload)
        mod = types.ModuleType('yt_dlp')
        mod.YoutubeDL = YDL
        ver = types.ModuleType('yt_dlp.version')
        ver.__version__ = 'offline-fixture'
        net = types.ModuleType('yt_dlp.networking')
        net.Request = Request
        return {'yt_dlp': mod, 'yt_dlp.version': ver, 'yt_dlp.networking': net}, state

    def test_extract_only_subtitle_and_headers(self):
        mods, state = self.fake()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            root = Path(tmp)
            result = y.extract(self.args(root))
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(state['downloads'], [False])
            self.assertEqual(len(state['requests']), 1)
            self.assertEqual(state['requests'][0].url, 'https://captions.test/en')
            self.assertEqual(state['requests'][0].headers, {'Referer': 'source', 'User-Agent': 'fixture'})
            self.assertEqual(state['options']['proxy'], 'http://127.0.0.1:7897')
            self.assertIsNone(state['options']['cookiefile'])
            self.assertEqual((root/'result'/'original.vtt').read_bytes(), b'WEBVTT\n\n00:00.000 --> 00:01.000\n123\n')

    def test_cookie_original_not_modified(self):
        mods, state = self.fake()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            root = Path(tmp)
            cookie = root / 'user-cookies.txt'
            cookie.write_bytes(b'# Netscape HTTP Cookie File\n')
            original = cookie.read_bytes()
            y.extract(self.args(root, cookies=str(cookie)))
            self.assertEqual(cookie.read_bytes(), original)
            self.assertNotEqual(state['options']['cookiefile'], str(cookie))
            self.assertFalse(Path(state['options']['cookiefile']).exists())

    def test_languages_never_download(self):
        mods, state = self.fake()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            result = y.extract(self.args(Path(tmp), list_languages=True))
            self.assertEqual(result['languages'][0]['language'], 'en')
            self.assertEqual(state['requests'], [])

    def test_network_not_no_captions(self):
        for message, expected in [('HTTP 429', 'rate_limited'), ('HTTP 403', 'platform_restricted'),
                                  ('Connection refused', 'network_error'), ('Sign in to confirm', 'login_required')]:
            mods, _ = self.fake(failure=message)
            with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
                with self.assertRaises(y.StudyError) as cm:
                    y.extract(self.args(Path(tmp)))
                self.assertEqual(cm.exception.code, expected)

    def test_incomplete_metadata(self):
        mods, _ = self.fake(meta={'id': 'bGRhS_f6EdM'}, warning=True)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            with self.assertRaises(y.StudyError) as cm:
                y.extract(self.args(Path(tmp)))
            self.assertEqual(cm.exception.code, 'incomplete_metadata')

    def test_confirmed_no_captions(self):
        mods, _ = self.fake(meta={'id': 'bGRhS_f6EdM'})
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            with self.assertRaises(y.StudyError) as cm:
                y.extract(self.args(Path(tmp)))
            self.assertEqual(cm.exception.code, 'no_captions')

    def test_unsupported_not_no_captions(self):
        mods, _ = self.fake(meta={'id': 'bGRhS_f6EdM', 'subtitles': {'en': [{'ext': 'json3', 'url': 'x'}]}})
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            with self.assertRaises(y.StudyError) as cm:
                y.extract(self.args(Path(tmp)))
            self.assertEqual(cm.exception.code, 'unsupported_subtitle_format')

    def test_bad_encoding_raw_retained(self):
        mods, _ = self.fake(payload=b'\xff\xff')
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            root = Path(tmp)
            with self.assertRaises(y.StudyError) as cm:
                y.extract(self.args(root))
            self.assertEqual(cm.exception.code, 'parse_error')
            self.assertEqual((root/'result'/'original.vtt').read_bytes(), b'\xff\xff')

    def test_existing_output_not_overwritten(self):
        mods, state = self.fake()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods):
            root = Path(tmp)
            (root/'result').mkdir()
            with self.assertRaises(y.StudyError) as cm:
                y.extract(self.args(root))
            self.assertEqual(cm.exception.code, 'output_exists')
            self.assertEqual(state['requests'], [])

    def test_context_failure_no_traceback(self):
        mods, _ = self.fake(exit_failure=True)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, mods), contextlib.redirect_stderr(io.StringIO()) as err:
            code = y.main(['extract', 'bGRhS_f6EdM', '--out', str(Path(tmp)/'result')])
            self.assertEqual(code, 2)
            self.assertNotIn('Traceback', err.getvalue())
            self.assertEqual(json.loads(err.getvalue())['code'], 'extraction_error')

    def test_missing_dependency(self):
        with patch.dict(sys.modules, {'yt_dlp': None}), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(y.main(['extract', 'bGRhS_f6EdM']), 2)
            self.assertEqual(json.loads(err.getvalue())['code'], 'dependency_missing')


if __name__ == '__main__':
    unittest.main()
