"""Offline, bounded Markdown/DOCX export. No resource or hyperlink resolution.

Public API: export_document(request) -> dict. Only the destination and the newly
created output are accessed (besides Python/python-docx's own bundled resources).
The finite math grammar deliberately fails closed to visible original LaTeX.
"""
from __future__ import annotations

import contextlib
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata
import uuid
from urllib.parse import parse_qsl, urlsplit

MAX_INPUT = 2 * 1024 * 1024
MAX_FORMULAS = 1024
MAX_BLOCKS = 10000
MAX_OMML_CHARACTERS = 65536
MESSAGES = {
    'invalid_input': '文档参数无效；仅接受规定字段与不超过 2 MiB 的 UTF-8 JSON。',
    'directory_invalid': '输出目录不安全；请使用无链接父链的本机绝对路径。',
    'dependency_missing': '缺少 python-docx 依赖；不会自动安装。',
    'output_exists': '无法生成新的输出文件；未覆盖任何已有文件。',
    'export_failed': '文档导出或最终校验失败；未输出底层异常。',
}
_FIELDS = {'title', 'markdown', 'source_url', 'directory', 'format'}
_RESERVED = re.compile(r'^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)', re.I)
_BAD_XML = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]')


class ExportError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES[code])


def _fail(code):
    raise ExportError(code)


def _validate(request):
    if (not isinstance(request, dict) or set(request) - _FIELDS
            or not {'title', 'markdown', 'directory', 'format'} <= set(request)):
        _fail('invalid_input')
    for key, value in request.items():
        if not isinstance(value, str) or _BAD_XML.search(value):
            _fail('invalid_input')
    if (not request['title'].strip() or len(request['title']) > 200
            or '\n' in request['title'] or '\r' in request['title']
            or request['format'] not in ('docx', 'md', 'txt')
            or len(request.get('source_url', '')) > 4096):
        _fail('invalid_input')
    source = request.get('source_url', '')
    if source:
        try:
            url = urlsplit(source)
            query = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
            if (url.scheme not in ('https', 'http') or not url.hostname
                    or url.username is not None or url.password is not None
                    or url.fragment or url.port not in (None, 80, 443)
                    or any(c.isspace() for c in source) or '\\' in source
                    or '%' in source or len({key for key, _ in query}) != len(query)
                    or any(key not in ('p', 'v') for key, _ in query)
                    or any(not re.fullmatch(r'[1-9][0-9]{0,5}' if key == 'p' else r'[A-Za-z0-9_-]{1,64}', value)
                           for key, value in query)):
                _fail('invalid_input')
        except (ValueError, TypeError):
            _fail('invalid_input')
    if len(json.dumps(request, ensure_ascii=False).encode('utf-8')) > MAX_INPUT:
        _fail('invalid_input')
    return request


def _directory_parts(value):
    # Validate lexical components BEFORE normalization: never erase traversal.
    if (not value or len(value) > 4096 or value.startswith(('\\', '//'))
            or any(ord(c) < 32 for c in value) or '\x7f' in value):
        _fail('directory_invalid')
    drive, tail = ntpath.splitdrive(value)
    if drive and not re.fullmatch('[A-Za-z]:', drive):
        _fail('directory_invalid')
    components = re.split(r'[\\/]', tail)
    for part in components:
        if not part:
            continue
        if (part in ('.', '..') or part.endswith((' ', '.')) or _RESERVED.match(part.split('.')[0].rstrip(' '))
                or any(c in part for c in '<>:"|?*')):
            _fail('directory_invalid')
    path = Path(value)
    if not path.is_absolute():
        _fail('directory_invalid')
    return path


def _check_directory(path):
    try:
        info = path.lstat()
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
                or getattr(info, 'st_file_attributes', 0) & 0x400):
            _fail('directory_invalid')
    except ExportError:
        raise
    except OSError:
        _fail('directory_invalid')


@contextlib.contextmanager
def _locked_directory(value):
    path = _directory_parts(value)
    with contextlib.ExitStack() as stack:
        # Windows directory handles deny DELETE sharing: an ancestor cannot be
        # replaced by a junction/symlink after inspection while exporting.
        lock = None
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            create = kernel.CreateFileW
            create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                               wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            create.restype = wintypes.HANDLE
            close = kernel.CloseHandle
            close.argtypes = [wintypes.HANDLE]
            close.restype = wintypes.BOOL

            def lock(current):
                handle = create(str(current), 0x80000000, 3, None, 3, 0x02200000, None)
                if handle == wintypes.HANDLE(-1).value:
                    _fail('directory_invalid')
                stack.callback(close, handle)
                _check_directory(current)
        current = Path(path.anchor)
        _check_directory(current)
        if lock:
            lock(current)
        for component in path.parts[1:]:
            current = current / component
            try:
                current.mkdir()
            except FileExistsError:
                pass
            except OSError:
                _fail('directory_invalid')
            _check_directory(current)
            if lock:
                lock(current)
        yield path


def _filename(title, extension):
    safe = unicodedata.normalize('NFKC', title)
    safe = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in safe)
    safe = re.sub(r'\s+', '_', safe).strip('_. ')[:72] or 'document'
    return f'{safe}-{uuid.uuid4().hex}.{extension}'


def _escaped(text, index):
    slashes = 0
    index -= 1
    while index >= 0 and text[index] == '\\':
        slashes += 1
        index -= 1
    return slashes % 2 == 1


def _inline(text):
    """Yield (text|formula, original, inner); delimiters are never discarded."""
    position = start = slashes = 0
    exhausted = set()
    while position < len(text):
        opener = closer = None
        if not slashes % 2:
            if text.startswith('$$', position):
                opener = closer = '$$'
            elif text[position] == '$':
                opener = closer = '$'
            elif text.startswith('\\(', position):
                opener, closer = '\\(', '\\)'
            elif text.startswith('\\[', position):
                opener, closer = '\\[', '\\]'
        if opener and closer not in exhausted:
            end = text.find(closer, position + len(opener))
            while end >= 0 and _escaped(text, end):
                end = text.find(closer, end + len(closer))
            if end >= 0:
                if position > start:
                    yield 'text', text[start:position], ''
                finish = end + len(closer)
                yield 'formula', text[position:finish], text[position + len(opener):end]
                position = start = finish
                slashes = 0
                continue
            exhausted.add(closer)
        slashes = slashes + 1 if text[position] == '\\' else 0
        position += 1
    if start < len(text):
        yield 'text', text[start:], ''


_SYMBOLS = {
    'partial': '∂', 'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'pi': 'π',
    'lambda': 'λ', 'omega': 'ω', 'Delta': 'Δ', 'delta': 'δ', 'theta': 'θ',
    'infty': '∞', 'infinity': '∞', 'int': '∫', 'cdot': '·', 'times': '×',
    'approx': '≈', 'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥', 'pm': '±',
    'exp': 'exp', 'sech': 'sech', 'sin': 'sin', 'cos': 'cos', 'log': 'log',
    'ln': 'ln', 'vert': '|', 'lvert': '|', 'rvert': '|', 'langle': '⟨', 'rangle': '⟩',
}
_NORMAL = {'exp', 'sech', 'sin', 'cos', 'log', 'ln'}


class _UnsupportedMath(Exception):
    pass


class _MathParser:
    def __init__(self, text):
        if len(text) > 8192:
            raise _UnsupportedMath()
        self.text, self.i, self.depth, self.tokens = text, 0, 0, 0

    def space(self):
        while self.i < len(self.text) and self.text[self.i].isspace():
            self.i += 1

    def group(self):
        self.space()
        if self.i >= len(self.text) or self.text[self.i] != '{':
            raise _UnsupportedMath()
        self.i += 1
        result = self.sequence(True)
        return result

    def literal_group(self):
        self.space()
        if self.i >= len(self.text) or self.text[self.i] != '{':
            raise _UnsupportedMath()
        self.i += 1
        start = self.i
        while self.i < len(self.text) and self.text[self.i] != '}':
            if self.text[self.i] in '{\\':
                raise _UnsupportedMath()
            self.i += 1
        if self.i >= len(self.text):
            raise _UnsupportedMath()
        value = self.text[start:self.i]
        self.i += 1
        return ('run', value, True)

    def atom(self):
        self.space()
        self.tokens += 1
        if self.tokens > 4096 or self.i >= len(self.text):
            raise _UnsupportedMath()
        char = self.text[self.i]
        self.i += 1
        if char == '{':
            return self.sequence(True)
        if char == '\\':
            match = re.match(r'[A-Za-z]+|.', self.text[self.i:])
            if not match:
                raise _UnsupportedMath()
            command = match.group()
            self.i += len(command)
            if command in _SYMBOLS:
                return ('run', _SYMBOLS[command], command in _NORMAL)
            if command == 'frac':
                return ('frac', self.group(), self.group())
            if command == 'sqrt':
                return ('sqrt', self.group())
            if command == 'abs':
                return ('abs', self.group())
            if command == 'text':
                return self.literal_group()
            if command in ('mathrm', 'operatorname'):
                return ('normal', self.group())
            if command in ('left', 'right'):
                self.space()
                if self.i < len(self.text) and self.text[self.i] in '()[]|':
                    char = self.text[self.i]
                    self.i += 1
                    return ('run', char, False)
                raise _UnsupportedMath()
            if command in (',', ';', ':', '!', ' '):
                return ('run', '' if command == '!' else ' ', False)
            if command in ('{', '}', '_', '%', '$', '#', '&', '|'):
                return ('run', command, False)
            raise _UnsupportedMath()
        if char in '}_^$&#%~' or ord(char) < 32:
            raise _UnsupportedMath()
        return ('run', char, False)

    def sequence(self, grouped=False):
        self.depth += 1
        if self.depth > 40:
            raise _UnsupportedMath()
        nodes = []
        while True:
            self.space()
            if self.i >= len(self.text):
                if grouped:
                    raise _UnsupportedMath()
                break
            if self.text[self.i] == '}':
                if not grouped:
                    raise _UnsupportedMath()
                self.i += 1
                break
            base = self.atom()
            sub = sup = None
            while True:
                self.space()
                if self.i >= len(self.text) or self.text[self.i] not in '_^':
                    break
                marker = self.text[self.i]
                self.i += 1
                if marker == '_':
                    if sub is not None:
                        raise _UnsupportedMath()
                    sub = self.atom()
                else:
                    if sup is not None:
                        raise _UnsupportedMath()
                    sup = self.atom()
            if sub is not None or sup is not None:
                base = ('script', base, sub, sup)
            nodes.append(base)
        self.depth -= 1
        return ('seq', nodes)

    def parse(self):
        result = self.sequence()
        if not result[1]:
            raise _UnsupportedMath()
        return result


def _math_xml(node, element, normal=False):
    kind = node[0]
    if kind == 'seq':
        for child in node[1]:
            _math_xml(child, element, normal)
    elif kind == 'normal':
        _math_xml(node[1], element, True)
    elif kind == 'run':
        run = element.makeelement('{http://schemas.openxmlformats.org/officeDocument/2006/math}r')
        element.append(run)
        if normal or node[2]:
            props = run.makeelement('{http://schemas.openxmlformats.org/officeDocument/2006/math}rPr')
            style = props.makeelement('{http://schemas.openxmlformats.org/officeDocument/2006/math}sty')
            style.set('{http://schemas.openxmlformats.org/officeDocument/2006/math}val', 'p')
            props.append(style)
            run.append(props)
        text = run.makeelement('{http://schemas.openxmlformats.org/officeDocument/2006/math}t')
        text.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        text.text = node[1]
        run.append(text)
    else:
        namespace = '{http://schemas.openxmlformats.org/officeDocument/2006/math}'

        def add(parent, name):
            child = parent.makeelement(namespace + name)
            parent.append(child)
            return child

        if kind == 'frac':
            fraction = add(element, 'f')
            _math_xml(node[1], add(fraction, 'num'), normal)
            _math_xml(node[2], add(fraction, 'den'), normal)
        elif kind == 'sqrt':
            radical = add(element, 'rad')
            hidden = add(add(radical, 'radPr'), 'degHide')
            hidden.set(namespace + 'val', '1')
            add(radical, 'deg')
            _math_xml(node[1], add(radical, 'e'), normal)
        elif kind == 'abs':
            delimiter = add(element, 'd')
            props = add(delimiter, 'dPr')
            for name in ('begChr', 'endChr'):
                add(props, name).set(namespace + 'val', '|')
            _math_xml(node[1], add(delimiter, 'e'), normal)
        elif kind == 'script':
            name = 'sSubSup' if node[2] is not None and node[3] is not None else ('sSub' if node[2] is not None else 'sSup')
            script = add(element, name)
            _math_xml(node[1], add(script, 'e'), normal)
            if node[2] is not None:
                _math_xml(node[2], add(script, 'sub'), normal)
            if node[3] is not None:
                _math_xml(node[3], add(script, 'sup'), normal)


def _blocks(markdown):
    # Protect multiline display math from paragraph splitting. Math is opaque.
    protected = []
    pieces = []
    for kind, original, _ in _inline(markdown):
        if kind == 'formula':
            token = '\x00' + str(len(protected)) + '\x00'
            protected.append(original)
            pieces.append(token)
        else:
            pieces.append(original)
    pending = []

    def restore(text):
        return re.sub(r'\x00(\d+)\x00', lambda match: protected[int(match[1])], text)

    for line in ''.join(pieces).splitlines():
        heading = re.match(r'^ {0,3}(#{1,6})\s+(.+?)\s*#*$', line)
        quote = re.match(r'^ {0,3}>\s?(.*)$', line)
        bullet = re.match(r'^\s*(?:[-+*]|\d+[.)])\s+(.+)$', line)
        special = heading or quote or bullet
        if not line.strip() or special:
            if pending:
                yield 'body', restore(' '.join(pending)), 0
                pending.clear()
            if heading:
                yield 'heading', restore(heading[2]), len(heading[1])
            elif quote:
                yield 'quote', restore(quote[1]), 0
            elif bullet:
                yield 'number' if re.match(r'^\s*\d', line) else 'bullet', restore(bullet[1]), 0
        else:
            pending.append(line.strip())
    if pending:
        yield 'body', restore(' '.join(pending)), 0


def _plain_bold(text):
    return text.replace('**', '')


def _docx_write(stream, request, formula_count):
    try:
        from docx import Document
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.shared import Mm, Pt
    except ImportError:
        _fail('dependency_missing')
    document = Document()
    document.core_properties.title = request['title']
    section = document.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.top_margin = section.bottom_margin = Mm(23)
    section.left_margin = section.right_margin = Mm(25)
    for name in ('Normal', 'Title', 'Heading 1', 'Heading 2', 'Heading 3',
                 'Heading 4', 'Heading 5', 'Heading 6', 'Quote', 'List Bullet', 'List Number'):
        style = document.styles[name]
        style.font.name = '宋体' if name in ('Normal', 'Quote', 'List Bullet', 'List Number') else '微软雅黑'
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), style.font.name)
        style.font.size = Pt(12 if name in ('Normal', 'Quote', 'List Bullet', 'List Number') else (24 if name == 'Title' else max(12, 20 - int(name[-1]) * 2)))
        style.paragraph_format.widow_control = True
        style.paragraph_format.keep_together = name != 'Normal'
        style.paragraph_format.keep_with_next = name.startswith('Heading') or name == 'Title'
        style.paragraph_format.space_after = Pt(7)
    document.add_heading(request['title'], 0)
    if request.get('source_url'):
        document.add_paragraph('来源：' + request['source_url'])  # Literal, never a relationship.
    warnings = []
    index = 0
    remaining_math = MAX_OMML_CHARACTERS
    for kind, text, level in _blocks(request['markdown']):
        style = {'heading': f'Heading {level}', 'quote': 'Quote', 'number': 'List Number', 'bullet': 'List Bullet'}.get(kind, 'Normal')
        paragraph = document.add_paragraph(style=style)
        paragraph.paragraph_format.widow_control = True
        bold = False
        for inline_kind, original, inner in _inline(text):
            if inline_kind == 'text':
                pieces = original.split('**')
                for offset, part in enumerate(pieces):
                    paragraph.add_run(part).bold = bold
                    if offset < len(pieces) - 1:
                        bold = not bold
            else:
                index += 1
                try:
                    if len(inner) > remaining_math:
                        raise _UnsupportedMath()
                    tree = _MathParser(inner).parse()
                except (_UnsupportedMath, RecursionError):
                    paragraph.add_run(original)
                    warnings.append(f'formula_unsupported:{index}:保留原始 LaTeX，未转换为 OMML。')
                else:
                    remaining_math -= len(inner)
                    math = OxmlElement('m:oMath')
                    _math_xml(tree, math)
                    paragraph._p.append(math)
    document.save(stream)
    stream.flush()
    stream.seek(0)
    # Mandatory final reopen; prohibit every external package relationship.
    reopened = Document(stream)
    for part in reopened.part.package.parts:
        if any(relation.is_external for relation in part.rels.values()):
            _fail('export_failed')
    if len(reopened.element.xpath('//m:oMath')) != formula_count - len(warnings):
        _fail('export_failed')
    return warnings


def _text_write(stream, request):
    title = request['title']
    source = '来源：' + request['source_url'] + '\n\n' if request.get('source_url') else ''
    if request['format'] == 'md':
        content = '# ' + title + '\n\n' + source + request['markdown']
    else:
        lines = [title, '', source.rstrip()] if source else [title, '']
        for kind, text, _ in _blocks(request['markdown']):
            # Preserve math verbatim, including any ** inside formula text.
            text = ''.join(original if part == 'formula' else _plain_bold(original)
                           for part, original, _ in _inline(text))
            lines.extend([('• ' if kind in ('number', 'bullet') else '') + text, ''])
        content = '\n'.join(lines)
    stream.write(content.encode('utf-8'))
    stream.flush()


def export_document(request) -> dict:
    """Return an ok record or a static error; never raise underlying exceptions.

    formula_count counts detected formulas, including explicitly warned DOCX
    fallbacks. Markdown/TXT preserve LaTeX and require no python-docx dependency.
    """
    created = None
    try:
        request = _validate(request)
        formula_count = sum(kind == 'formula' for kind, _, _ in _inline(request['markdown']))
        if formula_count > MAX_FORMULAS:
            _fail('invalid_input')
        if request['format'] != 'md':
            for block_index, _ in enumerate(_blocks(request['markdown']), 1):
                if block_index > MAX_BLOCKS:
                    _fail('invalid_input')
        with _locked_directory(request['directory']) as directory:
            identity = None
            try:
                for _ in range(5):
                    candidate = directory / _filename(request['title'], request['format'])
                    try:
                        stream = candidate.open('x+b')
                    except FileExistsError:
                        continue
                    created = candidate
                    identity = os.fstat(stream.fileno())
                    break
                else:
                    _fail('output_exists')
                with stream:
                    if request['format'] == 'docx':
                        warnings = _docx_write(stream, request, formula_count)
                    else:
                        _text_write(stream, request)
                        warnings = []
                result = {'status': 'ok', 'document_file': str(created), 'format': request['format'],
                          'title': request['title'], 'warnings': warnings, 'formula_count': formula_count}
                created = None
                return result
            finally:
                # Cleanup occurs BEFORE releasing ancestor locks; never remove
                # a different file substituted at the random output name.
                if created is not None and identity is not None:
                    try:
                        current = created.lstat()
                        if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                            created.unlink()
                    except OSError:
                        pass
    except ExportError as error:
        code = error.code
    except Exception:
        code = 'export_failed'
    return {'status': 'error', 'code': code, 'message': MESSAGES[code]}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail('invalid_input')
        result[key] = value
    return result


def main():
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            _fail('invalid_input')
        request = json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object,
                             parse_constant=lambda _: _fail('invalid_input'))
        result = export_document(request)
    except Exception:
        result = {'status': 'error', 'code': 'invalid_input', 'message': MESSAGES['invalid_input']}
    # Write UTF-8 explicitly even when a Windows console defaults to a legacy CP.
    payload = (json.dumps(result, ensure_ascii=False) + '\n').encode('utf-8')
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
