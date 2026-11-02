"""Offline regression tests. Fixtures contain only fake credentials; no network."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

P = Path(__file__).resolve().parent.parent / 'python' / 'bilibili_subtitles.py'
spec = importlib.util.spec_from_file_location('bili_subtitle_helper', P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Response:
    def __init__(self, obj):
        self.raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return self.raw[:limit]


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bili-skill-test-', dir=str(Path.cwd()))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cookie = self.root / 'fake_cookie.json'
        self.cookie.write_text(json.dumps({'SESSDATA':'FAKE_TEST_TOKEN'}), encoding='utf-8')

    def run_fixture(self, override=None, caption_end=1421.62, session_override=None,
                    cookie_file=True, view_override=None):
        view = {'code':0, 'data':{'aid':500152961,'title':'光纤通信技术','pages':[{'page':27,'cid':254923561,'part':'基本概念','duration':1422}]}}
        data = {'aid':500152961,'bvid':'BV17K411P7hC','cid':254923561,'page_no':27,'login_mid':1,'need_login_subtitle':False,'subtitle':{'subtitles':[{'lan':'ai-zh','lan_doc':'中文','ai_type':0,'subtitle_url':'https://aisubtitle.hdslb.com/test.json?secret=FAKE_SIGNED_QUERY'}]}}
        if override: data.update(override)
        if view_override: view['data'].update(view_override)
        bodies = [view, {'code':0,'data':data}, {'body':[{'from':0.82,'to':caption_end,'content':'光纤导模 0<x<1 与 y>0'}]}]
        calls=[]
        class Opener:
            def open(self, req, timeout):
                calls.append(req)
                return Response(bodies[len(calls)-1])
        out=self.root/'new-output'
        argv=['helper','--bvid','BV17K411P7hC','--page','27','--cookie-file',str(self.cookie),'--out',str(out),'--proxy','http://127.0.0.1:7897']
        if not cookie_file:
            position = argv.index('--cookie-file')
            del argv[position:position + 2]
        with patch.object(sys,'argv',argv), patch.object(m,'build_opener',return_value=Opener()), contextlib.redirect_stdout(io.StringIO()):
            m.main(session_override=session_override)
        return out,calls

    def test_authenticated_success_safety_and_ai_classification(self):
        out,calls=self.run_fixture()
        meta=json.loads((out/'metadata.json').read_text(encoding='utf-8'))
        self.assertEqual(meta['caption_kind'],'auto')  # ai-zh overrides ai_type=0
        self.assertFalse(meta['content_verified'])
        self.assertEqual(meta['segments'],1)
        self.assertEqual(meta['warnings'],[])
        self.assertNotIn('Cookie',calls[0].headers)
        self.assertIn('Cookie',calls[1].headers)
        self.assertNotIn('Cookie',calls[2].headers)
        self.assertIn('/x/player/wbi/v2?',calls[1].full_url)
        self.assertIn('aid=500152961',calls[1].full_url)
        self.assertNotIn('FAKE_TEST_TOKEN',(out/'metadata.json').read_text(encoding='utf-8'))
        self.assertNotIn('FAKE_SIGNED_QUERY',(out/'metadata.json').read_text(encoding='utf-8'))
        self.assertIn('0<x<1',(out/'transcript.txt').read_text(encoding='utf-8'))

    def test_mismatched_identity_stops(self):
        with self.assertRaises(m.SafeFailure) as caught: self.run_fixture({'cid':123})
        self.assertEqual(caught.exception.payload['status'],'video_identity_mismatch')

    def test_missing_identity_stops(self):
        with self.assertRaises(m.SafeFailure) as caught: self.run_fixture({'cid':None})
        self.assertEqual(caught.exception.payload['status'],'video_identity_mismatch')

    def test_early_end_is_warning_not_full_coverage(self):
        out,_=self.run_fixture(caption_end=746.54)
        meta=json.loads((out/'metadata.json').read_text(encoding='utf-8'))
        self.assertTrue(meta['warnings'])
        self.assertGreater(meta['trailing_gap_seconds'],600)
        self.assertFalse(meta['content_verified'])

    def test_edge_whitespace_tolerated_internal_controls_rejected(self):
        self.cookie.write_text('{"SESSDATA":"  FAKE_TEST_TOKEN\t"}',encoding='utf-8')
        self.assertEqual(m.session_value(self.cookie),'FAKE_TEST_TOKEN')
        self.cookie.write_text('{"SESSDATA":"FAKE\tTOKEN"}',encoding='utf-8')
        with self.assertRaises(m.SafeFailure): m.session_value(self.cookie)

    def test_redirect_is_not_followed(self):
        with self.assertRaises(m.SafeFailure):
            m.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://example.com/')

    def test_existing_output_not_overwritten(self):
        argv=['helper','--bvid','BV17K411P7hC','--page','27','--out',str(self.root)]
        with patch.object(sys,'argv',argv), self.assertRaises(m.SafeFailure) as caught:
            m.main()
        self.assertEqual(caught.exception.payload['status'],'output_must_be_new_absolute_directory')

    def test_private_session_api_only_without_file_or_temporary_secret(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        with patch.object(m, 'session_value', side_effect=AssertionError('no file reads')):
            out, calls = self.run_fixture(session_override=secret, cookie_file=False)
        self.assertNotIn('Cookie', calls[0].headers)
        self.assertEqual(calls[1].get_header('Cookie'), 'SESSDATA=' + secret)
        self.assertNotIn('Cookie', calls[2].headers)
        self.assertEqual(sorted(p.name for p in out.iterdir()),
                         ['metadata.json', 'original.json', 'transcript.txt'])
        for path in self.root.rglob('*'):
            if path.is_file():
                self.assertNotIn(secret, path.read_text(encoding='utf-8'))

    def test_private_session_file_conflict_precedes_file_or_network(self):
        with patch.object(m, 'session_value', side_effect=AssertionError('must not read')), \
             patch.object(m, 'build_opener') as build, self.assertRaises(m.SafeFailure) as caught:
            self.run_fixture(session_override='FAKE_PRIVATE_MEMORY_SESSION')
        self.assertEqual(caught.exception.payload, {'status': 'credential_conflict', 'phase': 'credentials'})
        build.assert_not_called()

    def test_private_session_strict_pure_validation_and_no_secret_echo(self):
        good = 'Fake%2Ftoken!' + 'x' * 15987
        self.assertEqual(m.validate_session(good), good)
        self.assertEqual(len(good), 16000)
        for value in (None, 1, True, {}, [], '', 'a' * 16001, ' token', 'token ',
                      'a b', 'a\tb', 'a\nb', 'a\rb', 'a;b', 'a\x00b', 'a\x7fb', '令牌'):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(m.SafeFailure) as caught:
                m.validate_session(value)
            self.assertEqual(caught.exception.payload, {'status': 'invalid_session', 'phase': 'credentials'})
            self.assertEqual(caught.exception.args, ('invalid_session', 'credentials'))

    def test_private_session_invalid_precedes_network_and_output(self):
        with patch.object(m, 'build_opener') as build, self.assertRaises(m.SafeFailure) as caught:
            self.run_fixture(session_override='FAKE_INVALID;TOKEN', cookie_file=False)
        self.assertEqual(caught.exception.payload['status'], 'invalid_session')
        build.assert_not_called()
        self.assertFalse((self.root / 'new-output').exists())

    def test_private_session_reflected_title_redacted_not_normal_content(self):
        secret = 'FAKE_PRIVATE_MEMORY_SESSION'
        out, _ = self.run_fixture(session_override=secret, cookie_file=False,
                                 view_override={'title': '正常课程 ' + secret + ' 后半'})
        metadata = (out / 'metadata.json').read_text(encoding='utf-8')
        self.assertNotIn(secret, metadata)
        self.assertIn('正常课程', metadata)
        self.assertIn('光纤导模', (out / 'transcript.txt').read_text(encoding='utf-8'))

    def test_private_session_has_no_cli_argument(self):
        argv = ['helper', '--bvid', 'BV17K411P7hC', '--page', '27', '--out', str(self.root / 'unused'),
                '--session-override', 'FAKE_PRIVATE_MEMORY_SESSION']
        with patch.object(sys, 'argv', argv), contextlib.redirect_stderr(io.StringIO()), \
             self.assertRaises(SystemExit) as caught:
            m.main()
        self.assertEqual(caught.exception.code, 2)

    def test_timestamp(self):
        self.assertEqual(m.stamp(1421.62),'00:23:41.620')


if __name__=='__main__': unittest.main(verbosity=2)
