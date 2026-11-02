import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
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
