"""Offline document regression. Every generated artifact stays under TEMP/TMP."""
import builtins
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile
from xml.etree import ElementTree as ET

SPEC = importlib.util.spec_from_file_location('video_study_document_export', Path(__file__).parents[1] / 'python' / 'document_export.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
NS = {'m': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
      'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'r': 'http://schemas.openxmlformats.org/package/2006/relationships'}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='document-export-offline-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / '中文目录' / '导出稿件'
        self.request = dict(title='中文课程 / 第1讲：公式', markdown='# 标题\n\n自然段 **粗体**。',
                            directory=str(self.directory), format='docx')
        # No network API may be used, even if hostile Markdown asks for it.
        self.addCleanup(patch.stopall)
        patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')).start()
        patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')).start()

    def export(self, **changes):
        result = m.export_document(dict(self.request, **changes))
        self.assertEqual(result.get('status'), 'ok', result)
        return result

    def xml(self, result):
        with zipfile.ZipFile(result['document_file']) as archive:
            return ET.fromstring(archive.read('word/document.xml'))

    def test_chinese_path_docx_styles_and_final_reopen(self):
        from docx import Document
        result = self.export(markdown='# 一级\n\n正文 **重点**\n\n> 引用\n\n- 列表\n1. 编号\n\n## 二级')
        target = Path(result['document_file'])
        self.assertEqual(target.parent, self.directory)
        self.assertNotIn('/', target.name)
        reopened = Document(target)
        self.assertEqual(reopened.core_properties.title, self.request['title'])
        self.assertEqual(reopened.styles['Normal'].font.size.pt, 12)
        self.assertEqual(reopened.styles['Normal'].element.find('.//' + '{' + NS['w'] + '}rFonts').get('{' + NS['w'] + '}eastAsia'), '宋体')
        self.assertAlmostEqual(reopened.sections[0].page_width.mm, 210, places=1)
        self.assertTrue(reopened.styles['Heading 1'].paragraph_format.keep_with_next)
        self.assertTrue(reopened.styles['Normal'].paragraph_format.widow_control)
        self.assertIn('Heading 2', [p.style.name for p in reopened.paragraphs])
        self.assertTrue(any(r.bold and r.text == '重点' for p in reopened.paragraphs for r in p.runs))
        self.assertEqual(result['warnings'], [])

    def test_random_filenames_do_not_overwrite(self):
        first = self.export(format='txt')
        first_path = Path(first['document_file'])
        saved = first_path.read_bytes()
        second = self.export(format='txt', markdown='different')
        self.assertNotEqual(first['document_file'], second['document_file'])
        self.assertEqual(first_path.read_bytes(), saved)

    def test_exclusive_creation_even_uuid_collision(self):
        fixed = uuid.UUID('11111111-1111-4111-8111-111111111111')
        with patch.object(m.uuid, 'uuid4', return_value=fixed):
            first = self.export(format='md')
            before = Path(first['document_file']).read_bytes()
            result = m.export_document(dict(self.request, format='md'))
        self.assertEqual(result['code'], 'output_exists')
        self.assertEqual(Path(first['document_file']).read_bytes(), before)

    def test_unsafe_directories(self):
        bad = ['relative', '../outside', '', r'\\server\share\output', '//server/share',
               r'\\?\C:\output', r'\\.\C:\output', r'C:relative',
               str(self.root) + '/a/../b', str(self.root) + '/./b',
               str(self.root) + '/NUL', str(self.root) + '/COM1.txt',
               str(self.root) + '/CONIN$', str(self.root) + '/LPT¹',
               str(self.root) + '/x:stream', str(self.root) + '/trailing.',
               str(self.root) + '/trailing ', str(self.root) + '/wild*card']
        for directory in bad:
            with self.subTest(directory=directory):
                result = m.export_document(dict(self.request, directory=directory, format='md'))
                self.assertEqual(result.get('code'), 'directory_invalid', result)

    def test_file_in_directory_chain(self):
        target = self.root / 'not-directory'
        target.write_bytes(b'leave alone')
        result = m.export_document(dict(self.request, directory=str(target / 'child'), format='md'))
        self.assertEqual(result['code'], 'directory_invalid')
        self.assertEqual(target.read_bytes(), b'leave alone')

    def test_symlink_parent_chain(self):
        actual = self.root / 'actual'
        actual.mkdir()
        link = self.root / 'linked'
        try:
            link.symlink_to(actual, target_is_directory=True)
        except OSError:
            self.skipTest('OS does not grant symlink creation')
        result = m.export_document(dict(self.request, directory=str(link / 'child'), format='md'))
        self.assertEqual(result['code'], 'directory_invalid')
        self.assertFalse((actual / 'child').exists())

    def test_reparse_directory_rejected_without_os_symlink_privilege(self):
        actual = self.root.lstat()
        class Reparse:
            st_mode = actual.st_mode
            st_file_attributes = 0x400
        with patch.object(Path, 'lstat', return_value=Reparse()):
            result = m.export_document(dict(self.request, format='md'))
        self.assertEqual(result['code'], 'directory_invalid')

    def test_formula_omml_fractions_scripts_and_delimiters(self):
        markdown = (r'行内 $\frac{\partial A}{\partial z}+\alpha A+\beta_2 A+\gamma |A|^2 A$。'
                    '\n\n' + r'$$T=t-\beta_1 z,\quad$$'  # Unknown quad must fallback intact.
                    '\n\n' + r'\(R_s/\beta_2=\frac{1}{100\times10^9}\)' + '\n\n'
                    + r'\[\sqrt{x_1^2}+\int_0^\infty \exp(-x)\mathrm{ps}\]' + '\n\n'
                    + r'$\pi+\lambda+\omega+\Delta+\sech(x)\cdot a\approx b\le c\ge d\pm e$')
        result = self.export(markdown=markdown)
        xml = self.xml(result)
        self.assertEqual(result['formula_count'], 5)
        self.assertEqual(len(xml.findall('.//m:oMath', NS)), 4)
        self.assertEqual(len(xml.findall('.//m:f', NS)), 2)
        self.assertGreaterEqual(len(xml.findall('.//m:sSub', NS)), 3)
        self.assertGreaterEqual(len(xml.findall('.//m:sSubSup', NS)), 1)
        self.assertEqual(len(xml.findall('.//m:rad', NS)), 1)
        self.assertEqual(len(result['warnings']), 1)
        math_text = ''.join(xml.itertext())
        self.assertIn('∂', math_text)
        self.assertIn('β', math_text)
        self.assertIn('∞', math_text)
        self.assertIn('ps', math_text)
        self.assertIn(r'$$T=t-\beta_1 z,\quad$$', math_text)

    def test_nonlinear_schrodinger_formula_corpus(self):
        formulas = [
            r'T_s=\frac{1}{R_s}=\frac{1}{100\times10^9}\,\mathrm{s}=10\,\mathrm{ps}',
            r'A(z,T)', r'|A|^2', r'T=t-\beta_1z',
            r'\frac{\partial A}{\partial z}+\frac{\alpha}{2}A+\frac{i\beta_2}{2}\frac{\partial^2 A}{\partial T^2}=i\gamma|A|^2A',
            r'\alpha', r'\beta_2', r'\gamma', r'\alpha A/2', r'\alpha A',
            r'\exp(-\alpha z/2)', r'\exp(-\alpha z)', r'\alpha=0', r'i',
            r'i\frac{\partial A}{\partial z}-\frac{\beta_2}{2}\frac{\partial^2 A}{\partial T^2}+\gamma|A|^2A=0',
            r'\gamma=0', r'\gamma>0', r'\beta_2<0', r'P_0T_0^2=|\beta_2|/\gamma',
        ]
        result = self.export(markdown='\n\n'.join('> 核对 $' + formula + '$' for formula in formulas))
        self.assertEqual(result['warnings'], [])
        self.assertEqual(result['formula_count'], len(formulas))
        xml = self.xml(result)
        self.assertEqual(len(xml.findall('.//m:oMath', NS)), len(formulas))
        subs = [''.join(sub.itertext()) for sub in xml.findall('.//m:sub', NS)]
        self.assertIn('1', subs)
        self.assertNotIn('1z', subs)

    def test_bold_span_survives_inline_math(self):
        from docx import Document
        result = self.export(markdown='**前 $x$ 后** 结束')
        paragraph = Document(result['document_file']).paragraphs[1]
        self.assertTrue(any(run.bold and run.text == ' 后' for run in paragraph.runs))
        self.assertTrue(any(not run.bold and run.text == ' 结束' for run in paragraph.runs))

    def test_all_four_delimiters_and_multiline_display(self):
        result = self.export(markdown='$a$\n\n$$\nb_2\n\n+c\n$$\n\n' + r'\(x^2\) and \[y\]')
        self.assertEqual(result['formula_count'], 4)
        self.assertEqual(len(self.xml(result).findall('.//m:oMath', NS)), 4)
        self.assertEqual(result['warnings'], [])

    def test_supported_text_abs_and_grouping(self):
        result = self.export(markdown=r'$\text{hello world}+\operatorname{sech}(x)+\abs{x}+{a+b}_i+\left|A\right|^2$')
        xml = self.xml(result)
        self.assertEqual(result['warnings'], [])
        self.assertIn('hello world', ''.join(xml.itertext()))
        self.assertEqual(len(xml.findall('.//m:d', NS)), 1)
        self.assertEqual(len(xml.findall('.//m:sSub', NS)), 1)

    def test_unknown_formula_unchanged_visible_warning(self):
        original = r'$$\unknown{x}+\frac{1}{2}$$'
        result = self.export(markdown='前面 ' + original + ' 后面')
        xml = self.xml(result)
        self.assertEqual(result['formula_count'], 1)
        self.assertEqual(len(xml.findall('.//m:oMath', NS)), 0)
        self.assertIn(original, ''.join(xml.itertext()))
        self.assertIn('formula_unsupported:1:', result['warnings'][0])
        self.assertIn('保留原始 LaTeX', result['warnings'][0])

    def test_long_deep_and_malformed_formula_fallback_never_truncate(self):
        cases = ['a' * 9000, '{' * 100 + 'x' + '}' * 100,
                 r'\frac{x}', 'x_1_2', r'\sqrt[3]{x}', 'x^', r'\text{\unknown}']
        for formula in cases:
            original = '$' + formula + '$'
            with self.subTest(size=len(formula)):
                result = self.export(markdown=original)
                self.assertEqual(len(result['warnings']), 1)
                self.assertIn(original, ''.join(self.xml(result).itertext()))

    def test_no_external_relationship_or_remote_resource(self):
        markdown = ('![img](https://evil.invalid/a.png) [link](file:///private)\n\n'
                    '<img src="https://evil.invalid/x"><script>throw 1</script>')
        result = self.export(markdown=markdown, source_url='https://www.youtube.com/watch?v=abc_123')
        with zipfile.ZipFile(result['document_file']) as archive:
            self.assertFalse(any(name.startswith('word/media/') for name in archive.namelist()))
            for name in archive.namelist():
                if name.endswith('.rels'):
                    root = ET.fromstring(archive.read(name))
                    self.assertFalse(any(rel.get('TargetMode') == 'External' for rel in root))
        self.assertIn('<script>throw 1</script>', ''.join(self.xml(result).itertext()))

    def test_md_and_txt_and_no_docx_dependency(self):
        real_import = builtins.__import__
        def guarded(name, *args, **kwargs):
            if name == 'docx' or name.startswith('docx.'):
                raise ModuleNotFoundError('SECRET dependency path')
            return real_import(name, *args, **kwargs)
        original = '# 小节\n\n**重点** $\\alpha_1$\n\n> 引用\n\n- 项目'
        with patch.object(builtins, '__import__', side_effect=guarded):
            md = self.export(format='md', markdown=original)
            txt = self.export(format='txt', markdown=original)
            failed = m.export_document(dict(self.request))
        self.assertEqual(failed, {'status': 'error', 'code': 'dependency_missing', 'message': m.MESSAGES['dependency_missing']})
        self.assertIn(original, Path(md['document_file']).read_text(encoding='utf-8'))
        text = Path(txt['document_file']).read_text(encoding='utf-8')
        self.assertIn('重点 $\\alpha_1$', text)
        self.assertNotIn('**', text)
        self.assertNotIn('# 小节', text)
        self.assertEqual(txt['formula_count'], 1)
        self.assertEqual(len(list(self.directory.glob('*.docx'))), 0)

    def test_invalid_types_unknown_fields_controls_and_size(self):
        changes = [dict(extra='x'), dict(title=''), dict(title='a\nb'), dict(format='pdf'),
                   dict(markdown='x\x00y'), dict(markdown='x\x7fy'), dict(markdown='x\x85y'),
                   dict(markdown='\ud800'), dict(markdown=True), dict(source_url=None),
                   dict(markdown='x' * m.MAX_INPUT)]
        for change in changes:
            with self.subTest(change_keys=list(change)):
                result = m.export_document(dict(self.request, **change))
                self.assertEqual(result.get('code'), 'invalid_input', result)
        self.export(format='md', markdown='allowed\n\t\rline')
        for invalid in (None, [], 1, 'request'):
            self.assertEqual(m.export_document(invalid)['code'], 'invalid_input')

    def test_source_url_never_embeds_secrets_or_nonweb_scheme(self):
        for source in ('file:///secret', 'javascript:alert(1)', 'https://u:p@example.com/',
                       'https://example.com/?token=SECRET', 'https://example.com/#SECRET',
                       'https://example.com/?p=1&p=2', 'https://example.com/?p=0',
                       'https://example.com/?v=abc%20def', 'https://example.com/\nsecret'):
            with self.subTest(source=source):
                self.assertEqual(m.export_document(dict(self.request, source_url=source))['code'], 'invalid_input')
        self.export(format='md', source_url='https://www.bilibili.com/video/BV123?p=2')

    def test_static_errors_no_exception_leak(self):
        with patch.object(m, '_text_write', side_effect=RuntimeError('SECRET exception and private path')):
            result = m.export_document(dict(self.request, format='txt'))
        self.assertEqual(result, {'status': 'error', 'code': 'export_failed', 'message': m.MESSAGES['export_failed']})
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_final_reopen_failure_is_not_success_and_removes_output(self):
        import docx
        original = docx.Document
        calls = []
        def factory(*args, **kwargs):
            calls.append(args)
            if len(calls) == 2:
                raise ValueError('SECRET bad docx')
            return original(*args, **kwargs)
        with patch.object(docx, 'Document', side_effect=factory):
            result = m.export_document(dict(self.request))
        self.assertEqual(result['code'], 'export_failed')
        self.assertEqual(len(calls), 2)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_resource_bounds_keep_formula_original_or_reject_before_write(self):
        with patch.object(m, 'MAX_OMML_CHARACTERS', 2):
            result = self.export(markdown='$xy$ and $z$')
        self.assertEqual(len(result['warnings']), 1)
        self.assertIn('$z$', ''.join(self.xml(result).itertext()))
        with patch.object(m, 'MAX_BLOCKS', 1):
            result = m.export_document(dict(self.request, markdown='one\n\ntwo'))
        self.assertEqual(result['code'], 'invalid_input')
        unmatched = r'\(' * 10000
        self.assertEqual(list(m._inline(unmatched)), [('text', unmatched, '')])

    def test_formula_limit(self):
        result = m.export_document(dict(self.request, markdown='$x$ ' * (m.MAX_FORMULAS + 1)))
        self.assertEqual(result['code'], 'invalid_input')

    def test_stdin_main_strict_utf8_size_and_duplicate_keys(self):
        class Channels:
            def __init__(self, payload=b''):
                self.buffer = io.BytesIO(payload)
        payloads = [b'\xff', b'{}', b'{"title":"a","title":"b"}',
                    b'{"title":NaN}', b' ' * (m.MAX_INPUT + 1)]
        for payload in payloads:
            output = Channels()
            with patch.object(m.sys, 'stdin', Channels(payload)), patch.object(m.sys, 'stdout', output):
                m.main()
            result = json.loads(output.buffer.getvalue())
            self.assertEqual(result['code'], 'invalid_input')
        output = Channels()
        request = dict(self.request, format='md')
        with patch.object(m.sys, 'stdin', Channels(json.dumps(request, ensure_ascii=False).encode('utf-8'))), patch.object(m.sys, 'stdout', output):
            m.main()
        result = json.loads(output.buffer.getvalue())
        self.assertEqual(result['status'], 'ok')

    def test_windows_handles_prevent_parent_replacement(self):
        if os.name != 'nt':
            self.skipTest('Windows sharing semantics')
        self.directory.mkdir(parents=True)
        moved = self.directory.with_name('moved')
        with m._locked_directory(str(self.directory)):
            with self.assertRaises(OSError):
                self.directory.rename(moved)
        self.assertTrue(self.directory.is_dir())


if __name__ == '__main__':
    unittest.main()
