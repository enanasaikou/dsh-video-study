"""Explicitly authorized audio-only sources for cloud ASR; captions are untouched.
Titles/part names are untrusted data. Extractor dicts, signed URLs, headers,
proxies and cookies are never persisted. Network operations do not retry.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import json
import math
import re
import tempfile
import time
import warnings
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class AudioSourceError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


_MESSAGES = {
    'invalid_target': '请提供受支持的视频链接或视频编号。',
    'invalid_input': '参数无效或平台参数混用。',
    'invalid_proxy': '代理须为无凭据、无路径的显式地址。',
    'unsupported_proxy': '音轨下载仅支持显式网页代理；不降级直连。',
    'invalid_cookie_file': '本地凭据文件无效或不可读。',
    'output_not_empty': '音轨目录须是调用方新建的空目录。',
    'output_exists': '音轨文件已存在；未覆盖。',
    'local_error': '本地音轨文件操作失败。',
    'dependency_missing': '缺少音轨元数据提取依赖；不会自动安装。',
    'metadata_invalid': '平台元数据不完整或视频身份不匹配。',
    'page_conflict': '链接分集与显式分集参数冲突。',
    'page_not_found': '平台未返回指定分集。',
    'duration_limit': '音轨时长缺失、无效或超过限制。',
    'video_identity_mismatch': '音轨响应与指定分集不符，已停止。',
    'identity_unverified': '无法证明音轨属于指定分集，已停止。',
    'audio_unavailable': '未找到受支持的独立音轨；不回退下载视频。',
    'audio_format_unavailable': '未找到指定编号的安全直连音轨。',
    'audio_language_unavailable': '音轨语言不匹配；请指定音轨编号。',
    'audio_track_ambiguous': '音轨语言或身份不唯一；请指定语言或编号。',
    'unapproved_media_host': '音轨地址不符合安全域名或加密要求。',
    'redirect_rejected': '平台返回重定向，已停止，未转发凭据。',
    'login_required': '平台要求登录或验证；仅用明确授权的本地凭据。',
    'platform_restricted': '平台拒绝访问或要求风控验证。',
    'rate_limited': '平台请求被限流。',
    'platform_error': '平台音轨请求失败。',
    'network_error': '音轨网络或加密连接失败。',
    'timeout': '音轨处理超过累计时限。',
    'size_limit': '音轨或响应超过允许大小。',
    'invalid_response': '平台返回的音轨或响应内容无效。',
    'extraction_error': '音轨元数据提取失败。',
}


def _fail(code):
    raise AudioSourceError(code, _MESSAGES[code]) from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _fail('redirect_rejected')


class _QuietLogger:
    def debug(self, *args, **kwargs): pass
    def warning(self, *args, **kwargs): pass
    def error(self, *args, **kwargs): pass


class _Budget:
    def __init__(self, timeout):
        self.end = time.monotonic() + timeout

    def remaining(self):
        left = self.end - time.monotonic()
        if left <= 0:
            _fail('timeout')
        return left


def _positive(value, code='duration_limit'):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        _fail(code)
    return value


def _duration(value, maximum):
    value = _positive(value)
    if value > maximum:
        _fail('duration_limit')
    return value


def _proxy(value):
    if value is None:
        return None
    if not isinstance(value, str) or any(ord(c) <= 32 for c in value):
        _fail('invalid_proxy')
    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https'):
        _fail('unsupported_proxy')
    try:
        valid = (parsed.hostname and parsed.port and not parsed.username and not parsed.password
                 and parsed.path in ('', '/') and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        _fail('invalid_proxy')
    return value


def _youtube_target(raw):
    # Reuse the caption tool's target parsing; only the error code differs.
    from ytstudy import StudyError, normalize_target
    try:
        return normalize_target(raw)
    except StudyError:
        _fail('invalid_target')


def _target(raw, page):
    if not isinstance(raw, str) or len(raw) > 4096:
        _fail('invalid_target')
    raw = raw.strip()
    if page is not None and (type(page) is not int or page < 1):
        _fail('invalid_input')
    if re.fullmatch(r'BV[A-Za-z0-9]{10}', raw):
        bvid, selected = raw, page or 1
    else:
        parsed = urlparse(raw if '://' in raw else 'https://' + raw)
        if parsed.hostname in ('bilibili.com', 'www.bilibili.com'):
            if parsed.scheme not in ('https', 'http') or parsed.username or parsed.password:
                _fail('invalid_target')
            match = re.fullmatch(r'/video/(BV[A-Za-z0-9]{10})/?', parsed.path)
            if not match:
                _fail('invalid_target')
            bvid = match[1]
            params = parse_qs(parsed.query, keep_blank_values=True)
            values = params.get('p')
            if values is not None:
                if len(values) != 1 or not re.fullmatch(r'[1-9][0-9]*', values[0]):
                    _fail('invalid_target')
                selected = int(values[0])
                if page is not None and selected != page:
                    _fail('page_conflict')
            else:
                selected = page or 1
        else:
            if page is not None:
                _fail('invalid_input')
            url, vid = _youtube_target(raw)
            return 'youtube', url, vid, None
    return 'bilibili', f'https://www.bilibili.com/video/{bvid}/?p={selected}', bvid, selected


def _media_url(url, platform):
    if not isinstance(url, str) or '\\' in url or any(ord(c) < 33 or ord(c) == 127 for c in url):
        _fail('unapproved_media_host')
    parsed = urlparse(url)
    roots = ('googlevideo.com',) if platform == 'youtube' else ('bilivideo.com', 'bilivideo.cn', 'hdslb.com')
    host = (parsed.hostname or '').lower()
    try:
        valid = (parsed.scheme == 'https' and not parsed.username and not parsed.password
                 and parsed.port in (None, 443) and not parsed.fragment
                 and any(host == root or host.endswith('.' + root) for root in roots))
    except ValueError:
        valid = False
    if not valid:
        _fail('unapproved_media_host')
    return url


def _format_label(value):
    # Only numeric IDs plus known yt-dlp disambiguation suffixes reach output.
    if type(value) is int:
        value = str(value)
    return value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,10}(?:-(?:[0-9]{1,5}|drc|sr)){0,3}', value) else None


def _track_fail(code, formats):
    candidates = []
    for fmt in formats:
        label = _format_label(fmt.get('format_id'))
        if label is not None:
            candidate = label + '/' + _language(fmt.get('language'))
            if candidate not in candidates:
                candidates.append(candidate)
        if len(candidates) >= 20:
            break
    message = _MESSAGES[code]
    if candidates:
        message += ' 可选音轨：' + '，'.join(candidates) + '。'
    raise AudioSourceError(code, message) from None


def _language(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*', value):
        return 'unknown'
    language = value.replace('_', '-').lower()
    return 'unknown' if language in ('und', 'mul', 'zxx', 'none', 'unknown') else language


def _ambiguous(formats):
    identities = {(_language(f.get('language')), str(f.get('audio_track_id', ''))) for f in formats}
    return len(identities) > 1


def _real_codec(value):
    return isinstance(value, str) and bool(re.fullmatch(
        r'(?:mp4a(?:\.[A-Za-z0-9]+)*|aac|opus|vorbis|flac|alac|mp3|mp2|pcm_[A-Za-z0-9_]+)', value.lower()))


def _choose(formats, platform, language, format_id):
    valid = []
    for fmt in formats:
        if not isinstance(fmt, dict) or fmt.get('vcodec') != 'none' or not _real_codec(fmt.get('acodec')):
            continue
        if (fmt.get('protocol') not in (None, 'https') or fmt.get('fragments')
                or fmt.get('manifest_url') or fmt.get('has_drm')
                or fmt.get('ext') not in ('m4a', 'mp4', 'webm', 'opus', 'ogg', 'mp3', 'flac', 'wav', 'aac')):
            continue
        if not _format_label(fmt.get('format_id')):
            continue
        try:
            _media_url(fmt.get('url'), platform)
        except AudioSourceError:
            continue
        if re.search(r'\.(?:m3u8|mpd)(?:$|[?])', urlparse(fmt['url']).path, re.I):
            continue
        valid.append(fmt)
    available = list(valid)
    if format_id is not None:
        valid = [fmt for fmt in valid if str(fmt['format_id']) == format_id]
        if not valid:
            _track_fail('audio_format_unavailable', available)
        # A non-unique identifier does not identify one language/track.
        if _ambiguous(valid):
            _track_fail('audio_track_ambiguous', available)
    elif language is not None:
        want = _language(language)
        matching = [f for f in valid if _language(f.get('language')) == want
                    or _language(f.get('language')).startswith(want + '-')]
        if matching:
            exact = [f for f in matching if _language(f.get('language')) == want]
            valid = exact or matching
            # en does not silently choose between en-US and en-GB.
            if len({_language(f.get('language')) for f in valid}) > 1:
                _track_fail('audio_track_ambiguous', available)
        elif len(valid) == 1 and _language(valid[0].get('language')) == 'unknown':
            pass  # Unique unlabelled audio stays unknown; never invent a language.
        else:
            _track_fail('audio_language_unavailable', available)
    if not valid:
        _fail('audio_unavailable')
    if _ambiguous(valid):
        _track_fail('audio_track_ambiguous', available)
    def quality(fmt):
        rate = fmt.get('abr') or fmt.get('tbr') or 0
        return rate if isinstance(rate, (int, float)) and math.isfinite(rate) else 0
    return max(valid, key=quality)


def _classify(error):
    # Inspect only in memory, never put third-party exception text into output.
    text = str(error).lower()
    if any(x in text for x in ('429', 'too many requests', 'rate limit')):
        return 'rate_limited'
    if any(x in text for x in ('sign in', 'login', 'log in', 'confirm your age', 'private video')):
        return 'login_required'
    if any(x in text for x in ('403', '401', 'forbidden', 'bot', 'challenge', 'po token')):
        return 'platform_restricted'
    if any(x in text for x in ('timeout', 'timed out')):
        return 'timeout'
    if isinstance(error, (URLError, OSError)):
        return 'network_error'
    return 'extraction_error'


def _youtube(url, vid, proxy, cookies, budget, directory):
    try:
        import yt_dlp
    except ImportError:
        _fail('dependency_missing')
    # The temporary copy is ours; yt-dlp may rewrite it on close, never the caller's file.
    with tempfile.TemporaryDirectory(prefix='.audio-cookie-', dir=directory) as temporary:
        cookie_copy = None
        if cookies is not None:
            try:
                original = Path(cookies)
                if not original.is_file() or original.stat().st_size > 2 * 1024 * 1024:
                    _fail('invalid_cookie_file')
                cookie_copy = Path(temporary) / 'cookies.txt'
                cookie_copy.write_bytes(original.read_bytes())
                jar = http.cookiejar.MozillaCookieJar(str(cookie_copy))
                # Cookie parsing may echo the failing credential line; suppress it.
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    jar.load(ignore_discard=True, ignore_expires=True)
            except (OSError, ValueError, http.cookiejar.LoadError):
                _fail('invalid_cookie_file')
        options = dict(skip_download=True, noplaylist=True, quiet=True, no_warnings=True,
                       logger=_QuietLogger(), proxy=proxy or '', cookiefile=str(cookie_copy) if cookie_copy else None,
                       cookiesfrombrowser=None, usenetrc=False, cachedir=False, js_runtimes={},
                       remote_components=[], retries=0, extractor_retries=0, fragment_retries=0,
                       file_access_retries=0, socket_timeout=min(30, budget.remaining()),
                       ignoreerrors=False, ignore_no_formats_error=False, enable_file_urls=False,
                       paths={'home': temporary, 'temp': temporary},
                       outtmpl=str(Path(temporary) / '%(id)s.%(ext)s'))
        with yt_dlp.YoutubeDL(options) as session:
            # Bound each request by the remaining shared budget.
            original_open = session.urlopen
            def bounded_open(request):
                remaining = budget.remaining()
                if hasattr(request, 'extensions'):
                    request.extensions['timeout'] = min(30, remaining)
                session.params['socket_timeout'] = min(30, remaining)
                result = original_open(request)
                budget.remaining()
                return result
            session.urlopen = bounded_open
            try:
                meta = session.extract_info(url, download=False)
            except AudioSourceError:
                raise
            except Exception as error:
                budget.remaining()
                _fail(_classify(error))
            budget.remaining()
        if not isinstance(meta, dict) or meta.get('id') != vid or meta.get('_type') in ('playlist', 'multi_video'):
            _fail('metadata_invalid')
        if meta.get('is_live') or meta.get('live_status') in ('is_live', 'is_upcoming'):
            _fail('audio_unavailable')
        return meta


def _http_error(error):
    code = error.code
    _fail('redirect_rejected' if 300 <= code < 400 else 'rate_limited' if code == 429
          else 'login_required' if code == 401 else 'platform_restricted' if code in (403, 412)
          else 'platform_error')


def _read_stream(response, budget, maximum, sink=None):
    headers = response.headers
    content_length = headers.get('Content-Length')
    expected = None
    if content_length is not None:
        try:
            expected = int(content_length)
        except (ValueError, TypeError):
            _fail('invalid_response')
        if expected < 0:
            _fail('invalid_response')
        if expected > maximum:
            _fail('size_limit')
    if headers.get('Content-Encoding', 'identity').lower() not in ('identity', ''):
        _fail('invalid_response')
    total, chunks, digest = 0, [], hashlib.sha256()
    read = getattr(response, 'read1', response.read)
    while True:
        remaining = budget.remaining()
        # urllib sockets retain the timeout from open(); shrink it as the total
        # budget expires. read1 avoids waiting for a full buffer on a slow stream.
        sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
        if sock is not None:
            sock.settimeout(min(30, remaining))
        chunk = read(min(65536, maximum - total + 1))
        budget.remaining()
        if not chunk:
            break
        total += len(chunk)
        if total > maximum:
            _fail('size_limit')
        digest.update(chunk)
        if sink is None:
            chunks.append(chunk)
        else:
            sink.write(chunk)
    if total == 0 or (expected is not None and total != expected):
        _fail('invalid_response')
    return (b''.join(chunks) if sink is None else None), total, digest.hexdigest()


def _api(opener, path, params, secret, budget):
    headers = {'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', 'Referer': 'https://www.bilibili.com/'}
    if secret:
        headers['Cookie'] = 'SESSDATA=' + secret
    # Only this fixed API origin receives the explicitly authorized SESSDATA.
    request = Request('https://api.bilibili.com' + path + '?' + urlencode(params), headers=headers, method='GET')
    try:
        with opener.open(request, timeout=min(30, budget.remaining())) as response:
            raw, _, _ = _read_stream(response, budget, 4 * 1024 * 1024)
    except HTTPError as error:
        _http_error(error)
    except (URLError, TimeoutError, OSError) as error:
        _fail(_classify(error))
    try:
        payload = json.loads(raw.decode('utf-8-sig'))
    except (UnicodeError, ValueError):
        _fail('invalid_response')
    if not isinstance(payload, dict):
        _fail('invalid_response')
    if payload.get('code') != 0:
        code = payload.get('code')
        _fail('login_required' if code in (-101, -400) else 'rate_limited' if code in (-412, -509)
              else 'platform_restricted' if code in (-403, 401, 352) else 'platform_error')
    data = payload.get('data')
    if not isinstance(data, dict):
        _fail('invalid_response')
    return data


def _bilibili(opener, bvid, page, cookie_file, budget, maximum, language, format_id,
              bili_sessdata=None):
    secret = bili_sessdata
    if cookie_file is not None:
        try:
            from bilibili_subtitles import session_value
            secret = session_value(cookie_file)
        except Exception:
            _fail('invalid_cookie_file')
    view = _api(opener, '/x/web-interface/view', {'bvid': bvid}, secret, budget)
    if view.get('bvid') != bvid or type(view.get('aid')) is not int or view['aid'] <= 0:
        _fail('metadata_invalid')
    pages = [item for item in view.get('pages', []) if isinstance(item, dict) and item.get('page') == page]
    if len(pages) != 1:
        _fail('page_not_found')
    part = pages[0]
    cid = part.get('cid')
    if type(cid) is not int or cid <= 0:
        _fail('metadata_invalid')
    duration = _duration(part.get('duration'), maximum)
    play = _api(opener, '/x/player/playurl', {'avid': view['aid'], 'cid': cid, 'fnval': 16, 'fnver': 0}, secret, budget)
    if 'cid' in play and play['cid'] != cid:
        _fail('video_identity_mismatch')
    if 'aid' in play and play['aid'] != view['aid'] or 'bvid' in play and play['bvid'] != bvid:
        _fail('video_identity_mismatch')
    playback_duration = _positive(play.get('timelength')) / 1000
    if abs(playback_duration - duration) > 3:
        _fail('video_identity_mismatch')
    _duration(playback_duration, maximum)
    dash = play.get('dash')
    if not isinstance(dash, dict):
        _fail('audio_unavailable')
    formats = []
    for audio in dash.get('audio') or []:
        if not isinstance(audio, dict):
            continue
        mime = audio.get('mimeType') or audio.get('mime_type')
        if mime not in ('audio/mp4', 'audio/webm', 'audio/ogg', 'audio/flac'):
            continue
        formats.append(dict(url=audio.get('baseUrl') or audio.get('base_url'),
                            format_id=str(audio.get('id', '')), acodec=audio.get('codecs'), vcodec='none',
                            ext={'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac'}[mime],
                            language=audio.get('language') or audio.get('lang'),
                            audio_track_id=audio.get('audio_track_id', ''), tbr=audio.get('bandwidth')))
    chosen = _choose(formats, 'bilibili', language, format_id)
    verification = 'api_cid' if 'cid' in play else 'audio_url_path_and_duration'
    if 'cid' not in play:
        # Without a proven cid, require the full numeric cid as a CDN path segment
        # or DASH filename prefix; never a query value or substring (123 != 1234).
        path = urlparse(chosen['url']).path
        # Encoded separators/dot segments could hide identity; reject them.
        if '%' in path or any(segment in ('.', '..') for segment in path.split('/')):
            _fail('identity_unverified')
        if not re.search(r'(?:^|/)' + re.escape(str(cid)) + r'(?:/|-[0-9]+-[0-9]+\.m4s$|\.m4s$)', path):
            _fail('identity_unverified')
    metadata = dict(platform='bilibili', id=bvid, bvid=bvid, page=page, cid=cid,
                    title=view.get('title') if isinstance(view.get('title'), str) else None,
                    part=part.get('part') if isinstance(part.get('part'), str) else None,
                    duration_seconds=duration, identity_verification=verification)
    from bilibili_subtitles import redact_session
    return chosen, redact_session(metadata, secret)


def download_audio(target, directory, *, page=None, proxy=None, cookies=None,
                   bili_cookie_file=None, bili_sessdata=None, max_bytes=512 * 1024 * 1024,
                   max_duration=14400, timeout=300, audio_language=None, audio_format=None):
    """Return (owned Path, whitelisted metadata); never download video or overwrite.

    directory must be a new empty non-symlink directory. Only this call's file is
    removed on failure. Format IDs take priority over language requests; unique
    unlabelled audio is marked unknown. All requests share a monotonic deadline.
    """
    owned, owned_identity, succeeded = None, None, False
    try:
        if type(max_bytes) is not int or max_bytes <= 0:
            _fail('invalid_input')
        _positive(max_duration, 'invalid_input')
        _positive(timeout, 'invalid_input')
        if audio_language is not None and _language(audio_language) == 'unknown':
            _fail('invalid_input')
        if audio_format is not None and (not isinstance(audio_format, str) or not _format_label(audio_format)):
            _fail('invalid_input')
        folder = Path(directory)
        if (folder.is_symlink() or getattr(folder, 'is_junction', lambda: False)()
                or not folder.is_dir() or any(folder.iterdir())):
            _fail('output_not_empty')
        folder = folder.resolve()
        proxy = _proxy(proxy)
        platform, source_url, vid, page = _target(target, page)
        if (platform == 'youtube' and (bili_cookie_file is not None or bili_sessdata is not None)
                or platform == 'bilibili' and cookies is not None
                or bili_sessdata is not None and bili_cookie_file is not None):
            _fail('invalid_input')
        if bili_sessdata is not None:
            from bilibili_subtitles import SafeFailure, validate_session
            try:
                bili_sessdata = validate_session(bili_sessdata)
            except SafeFailure:
                _fail('invalid_input')
        budget = _Budget(timeout)
        opener = build_opener(ProxyHandler({'http': proxy, 'https': proxy} if proxy else {}), NoRedirect())
        if platform == 'youtube':
            meta = _youtube(source_url, vid, proxy, cookies, budget, folder)
            duration = _duration(meta.get('duration'), max_duration)
            chosen = _choose(meta.get('formats') or [], platform, audio_language, audio_format)
            metadata = dict(platform=platform, id=vid, title=meta.get('title') if isinstance(meta.get('title'), str) else None,
                            duration_seconds=duration, identity_verification='extractor_video_id')
        else:
            chosen, metadata = _bilibili(opener, vid, page, bili_cookie_file, budget, max_duration,
                                         audio_language, audio_format, bili_sessdata=bili_sessdata)
        url = _media_url(chosen['url'], platform)
        lang = _language(chosen.get('language'))
        warnings = []
        if lang == 'unknown':
            warnings.append('平台未提供音轨语言标签；未知不等于原始音轨。')
        if lang == 'unknown' and audio_language is not None and audio_format is None:
            warnings.append('仅有未标注语言的音轨，无法证明满足请求语言。')
        metadata.update(source_url=source_url, audio_format_id=str(chosen['format_id']), audio_language=lang,
                        audio_track_note='语言标签未知，未验证是否原始音轨。' if lang == 'unknown' else '平台音轨语言标签，未验证是否原始音轨。',
                        warnings=warnings)
        extension = 'm4a' if chosen['ext'] == 'mp4' else chosen['ext']
        path = folder / ('audio.' + extension)
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity'}
        if platform == 'bilibili':
            headers['Referer'] = 'https://www.bilibili.com/'
        # No extractor-supplied headers, Cookie or Authorization.
        req = Request(url, headers=headers, method='GET')
        try:
            with opener.open(req, timeout=min(30, budget.remaining())) as response:
                if getattr(response, 'status', 200) != 200 or response.headers.get('Content-Range'):
                    _fail('invalid_response')
                mime = response.headers.get('Content-Type', '').lower().split(';')[0].strip()
                if mime and not (mime.startswith(('audio/', 'video/')) or mime == 'application/octet-stream'):
                    _fail('invalid_response')
                try:
                    sink = path.open('xb')
                except FileExistsError:
                    _fail('output_exists')
                owned = path
                st = path.stat()
                owned_identity = (st.st_dev, st.st_ino)
                with sink:
                    _, size, digest = _read_stream(response, budget, max_bytes, sink)
        except HTTPError as error:
            _http_error(error)
        except (URLError, TimeoutError) as error:
            _fail(_classify(error))
        budget.remaining()
        metadata.update(audio_sha256=digest, audio_bytes=size)
        succeeded = True
        return path, metadata
    except AudioSourceError:
        raise
    except OSError:
        _fail('local_error')
    except Exception:
        _fail('extraction_error')
    finally:
        # Unlink only the exact inode we created, never an existing file or the caller dir.
        if owned is not None and not succeeded:
            try:
                st = owned.stat(follow_symlinks=False)
                if not owned.is_symlink() and (st.st_dev, st.st_ino) == owned_identity:
                    owned.unlink()
            except OSError:
                pass
