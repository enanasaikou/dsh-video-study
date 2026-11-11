"""Offline-only audio-source regression tests; all network/extractor calls mocked."""
import contextlib
import copy
import hashlib
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse

import audio_sources as m

VIDEO = 'abcdefghijk'
BVID = 'BV17K411P7hC'
CID = 254923561
SIGNED = 'FAKE_SIGNED_SECRET'
COOKIE = 'FAKE_SESSION_SECRET'
YT_AUDIO = 'https://rr1---sn-example.googlevideo.com/videoplayback?sig=' + SIGNED
BILI_AUDIO = f'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/61/35/{CID}/{CID}-1-30280.m4s?sig={SIGNED}'
PAYLOAD = b'FAKE_AUDIO_BYTES_NOT_REAL_MEDIA'


def audio(language='en-US', format_id='140', **updates):
    obj = dict(vcodec='none', acodec='mp4a.40.2', ext='m4a', format_id=format_id,
               url=YT_AUDIO, protocol='https', language=language, abr=128)
    obj.update(updates)
    return obj


def youtube(formats=None, **updates):
    obj = dict(id=VIDEO, title='untrusted title', duration=1422,
               formats=[audio()] if formats is None else formats)
    obj.update(updates)
    return obj


def view():
    return dict(code=0, data=dict(aid=500152961, bvid=BVID, title='不可信课程标题', pages=[
        dict(page=1, cid=123, part='错误分集', duration=10),
        dict(page=27, cid=CID, part='基本概念', duration=1422)]))


def play(**updates):
    data = dict(cid=CID, timelength=1421620, dash=dict(audio=[dict(
        id=30280, baseUrl=BILI_AUDIO, mimeType='audio/mp4', codecs='mp4a.40.2', bandwidth=128000)],
        video=[dict(id=80, baseUrl='https://example.invalid/video.mp4')]))
    data.update(updates)
    return dict(code=0, data=data)


class Response:
    def __init__(self, body=PAYLOAD, headers=None, on_read=None):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.buffer = io.BytesIO(body)
        self.headers = headers or {}
        self.on_read = on_read
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size=-1):
        if self.on_read:
            self.on_read()
        return self.buffer.read(size)
    def read1(self, size=-1): return self.read(size)


class Opener:
    def __init__(self, bodies):
        self.bodies = list(bodies)
        self.requests, self.timeouts = [], []
    def open(self, req, timeout):
        self.requests.append(req)
        self.timeouts.append(timeout)
        item = self.bodies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item if isinstance(item, Response) else Response(item)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='audio-offline-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'download'
        self.directory.mkdir()
        self.seen_options, self.sessions = [], []
        self.metadata = youtube()
        self.extract_error = None
        outer = self
        class FakeYDL:
            def __init__(self, options):
                outer.seen_options.append(options)
                self.params = options
                outer.sessions.append(self)
            def __enter__(self): return self
            def __exit__(self, *args):
                if self.params.get('cookiefile'):
                    Path(self.params['cookiefile']).write_text('MODIFIED_TEMPORARY_JAR', encoding='utf-8')
            def urlopen(self, req):
                return Response(b'MOCK_METADATA')
            def extract_info(self, url, download):
                outer.assertEqual(url, f'https://www.youtube.com/watch?v={VIDEO}')
                outer.assertIs(download, False)
                if outer.extract_error:
                    raise outer.extract_error
                return copy.deepcopy(outer.metadata)
        self.fake_yt = types.SimpleNamespace(YoutubeDL=FakeYDL)
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {'yt_dlp': self.fake_yt}).start()
        self.opener = Opener([Response()])
        self.build = patch.object(m, 'build_opener', side_effect=lambda *args: self.opener).start()

    def run_yt(self, **kwargs):
        return m.download_audio(VIDEO, self.directory, **kwargs)

    def run_bili(self, response=None, target=None, **kwargs):
        self.opener = Opener([view(), response or play(), Response()])
        return m.download_audio(target or f'https://www.bilibili.com/video/{BVID}/?p=27', self.directory, **kwargs)

    def code(self, expected, func, *args, **kwargs):
        with self.assertRaises(m.AudioSourceError) as caught:
            func(*args, **kwargs)
        self.assertEqual(caught.exception.code, expected)
        return caught.exception

    def test_youtube_success_only_audio_and_safe_metadata(self):
        path, meta = self.run_yt()
        self.assertEqual(path.name, 'audio.m4a')
        self.assertEqual(path.read_bytes(), PAYLOAD)
        self.assertEqual(meta['audio_sha256'], hashlib.sha256(PAYLOAD).hexdigest())
        self.assertEqual(meta['audio_bytes'], len(PAYLOAD))
        self.assertEqual(meta['source_url'], f'https://www.youtube.com/watch?v={VIDEO}')
        self.assertEqual(meta['audio_language'], 'en-us')
        self.assertEqual(meta['audio_format_id'], '140')
        self.assertNotIn(SIGNED, json.dumps(meta))
        self.assertNotIn('Cookie', self.opener.requests[0].headers)

    def test_youtube_options_are_isolated(self):
        self.run_yt()
        opts = self.seen_options[0]
        for key in ('cachedir', 'usenetrc', 'enable_file_urls'):
            self.assertIs(opts[key], False)
        for key in ('retries', 'extractor_retries', 'fragment_retries', 'file_access_retries'):
            self.assertEqual(opts[key], 0)
        self.assertEqual(opts['proxy'], '')
        self.assertEqual(opts['js_runtimes'], {})
        self.assertEqual(opts['remote_components'], [])
        self.assertIsNone(opts['cookiesfrombrowser'])
        self.assertTrue(opts['skip_download'])
        self.assertEqual(self.build.call_args.args[0].proxies, {})
        self.assertIsInstance(self.build.call_args.args[1], m.NoRedirect)

    def test_task_scratch_stays_in_download_directory_without_system_temp(self):
        with patch.object(tempfile, 'gettempdir', side_effect=AssertionError('system temp forbidden')):
            self.run_yt()
        options = self.seen_options[0]
        scratch = Path(options['paths']['temp'])
        self.assertEqual(scratch.parent, self.directory)
        self.assertEqual(options['paths']['home'], str(scratch))
        self.assertEqual(Path(options['outtmpl']).parent, scratch)
        self.assertFalse(scratch.exists())
        self.assertEqual(list(self.directory.iterdir()), [self.directory / 'audio.m4a'])

    def test_temp_creation_denied_never_falls_back_or_calls_extractor(self):
        with patch.object(tempfile, 'gettempdir', side_effect=AssertionError('system temp forbidden')), \
             patch.object(tempfile, 'mkdtemp', side_effect=PermissionError('denied')) as create:
            self.code('local_error', self.run_yt)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(Path(create.call_args.args[2]), self.directory)
        self.assertFalse(self.seen_options)
        self.assertFalse(self.opener.requests)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_extractor_failure_and_cancellation_clean_task_scratch(self):
        for error in (RuntimeError('fixture failure'), KeyboardInterrupt()):
            self.extract_error = error
            with self.subTest(error=type(error).__name__), \
                 patch.object(tempfile, 'gettempdir', side_effect=AssertionError('system temp forbidden')):
                with self.assertRaises(KeyboardInterrupt if isinstance(error, KeyboardInterrupt) else m.AudioSourceError):
                    self.run_yt()
            scratch = Path(self.seen_options[-1]['paths']['temp'])
            self.assertFalse(scratch.exists())
            self.assertEqual(list(self.directory.iterdir()), [])

    def test_explicit_proxy_is_shared_not_environment(self):
        with patch.dict('os.environ', {'HTTPS_PROXY': 'http://evil.invalid:9999'}):
            self.run_yt(proxy='http://127.0.0.1:7897')
        self.assertEqual(self.seen_options[0]['proxy'], 'http://127.0.0.1:7897')
        self.assertEqual(self.build.call_args.args[0].proxies, {
            'http': 'http://127.0.0.1:7897', 'https': 'http://127.0.0.1:7897'})

    def test_socks_proxy_stops_without_network(self):
        self.code('unsupported_proxy', self.run_yt, proxy='socks5://127.0.0.1:7897')
        self.build.assert_not_called()

    def test_proxy_credentials_rejected(self):
        self.code('invalid_proxy', self.run_yt, proxy='http://user:secret@127.0.0.1:7897')
        self.build.assert_not_called()

    def test_cookie_temporary_copy_not_rewritten_or_forwarded(self):
        original = self.root / 'authorized.txt'
        content = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\t' + COOKIE + '\n'
        original.write_text(content, encoding='utf-8')
        _, meta = self.run_yt(cookies=original)
        self.assertEqual(original.read_text(encoding='utf-8'), content)
        temporary = Path(self.seen_options[0]['cookiefile'])
        self.assertNotEqual(temporary, original)
        self.assertFalse(temporary.exists())
        self.assertNotIn('Cookie', self.opener.requests[0].headers)
        self.assertNotIn(COOKIE, json.dumps(meta))

    def test_invalid_cookie_rejected_before_network(self):
        bad = self.root / 'bad.txt'
        bad.write_text('not a cookie file ' + COOKIE, encoding='utf-8')
        self.code('invalid_cookie_file', self.run_yt, cookies=bad)
        self.assertFalse(self.opener.requests)
        self.assertFalse(self.seen_options)

    def test_cookie_parser_warnings_do_not_leak_credentials(self):
        bad = self.root / 'bad-netscape.txt'
        bad.write_text('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\tBAD_EXPIRY\tSID\t' + COOKIE + '\n', encoding='utf-8')
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            err = self.code('invalid_cookie_file', self.run_yt, cookies=bad)
        self.assertNotIn(COOKIE, str(err) + stdout.getvalue() + stderr.getvalue())
        self.assertEqual(stderr.getvalue(), '')
        self.assertFalse(self.opener.requests)

    def test_extractor_headers_not_forwarded(self):
        self.metadata['http_headers'] = {'Cookie': COOKIE, 'Authorization': 'Bearer ' + COOKIE}
        self.metadata['formats'][0]['http_headers'] = {'Cookie': COOKIE, 'Proxy-Authorization': COOKIE}
        self.run_yt()
        text = repr(self.opener.requests[0].headers)
        self.assertNotIn(COOKIE, text)
        self.assertNotIn('Authorization', text)

    def test_video_and_m3u8_not_fallback(self):
        self.metadata['formats'] = [audio(vcodec='avc1'), audio(protocol='m3u8_native'),
                                    audio(acodec='none'), audio(url='https://rr.googlevideo.com/audio.m3u8')]
        self.code('audio_unavailable', self.run_yt)
        self.assertFalse(self.opener.requests)

    def test_manifest_fragments_drm_and_unknown_codec_rejected(self):
        self.metadata['formats'] = [audio(manifest_url='https://rr.googlevideo.com/a.mpd'),
                                    audio(fragments=[{'url': YT_AUDIO}]), audio(has_drm=True), audio(acodec='unknown')]
        self.code('audio_unavailable', self.run_yt)

    def test_malicious_media_host_port_credentials_scheme(self):
        for url in ('https://googlevideo.com.evil.invalid/audio', 'http://rr.googlevideo.com/audio',
                    'https://user:pass@rr.googlevideo.com/audio', 'https://rr.googlevideo.com:8443/audio',
                    'https://127.0.0.1/audio', 'file:///audio'):
            with self.subTest(url=url):
                self.metadata['formats'] = [audio(url=url)]
                self.code('audio_unavailable', self.run_yt)
        self.assertFalse(self.opener.requests)

    def test_explicit_format_not_url(self):
        self.code('invalid_input', self.run_yt, audio_format=YT_AUDIO)
        self.build.assert_not_called()

    def test_multilingual_without_choice_ambiguous(self):
        self.metadata['formats'] = [audio('en', '140-0'), audio('zh-CN', '140-1')]
        self.code('audio_track_ambiguous', self.run_yt)

    def test_explicit_language_matches_regional_language(self):
        self.metadata['formats'] = [audio('zh-CN', '140-0'), audio('en-US', '140-1')]
        _, meta = self.run_yt(audio_language='en')
        self.assertEqual(meta['audio_format_id'], '140-1')
        self.assertEqual(meta['audio_language'], 'en-us')

    def test_format_has_priority_over_language(self):
        self.metadata['formats'] = [audio('en', '140-0'), audio('zh', '140-1')]
        _, meta = self.run_yt(audio_format='140-1', audio_language='en')
        self.assertEqual(meta['audio_language'], 'zh')

    def test_missing_requested_language_stops(self):
        error = self.code('audio_language_unavailable', self.run_yt, audio_language='ja')
        self.assertIn('140/en-us', error.message)

    def test_candidate_ids_languages_are_safe_bounded_and_usable(self):
        self.metadata['formats'] = [audio('en', '140-0'), audio('zh-CN', '140-1'),
                                    audio(SIGNED, COOKIE), audio('en', '141', format_note=YT_AUDIO + COOKIE)]
        error = self.code('audio_track_ambiguous', self.run_yt)
        self.assertIn('140-0/en', error.message)
        self.assertIn('140-1/zh-cn', error.message)
        self.assertNotIn(SIGNED, error.message)
        self.assertNotIn(COOKIE, error.message)
        self.assertNotIn('https:', error.message)
        _, meta = self.run_yt(audio_format='140-1')
        self.assertEqual(meta['audio_language'], 'zh-cn')

    def test_candidate_limit_and_unavailable_format(self):
        self.metadata['formats'] = [audio('en', str(i)) for i in range(100, 150)]
        error = self.code('audio_format_unavailable', self.run_yt, audio_format='999')
        self.assertEqual(error.message.count('/en'), 20)
        self.assertIn('100/en', error.message)
        self.assertNotIn('120/en', error.message)

    def test_unknown_language_codes_remain_unknown(self):
        self.metadata['formats'] = [audio('und')]
        _, meta = self.run_yt()
        self.assertEqual(meta['audio_language'], 'unknown')
        self.assertTrue(meta['warnings'])

    def test_unknown_language_unique_keeps_unknown_and_warning(self):
        self.metadata['formats'] = [audio(None)]
        _, meta = self.run_yt(audio_language='en')
        self.assertEqual(meta['audio_language'], 'unknown')
        self.assertGreaterEqual(len(meta['warnings']), 2)
        self.assertNotEqual(meta['audio_track_note'], 'original')

    def test_unknown_multiple_formats_with_explicit_language_requires_format(self):
        self.metadata['formats'] = [audio(None, '140'), audio(None, '251', ext='webm', acodec='opus')]
        self.code('audio_language_unavailable', self.run_yt, audio_language='en')

    def test_same_language_different_track_identity_ambiguous(self):
        self.metadata['formats'] = [audio('en', '140-0', audio_track_id='main'),
                                    audio('en', '140-1', audio_track_id='description')]
        self.code('audio_track_ambiguous', self.run_yt, audio_language='en')

    def test_duration_and_video_identity_verified_before_download(self):
        for changes, expected in (({'duration': 99999}, 'duration_limit'), ({'duration': float('nan')}, 'duration_limit'),
                                  ({'id': 'wrong'}, 'metadata_invalid'), ({'is_live': True}, 'audio_unavailable')):
            with self.subTest(changes=changes):
                self.metadata = youtube(**changes)
                self.code(expected, self.run_yt)
        self.assertFalse(self.opener.requests)

    def test_unsupported_target_rejected_before_network(self):
        for raw in ('https://evil.invalid/watch?v=' + VIDEO, 'https://user:secret@youtube.com/watch?v=' + VIDEO,
                    'https://www.youtube.com/playlist?list=abc', 'bad-id'):
            with self.subTest(raw=raw):
                self.code('invalid_target', m.download_audio, raw, self.directory)
        self.build.assert_not_called()

    def test_bilibili_p27_identity_cookie_scope_and_safe_metadata(self):
        cookie = self.root / 'bili.json'
        cookie.write_text(json.dumps({'SESSDATA': COOKIE}), encoding='utf-8')
        path, meta = self.run_bili(bili_cookie_file=cookie)
        self.assertEqual((meta['page'], meta['cid'], meta['bvid']), (27, CID, BVID))
        self.assertEqual(meta['part'], '基本概念')
        self.assertEqual(meta['identity_verification'], 'api_cid')
        self.assertEqual(meta['source_url'], f'https://www.bilibili.com/video/{BVID}/?p=27')
        api = self.opener.requests[:2]
        for request in api:
            self.assertEqual(urlparse(request.full_url).hostname, 'api.bilibili.com')
            self.assertEqual(request.get_header('Cookie'), 'SESSDATA=' + COOKIE)
        self.assertEqual(urlparse(api[1].full_url).path, '/x/player/playurl')
        params = parse_qs(urlparse(api[1].full_url).query)
        self.assertEqual(params['cid'], [str(CID)])
        self.assertEqual(params['avid'], ['500152961'])
        self.assertNotIn('Cookie', self.opener.requests[2].headers)
        self.assertNotIn(COOKIE, json.dumps(meta))
        self.assertNotIn(SIGNED, json.dumps(meta))
        self.assertEqual(path.name, 'audio.m4a')

    def test_private_session_fixed_api_only_no_temp_secret_files(self):
        with patch.object(m.tempfile, 'TemporaryDirectory', side_effect=AssertionError('no cookie copy')), \
             patch('bilibili_subtitles.session_value', side_effect=AssertionError('no file reads')):
            path, metadata = self.run_bili(bili_sessdata=COOKIE)
        self.assertEqual(path.read_bytes(), PAYLOAD)
        self.assertEqual([p.name for p in self.directory.iterdir()], ['audio.m4a'])
        self.assertEqual(len(self.opener.requests), 3)
        for request in self.opener.requests[:2]:
            self.assertEqual(urlparse(request.full_url).hostname, 'api.bilibili.com')
            self.assertEqual(request.get_header('Cookie'), 'SESSDATA=' + COOKIE)
        self.assertNotIn('Cookie', self.opener.requests[2].headers)
        self.assertNotIn(COOKIE, json.dumps(metadata))

    def test_private_session_file_conflict_before_read_or_network(self):
        with patch('bilibili_subtitles.session_value', side_effect=AssertionError('no reads')):
            error = self.code('invalid_input', self.run_bili,
                              bili_sessdata=COOKIE, bili_cookie_file='not-read.json')
        self.assertNotIn(COOKIE, str(error))
        self.build.assert_not_called()
        self.assertFalse(self.opener.requests)

    def test_youtube_rejects_private_bilibili_value_even_empty_or_invalid(self):
        for value in (COOKIE, '', {}, False):
            with self.subTest(value_type=type(value).__name__):
                self.code('invalid_input', self.run_yt, bili_sessdata=value)
        self.build.assert_not_called()
        self.assertFalse(self.seen_options)

    def test_private_session_invalid_rejected_without_echo_network_or_files(self):
        for value in ('', 'FAKE_SECRET;extra', ' FAKE_SECRET', 'FAKE_SECRET\n', 42):
            with self.subTest(value_type=type(value).__name__):
                error = self.code('invalid_input', self.run_bili, bili_sessdata=value)
                self.assertNotIn('FAKE_SECRET', str(error))
        self.build.assert_not_called()
        self.assertFalse(list(self.directory.iterdir()))

    def test_private_session_api_error_never_echoes_secret(self):
        self.opener = Opener([URLError('server error ' + COOKIE)])
        error = self.code('network_error', m.download_audio, BVID, self.directory, bili_sessdata=COOKIE)
        self.assertNotIn(COOKIE, str(error))
        self.assertEqual(len(self.opener.requests), 1)
        self.assertFalse(list(self.directory.iterdir()))

    def test_private_session_reflected_metadata_redacted_only_exact_value(self):
        response = view()
        response['data']['title'] = '普通课程 ' + COOKIE
        self.opener = Opener([response, play(), Response()])
        _, metadata = m.download_audio(BVID, self.directory, page=27, bili_sessdata=COOKIE)
        self.assertEqual(metadata['title'], '普通课程 [redacted]')
        self.assertEqual(metadata['part'], '基本概念')

    def test_bilibili_no_cid_verified_by_exact_path_and_duration(self):
        response = play()
        del response['data']['cid']
        _, meta = self.run_bili(response)
        self.assertEqual(meta['identity_verification'], 'audio_url_path_and_duration')

    def test_bilibili_no_cid_query_or_substring_does_not_prove_identity(self):
        for url in (f'https://upos.bilivideo.com/audio.m4s?cid={CID}',
                    f'https://upos.bilivideo.com/{CID}4/{CID}4-1-30280.m4s'):
            with self.subTest(url=url):
                response = play()
                del response['data']['cid']
                response['data']['dash']['audio'][0]['baseUrl'] = url
                self.code('identity_unverified', self.run_bili, response)
                self.assertEqual(len(self.opener.requests), 2)

    def test_bilibili_path_traversal_or_escaped_path_does_not_prove_identity(self):
        for path in (f'/{CID}/../999/999-1-30280.m4s', f'/{CID}/%2e%2e/999-1-30280.m4s'):
            with self.subTest(path=path):
                response = play()
                del response['data']['cid']
                response['data']['dash']['audio'][0]['baseUrl'] = 'https://upos.bilivideo.com' + path
                self.code('identity_unverified', self.run_bili, response)
                self.assertEqual(len(self.opener.requests), 2)

    def test_bilibili_mismatched_echo_or_duration_stops(self):
        for changes in ({'cid': CID + 1}, {'cid': None}, {'timelength': 10000}):
            with self.subTest(changes=changes):
                self.code('video_identity_mismatch', self.run_bili, play(**changes))
                self.assertEqual(len(self.opener.requests), 2)

    def test_bilibili_rejects_durl_video_fallback(self):
        self.code('audio_unavailable', self.run_bili, play(dash=None, durl=[dict(url=BILI_AUDIO)]))
        self.assertEqual(len(self.opener.requests), 2)

    def test_bilibili_audio_must_have_real_codec_and_audio_mime(self):
        response = play()
        response['data']['dash']['audio'][0]['mimeType'] = 'video/mp4'
        self.code('audio_unavailable', self.run_bili, response)
        response['data']['dash']['audio'][0]['mimeType'] = 'audio/mp4'
        response['data']['dash']['audio'][0]['codecs'] = 'avc1.64002A'
        self.code('audio_unavailable', self.run_bili, response)

    def test_bilibili_page_conflict_and_illegal_p_before_network(self):
        self.code('page_conflict', self.run_bili, page=1)
        self.assertFalse(self.opener.requests)
        self.build.assert_not_called()
        for query in ('p=27&p=28', 'p=abc', 'p=', 'p=0', 'p=-1'):
            with self.subTest(query=query):
                self.code('invalid_target', m.download_audio, f'https://www.bilibili.com/video/{BVID}/?{query}', self.directory)
        self.build.assert_not_called()

    def test_bilibili_bare_bv_explicit_page(self):
        _, meta = self.run_bili(target=BVID, page=27)
        self.assertEqual(meta['page'], 27)

    def test_bilibili_default_page_one(self):
        response = play(cid=123, timelength=10000)
        _, meta = self.run_bili(response, target=BVID)
        self.assertEqual(meta['page'], 1)
        self.assertEqual(meta['cid'], 123)

    def test_cross_platform_cookie_flags_rejected_before_network(self):
        self.code('invalid_input', self.run_yt, bili_cookie_file='anything.json')
        self.code('invalid_input', self.run_bili, cookies='anything.txt')
        self.build.assert_not_called()

    def test_bilibili_login_risk_failure_no_retries_or_raw_message(self):
        for code, expected in ((-101, 'login_required'), (-412, 'rate_limited'), (-403, 'platform_restricted')):
            with self.subTest(code=code):
                self.opener = Opener([dict(code=code, message=COOKIE + SIGNED)])
                error = self.code(expected, m.download_audio, BVID, self.directory)
                self.assertNotIn(COOKIE, str(error))
                self.assertEqual(len(self.opener.requests), 1)

    def test_size_content_length_early_rejection_cleans_own_file(self):
        self.opener = Opener([Response(headers={'Content-Length': '9999999'})])
        self.code('size_limit', self.run_yt, max_bytes=10)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_stream_hard_byte_limit_cleans_own_file(self):
        self.code('size_limit', self.run_yt, max_bytes=8)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_stream_content_length_mismatch_or_wrong_type(self):
        for headers in ({'Content-Length': '999'}, {'Content-Type': 'text/html'}, {'Content-Encoding': 'gzip'}):
            with self.subTest(headers=headers):
                self.opener = Opener([Response(headers=headers)])
                self.code('invalid_response', self.run_yt)
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_partial_media_response_rejected(self):
        response = Response(headers={'Content-Range': 'bytes 0-9/100'})
        self.opener = Opener([response])
        self.code('invalid_response', self.run_yt)
        self.assertFalse(list(self.directory.iterdir()))
        response = Response()
        response.status = 206
        self.opener = Opener([response])
        self.code('invalid_response', self.run_yt)
        self.assertFalse(list(self.directory.iterdir()))

    def test_youtube_media_request_asks_for_the_whole_file_by_range(self):
        self.run_yt()
        request = self.opener.requests[0]
        self.assertEqual(request.get_header('Range'), 'bytes=0-')
        self.assertEqual(request.get_header('Accept-encoding'), 'identity')

    def test_bilibili_media_request_keeps_the_plain_get(self):
        self.run_bili()
        self.assertIsNone(self.opener.requests[-1].get_header('Range'))

    def test_whole_file_range_response_is_accepted(self):
        headers = {'Content-Range': f'bytes 0-{len(PAYLOAD) - 1}/{len(PAYLOAD)}',
                   'Content-Length': str(len(PAYLOAD))}
        response = Response(headers=headers)
        response.status = 206
        self.opener = Opener([response])
        path, meta = self.run_yt()
        self.assertEqual(path.read_bytes(), PAYLOAD)
        self.assertEqual(meta['audio_bytes'], len(PAYLOAD))

    def test_partial_or_inconsistent_range_response_rejected(self):
        for headers in ({'Content-Range': f'bytes 1-{len(PAYLOAD) - 1}/{len(PAYLOAD)}'},
                        {'Content-Range': 'bytes 0-9/100'},
                        {'Content-Range': f'bytes 0-{len(PAYLOAD) - 1}/{len(PAYLOAD)}',
                         'Content-Length': '1'},
                        {'Content-Range': 'items 0-9/10'}):
            with self.subTest(headers=headers):
                response = Response(headers=headers)
                response.status = 206
                self.opener = Opener([response])
                self.code('invalid_response', self.run_yt)
                self.assertFalse(list(self.directory.iterdir()))

    def test_empty_audio_rejected(self):
        self.opener = Opener([Response(b'')])
        self.code('invalid_response', self.run_yt)
        self.assertFalse(list(self.directory.iterdir()))

    def test_cumulative_timeout_metadata_and_stream_share_budget(self):
        clock = [0]
        self.opener = Opener([Response(on_read=lambda: clock.__setitem__(0, clock[0] + 4))])
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]):
            self.code('timeout', self.run_yt, timeout=6)
        self.assertFalse(list(self.directory.iterdir()))
        self.assertLessEqual(self.opener.timeouts[0], 6)

    def test_timeout_after_final_stream_read_still_removes_owned_file(self):
        # Explicitly force the final public check after a successful read.
        original_read = m._read_stream
        def read_then_expire(response, budget, maximum, sink=None):
            result = original_read(response, budget, maximum, sink)
            budget.end = -1
            return result
        with patch.object(m, '_read_stream', side_effect=read_then_expire):
            self.code('timeout', self.run_yt)
        self.assertFalse(list(self.directory.iterdir()))

    def test_extractor_timeout_or_failures_never_leak_raw_exception(self):
        for text, expected in (('403 ' + YT_AUDIO + COOKIE, 'platform_restricted'),
                               ('sign in ' + COOKIE, 'login_required'), ('429 ' + COOKIE, 'rate_limited'),
                               ('boom ' + YT_AUDIO + COOKIE, 'extraction_error')):
            with self.subTest(text=text):
                self.extract_error = RuntimeError(text)
                err = self.code(expected, self.run_yt)
                self.assertNotIn(SIGNED, str(err))
                self.assertNotIn(COOKIE, str(err))
                self.assertIsNone(err.__cause__)
                self.assertTrue(err.__suppress_context__)
        self.assertFalse(self.opener.requests)

    def test_network_failure_never_leaks(self):
        self.opener = Opener([URLError(YT_AUDIO + COOKIE)])
        err = self.code('network_error', self.run_yt)
        self.assertNotIn(SIGNED, str(err))
        self.assertFalse(list(self.directory.iterdir()))

    def test_redirect_rejected_with_safe_error(self):
        self.code('redirect_rejected', m.NoRedirect().redirect_request,
                  None, None, 302, COOKIE, {}, 'https://evil.invalid/' + SIGNED)
        self.opener = Opener([HTTPError(YT_AUDIO, 302, COOKIE, {}, None)])
        self.code('redirect_rejected', self.run_yt)
        self.assertEqual(len(self.opener.requests), 1)

    def test_nonempty_directory_never_overwritten_or_cleaned(self):
        existing = self.directory / 'audio.m4a'
        existing.write_bytes(b'KEEP_USER_DATA')
        other = self.directory / 'notes.txt'
        other.write_bytes(b'KEEP_NOTES')
        self.code('output_not_empty', self.run_yt)
        self.assertEqual(existing.read_bytes(), b'KEEP_USER_DATA')
        self.assertEqual(other.read_bytes(), b'KEEP_NOTES')
        self.build.assert_not_called()

    def test_racing_existing_file_not_overwritten_or_deleted(self):
        class RacingOpener:
            def open(inner, req, timeout):
                (self.directory / 'audio.m4a').write_bytes(b'RACING_USER_DATA')
                return Response()
        self.opener = RacingOpener()
        self.code('output_exists', self.run_yt)
        self.assertEqual((self.directory / 'audio.m4a').read_bytes(), b'RACING_USER_DATA')

    def test_failed_download_keeps_other_files_created_concurrently(self):
        def create_note():
            (self.directory / 'unrelated.txt').write_bytes(b'KEEP')
        self.opener = Opener([Response(on_read=create_note)])
        self.code('size_limit', self.run_yt, max_bytes=8)
        self.assertEqual([p.name for p in self.directory.iterdir()], ['unrelated.txt'])

    def test_missing_directory_rejected_without_creation(self):
        missing = self.root / 'not-created'
        self.code('output_not_empty', m.download_audio, VIDEO, missing)
        self.assertFalse(missing.exists())

    def test_invalid_limits_stop_without_network(self):
        for kwargs in ({'timeout': 0}, {'max_bytes': -1}, {'max_duration': float('inf')}, {'max_bytes': True},
                       {'audio_language': 'en,zh'}, {'page': True}):
            with self.subTest(kwargs=kwargs):
                self.code('invalid_input', self.run_yt, **kwargs)
        self.build.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
