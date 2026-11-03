"""Offline coverage for cloud-only shared validation; no engines or model access."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import cloud_output as output


class CloudOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cloud-output-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = self.root / 'audio.m4a'
        self.audio.write_bytes(b'FAKE AUDIO FOR HASH VALIDATION ONLY')
        self.source = {'platform': 'youtube', 'id': 'abcdefghijk', 'duration_seconds': 10,
                       'audio_bytes': self.audio.stat().st_size,
                       'audio_sha256': hashlib.sha256(self.audio.read_bytes()).hexdigest()}
        self.args = SimpleNamespace(max_audio_mib=1, max_duration=60)

    def check_error(self, code, function, *args):
        with self.assertRaises(output.CloudOutputError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), caught.exception.message)

    def validate(self, segments, duration=10):
        return output.validate_segments(segments, {'duration': duration}, self.source, 60)

    def test_valid_segments_preserve_text_and_repetition(self):
        raw = [{'start': 0, 'end': 4, 'text': ' *保留* \n', 'avg_logprob': -2},
               {'start': 5, 'end': 10, 'text': ' *保留* \n'}]
        segments, duration, warnings = self.validate(raw)
        self.assertEqual(duration, 10)
        self.assertEqual([item['text'] for item in segments], [item['text'] for item in raw])
        self.assertIn('segment_0:low_confidence_or_repetition_risk_preserved', warnings)
        self.assertIn('segment_1:repeated_text_preserved', warnings)
        self.assertIn('coverage_and_content_not_verified_no_visual_or_speaker_verification', warnings)

    def test_empty_text_is_not_success(self):
        for segments in ([], [{'start': 0, 'end': 10, 'text': ' \n\t'}]):
            with self.subTest(segments=segments):
                self.check_error('empty_output', self.validate, segments)

    def test_nonfinite_boolean_or_negative_timestamps_rejected(self):
        for value in (True, False, float('nan'), float('inf'), -0.1, '0', None):
            with self.subTest(value=value):
                self.check_error('invalid_timestamp', self.validate, [{'start': value, 'end': 1, 'text': 'x'}])

    def test_malformed_order_and_submillisecond_segments_rejected(self):
        for segments in ([{'start': 1, 'end': 1, 'text': 'x'}],
                         [{'start': 0, 'end': 0.0001, 'text': 'x'}],
                         [{'start': 0, 'end': 11, 'text': 'x'}],
                         [{'start': 5, 'end': 6, 'text': 'x'}, {'start': 4, 'end': 7, 'text': 'y'}],
                         [{'start': 0, 'end': 1, 'text': None}], [None]):
            with self.subTest(segments=segments):
                self.check_error('invalid_timestamp', self.validate, segments)

    def test_source_and_provider_duration_must_match(self):
        self.check_error('duration_mismatch', self.validate, [{'start': 0, 'end': 1, 'text': 'x'}], 13)
        self.check_error('duration_mismatch', self.validate, [{'start': 0, 'end': 1, 'duration': 3, 'text': 'x'}])
        self.check_error('duration_mismatch', output.validate_segments,
                         [{'start': 0, 'end': 1, 'text': 'x'}], {'duration': 10}, self.source, 9)

    def test_coverage_gaps_and_bad_confidence_are_warnings(self):
        source = {**self.source, 'duration_seconds': 120}
        _, _, warnings = output.validate_segments([
            {'start': 20, 'end': 21, 'text': 'a', 'avg_logprob': float('nan')},
            {'start': 60, 'end': 61, 'text': 'b'}], {'duration': 120}, source, 180)
        for warning in ('segment_0:invalid_avg_logprob', 'leading_audio_without_transcribed_text',
                        'trailing_audio_without_transcribed_text_possible_early_stop',
                        'long_gap_without_transcribed_text'):
            self.assertIn(warning, warnings)

    def test_source_whitelist_rebuilds_unsigned_public_url(self):
        source = output.safe_source({**self.source, 'source_url': 'https://bad/?secret=FAKE',
                                     'cookies': 'FAKE', 'headers': {'Authorization': 'FAKE'}})
        self.assertEqual(source['source_url'], 'https://www.youtube.com/watch?v=abcdefghijk')
        self.assertNotIn('cookies', source)
        self.assertNotIn('headers', source)
        bili = output.safe_source({**self.source, 'platform': 'bilibili', 'bvid': 'BV17K411P7hC', 'page': 27})
        self.assertEqual(bili['source_url'], 'https://www.bilibili.com/video/BV17K411P7hC?p=27')

    def test_invalid_source_identity_hash_or_page_rejected(self):
        for source in (None, {**self.source, 'platform': 'unknown'}, {**self.source, 'audio_sha256': 'bad'},
                       {**self.source, 'platform': 'bilibili', 'bvid': 'BV17K411P7hC', 'page': True},
                       {**self.source, 'platform': 'bilibili', 'bvid': 'BV17K411P7hC', 'page': 0}):
            with self.subTest(source=source):
                self.check_error('audio_invalid', output.safe_source, source)

    def test_audio_must_match_root_size_hash_and_duration(self):
        self.assertEqual(output.verify_audio(self.audio, self.root, self.source, self.args), self.audio)
        for source in ({**self.source, 'audio_bytes': 0}, {**self.source, 'audio_sha256': '0' * 64}):
            with self.subTest(source=source):
                self.check_error('audio_invalid', output.verify_audio, self.audio, self.root, source, self.args)
        self.check_error('audio_invalid', output.verify_audio, self.audio, self.root / 'other', self.source, self.args)
        self.check_error('audio_invalid', output.verify_audio, self.audio, self.root, self.source,
                         SimpleNamespace(max_audio_mib=0, max_duration=60))
        self.check_error('duration_mismatch', output.verify_audio, self.audio, self.root,
                         {**self.source, 'duration_seconds': 61}, self.args)

    def test_json_serialization_never_uses_unknown_repr_or_nonstandard_nan(self):
        @dataclass
        class Record:
            text: str
        class Private:
            __slots__ = ()
            def __repr__(self):
                raise AssertionError('must never stringify arbitrary object')
        value = {'record': Record('中文'), 'nan': float('nan'), 'tuple': (1, 2), 'private': Private()}
        path = self.root / 'raw.json'
        output.write_json(path, value)
        saved = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual(saved, {'record': {'text': '中文'}, 'nan': 'nan', 'tuple': [1, 2],
                                 'private': {'unsupported_type': 'Private'}})
        with self.assertRaises(FileExistsError):
            output.write_json(path, {})

    def test_timestamp_rounding_and_literal_markdown(self):
        self.assertEqual(output.stamp(3599.9996), '01:00:00.000')
        self.assertEqual(output.stamp(1.2, True), '00:00:01,200')
        self.assertEqual(output.markdown_literal('<script>*x*\n[link](target)'),
                         '&lt;script&gt;\\*x\\*  \n\\[link\\]\\(target\\)')


if __name__ == '__main__':
    unittest.main()
