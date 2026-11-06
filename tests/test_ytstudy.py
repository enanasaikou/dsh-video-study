import contextlib
import io
import json
import socket
import ssl
import sys
import types
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import ytstudy as y


class SubtitleTests(unittest.TestCase):
    def test_urls(self):
        vid = 'bGRhS_f6EdM'
        for target in (vid, f'https://www.youtube.com/watch?v={vid}&t=3',
                       f'https://youtu.be/{vid}?si=abc', f'https://youtube.com/shorts/{vid}',
                       f'https://m.youtube.com/watch?v={vid}'):
            self.assertEqual(y.normalize_target(target)[1], vid)
        for target in ('https://evil.test/watch?v=' + vid, 'nope', 'https://youtube.com.evil.test/' + vid):
            with self.assertRaises(y.StudyError):
                y.normalize_target(target)

    def test_numeric_body(self):
        cues = y.parse_subtitles('1\n00:00:01,000 --> 00:00:02,000\n2026\n123\n\n2\n00:00:03,000 --> 00:00:04,000\n42\n')
        self.assertEqual([c.text for c in cues], ['2026 123', '42'])

    def test_vtt_tags_entities_unicode(self):
        raw = '\ufeffWEBVTT\nKind: captions\nLanguage: zh\n\nNOTE ignored\nabc\n\nSTYLE\n::cue {}\n\nid\n00:01.000 --> 00:03.500 align:start\n<v Speaker><c.green>中文 &amp; &lt;3</c></v>\n<b>你好</b><00:02.000> &quot;测试&quot;\n'
        cue = y.parse_subtitles(raw)[0]
        self.assertEqual(cue.text, '中文 & <3 你好 "测试"')
        self.assertTrue(cue.rolling)
        self.assertEqual(cue.end, 3.5)

    def test_bad_caption_not_no_captions(self):
        for raw in ('garbage', 'WEBVTT\n\n', '1\n00:03.000 --> 00:01.000\nx'):
            with self.assertRaises(y.StudyError) as e:
                y.parse_subtitles(raw)
            self.assertEqual(e.exception.code, 'parse_error')

    def test_rolling_partial_english(self):
        cues = [y.Cue(0, 3, 'Hello world today'), y.Cue(2, 5, 'world today is good')]
        self.assertEqual(y.dedupe_rolling(cues), cues)  # ambiguous text-only overlap retained

    def test_rolling_chinese(self):
        cues = [y.Cue(0, 3, '开始学习中文字幕'), y.Cue(2, 5, '中文字幕很好')]
        self.assertEqual(y.dedupe_rolling(cues), cues)

    def test_normal_repeat_preserved(self):
        for cues in ([y.Cue(0, 1, 'yes yes'), y.Cue(1, 2, 'yes yes')],
                     [y.Cue(0, 2, 'yes yes'), y.Cue(1, 3, 'yes yes')],
                     [y.Cue(0, 1, '你好'), y.Cue(10, 12, '你好')]):
            self.assertEqual(y.dedupe_rolling(cues), cues)
        cues = [y.Cue(0, 3, 'I say yes'), y.Cue(2, 4, 'yes yes indeed')]
        self.assertEqual(y.dedupe_rolling(cues), cues)

    def test_proven_rolling_duplicate(self):
        cues = [y.Cue(0, 3, 'Hello', True, ((0, 'Hello'),)), y.Cue(2, 4, 'Hello', True, ((0, 'Hello'),))]
        self.assertEqual(len(y.dedupe_rolling(cues)), 1)
        self.assertEqual(y.dedupe_rolling(cues, False), cues)

    def test_youtube_refresh_pattern(self):
        raw = ('WEBVTT\n\n00:00.000 --> 00:01.000\n \n[Music]\n\n'
               '00:01.000 --> 00:03.000\nhello world\n\n'
               '00:03.000 --> 00:03.010\nhello world\n \n\n'
               '00:03.010 --> 00:05.000\nhello world\nnew<00:04.000><c> words</c>\n')
        cues = y.parse_subtitles(raw)
        self.assertEqual(cues[0].text, '[Music]')
        self.assertEqual([c.text for c in y.dedupe_rolling(cues)], ['[Music]', 'hello world', 'new words'])

    def test_space_only_separator(self):
        raw = '1\n00:00:01,000 --> 00:00:02,000\n123\n \n2\n00:00:03,000 --> 00:00:04,000\n456\n'
        self.assertEqual([c.text for c in y.parse_subtitles(raw)], ['123', '456'])

    def test_font_and_literal_tag(self):
        self.assertEqual(y.clean_text('<font color="red">123</font> &lt;b&gt; &lt;3'), '123 <b> <3')

    def test_long_repeated_speech_not_deleted(self):
        cues = [y.Cue(0, 3, 'we will go back home'), y.Cue(2, 5, 'go back home again')]
        self.assertEqual(y.dedupe_rolling(cues), cues)

    def test_word_boundary(self):
        cues = [y.Cue(0, 3, 'something testing word'), y.Cue(2, 4, 'testing words differ')]
        self.assertEqual(y.dedupe_rolling(cues), cues)


class SelectionTests(unittest.TestCase):
    def tracks(self, *pairs):
        return [{'language': lang, 'kind': kind} for lang, kind in pairs]

    def test_language_before_kind(self):
        ts = self.tracks(('zh', 'manual'), ('en', 'auto'))
        self.assertEqual(y.choose_track(ts, ['en', 'zh'])[0]['language'], 'en')
        ts.append({'language': 'en-US', 'kind': 'manual'})
        self.assertEqual(y.choose_track(ts, ['en', 'zh'])[0]['kind'], 'manual')

    def test_fallback_explicit(self):
        ts = self.tracks(('zh-Hans', 'auto'))
        self.assertTrue(y.choose_track(ts, ['en', 'zh'])[1])
        with self.assertRaises(y.StudyError) as e:
            y.choose_track(ts, ['en'])
        self.assertEqual(e.exception.code, 'language_unavailable')
        self.assertTrue(y.choose_track(ts, ['en'], True)[1])

    def test_no_captions(self):
        with self.assertRaises(y.StudyError) as e:
            y.choose_track([], ['en'])
        self.assertEqual(e.exception.code, 'no_captions')

    def test_supported_formats(self):
        meta = {'subtitles': {'live_chat': [{'ext': 'vtt', 'url': 'x'}], 'en': [{'ext': 'json3', 'url': 'x'}]},
                'automatic_captions': {'zh': [{'ext': 'vtt', 'url': 'x'}]}}
        self.assertEqual(len(y.available_tracks(meta)), 1)


class SafetyTests(unittest.TestCase):
    def test_error_classification(self):
        for msg, code in [('HTTP 429', 'rate_limited'), ('Sign in to confirm', 'login_required'),
                          ('HTTP Error 403', 'platform_restricted'), ('Proxy connection timed out', 'network_error'),
                          ('Unable to extract', 'extraction_error')]:
            self.assertEqual(y.classify_error(msg)[0], code)

    def test_localized_windows_network_message_has_safe_next_step(self):
        code, message = y.classify_error('[WinError 10054] 远程主机强迫关闭了一个现有的连接。 FAKE_SECRET')
        self.assertEqual(code, 'network_error')
        self.assertIn('代理', message)
        self.assertIn('不是没有字幕', message)
        self.assertNotIn('FAKE_SECRET', message)

    def test_native_network_types_errno_and_winerror(self):
        winerror = OSError('完全本地化 FAKE_SECRET')
        winerror.winerror = 10054
        for error in (ConnectionResetError('远程关闭'), TimeoutError('超时'),
                      OSError(104, '远程关闭'), OSError(10060, '请求超时'), winerror,
                      socket.gaierror(-2, '主机名称解析失败'), ssl.SSLError('证书请求失败')):
            with self.subTest(kind=type(error).__name__):
                code, message = y.classify_error('无法获取字幕', error)
                self.assertEqual(code, 'network_error')
                self.assertIn('代理', message)
                self.assertNotIn('FAKE_SECRET', message)

    def test_wrapped_network_errors_and_cycles(self):
        native = ConnectionResetError('中文系统错误 FAKE_SECRET')
        caused = RuntimeError('无法获取')
        caused.__cause__ = native
        contextual = RuntimeError('无法获取')
        contextual.__context__ = native
        reason = RuntimeError('无法获取')
        reason.reason = native
        ydl_error = RuntimeError('无法获取')
        ydl_error.exc_info = (type(native), native, None)
        transport = type('TransportError', (Exception,), {})('本地化消息')
        for error in (caused, contextual, reason, ydl_error, transport):
            self.assertEqual(y.classify_error(str(error), error)[0], 'network_error')
        cycle_a, cycle_b = RuntimeError('a'), RuntimeError('b')
        cycle_a.__cause__, cycle_b.__cause__ = cycle_b, cycle_a
        self.assertEqual(y.classify_error('无法确认', cycle_a)[0], 'extraction_error')
        self.assertEqual(y.classify_error('FAKE_SECRET', FileNotFoundError(2, '不存在'))[0], 'extraction_error')
        self.assertEqual(y.classify_error('FAKE_SECRET', PermissionError(13, '无权限'))[0], 'extraction_error')

    def test_network_errors_at_both_extract_stages_are_not_caption_absence(self):
        target = 'bGRhS_f6EdM'
        modules = {name: types.ModuleType(name) for name in ('yt_dlp', 'yt_dlp.version', 'yt_dlp.networking')}
        modules['yt_dlp.version'].__version__ = 'fake-offline'
        modules['yt_dlp.networking'].Request = Mock()
        args = types.SimpleNamespace(target=target, proxy=None, cookies=None, out=str(Path.cwd() / 'never-created'),
                                     list_languages=False, lang='en', allow_other=False, no_dedupe=False)
        meta = {'id': target, 'subtitles': {'en': [{'ext': 'vtt', 'url': 'https://invalid.test/FAKE_SECRET'}]}}
        for stage in ('metadata', 'subtitle'):
            native = OSError(104, '中文系统消息 FAKE_SECRET')
            wrapped = RuntimeError('本地化失败')
            wrapped.__cause__ = native
            ydl = Mock()
            ydl.extract_info.return_value = meta
            if stage == 'metadata':
                ydl.extract_info.side_effect = wrapped
            else:
                ydl.urlopen.side_effect = wrapped
            with self.subTest(stage=stage), patch.dict(sys.modules, modules), \
                 patch.object(y, 'youtube_session', return_value=contextlib.nullcontext(ydl)), \
                 patch.object(Path, 'exists', return_value=False), patch.object(Path, 'mkdir'), \
                 patch.object(Path, 'write_bytes', side_effect=AssertionError('no download')), \
                 patch.object(y, 'write_bundle', side_effect=AssertionError('no bundle')), \
                 self.assertRaises(y.StudyError) as caught:
                y.extract(args)
            self.assertEqual(caught.exception.code, 'network_error')
            self.assertNotIn(caught.exception.code, ('no_captions', 'language_unavailable'))
            self.assertNotIn('FAKE_SECRET', caught.exception.message)

    def test_main_network_errors_have_static_json_and_local_errors_stay_local(self):
        wrapped = RuntimeError('FAKE_SECRET')
        wrapped.__cause__ = ConnectionResetError('中文系统消息')
        for error, expected in ((OSError(10054, '中文 FAKE_SECRET'), 'network_error'),
                                (wrapped, 'network_error'), (FileNotFoundError('FAKE_SECRET'), 'local_error')):
            stderr = io.StringIO()
            with patch.object(y, 'extract', side_effect=error), contextlib.redirect_stderr(stderr):
                self.assertEqual(y.main(['extract', 'bGRhS_f6EdM']), 2)
            result = json.loads(stderr.getvalue())
            self.assertEqual(result['code'], expected)
            self.assertNotIn('FAKE_SECRET', stderr.getvalue())
            if expected == 'network_error':
                self.assertIn('代理', result['message'])

    def test_default_transport(self):
        opts = y.ydl_options()
        self.assertEqual(opts['proxy'], '')
        self.assertIsNone(opts['cookiefile'])
        self.assertTrue(opts['skip_download'])
        self.assertTrue(opts['noplaylist'])
        self.assertFalse(opts['cachedir'])
        self.assertNotIn('cookiesfrombrowser', opts)

    def test_bundle_and_ai_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            raw = folder / 'original.vtt'
            raw.write_text('WEBVTT\n\n00:00.000 --> 00:01.000\n你好 123\n', encoding='utf-8')
            cues = y.parse_subtitles(raw.read_text(encoding='utf-8'))
            track = {'language': 'zh', 'kind': 'manual', 'name': '中文'}
            y.write_bundle(folder, {'id': 'bGRhS_f6EdM', 'title': '测试'}, 'https://www.youtube.com/watch?v=bGRhS_f6EdM', track, cues, cues, raw, ['en', 'zh'], True, 'test')
            meta = json.loads((folder / 'metadata.json').read_text(encoding='utf-8'))
            self.assertFalse(meta['ai_generated'])
            self.assertEqual(meta['original_segments'][0]['text'], '你好 123')
            self.assertIn('00:00:00.000', (folder / 'transcript.txt').read_text(encoding='utf-8'))
            self.assertTrue(raw.exists())
            self.assertEqual(y.main(['ai-request', str(folder), '--task', 'notes']), 0)
            self.assertIn('AI 生成', (folder / 'ai-request.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
