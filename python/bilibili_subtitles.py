"""Read published Bilibili subtitles only; no video/audio/ASR/browser access.
Credentials come from an explicit file or a backend-only in-memory override and are never accepted via CLI/environment, echoed or cached.
"""
import argparse
import datetime as dt
import hashlib
import html
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class SafeFailure(Exception):
    def __init__(self, status, phase, **details):
        self.payload = dict(status=status, phase=phase, **details)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SafeFailure('redirect_requires_review', 'request', http_status=code)


def _valid_session(value):
    return isinstance(value, str) and 0 < len(value) <= 16000 and all(33 <= ord(c) <= 126 and c != ';' for c in value)


def validate_session(value):
    """Pure private-session validation: no I/O, coercion or diagnostics."""
    if not _valid_session(value):
        raise SafeFailure('invalid_session', 'credentials') from None
    return value


def redact_session(value, secret):
    """Remove only a known private value."""
    if isinstance(value, str):
        return value.replace(secret, '[redacted]') if secret else value
    if isinstance(value, dict):
        return {redact_session(k, secret): redact_session(v, secret) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_session(v, secret) for v in value]
    return value


def session_value(path):
    try:
        # Tolerate tab/newline at JSON edges; reject internal whitespace/control chars.
        obj = json.loads(Path(path).read_text(encoding='utf-8-sig'), strict=False)
        if isinstance(obj, dict) and isinstance(obj.get('SESSDATA'), str):
            value = obj['SESSDATA']
        elif isinstance(obj, list):
            candidates = [x['value'] for x in obj if isinstance(x, dict) and x.get('name') == 'SESSDATA' and isinstance(x.get('value'), str) and str(x.get('domain', '')).lstrip('.') in ('bilibili.com', 'www.bilibili.com', 'api.bilibili.com')]
            if len(candidates) != 1:
                raise ValueError()
            value = candidates[0]
        else:
            raise ValueError()
        value = value.strip()
        if not _valid_session(value):
            raise ValueError()
        return value
    except (OSError, ValueError, KeyError, TypeError):
        raise SafeFailure('invalid_cookie_file', 'credentials')


def stamp(seconds):
    millis = round(float(seconds) * 1000)
    hours, rem = divmod(millis, 3600000)
    minutes, rem = divmod(rem, 60000)
    secs, ms = divmod(rem, 1000)
    return f'{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}'


def main(session_override=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--bvid', required=True)
    ap.add_argument('--page', type=int, required=True)
    ap.add_argument('--lang', choices=('en', 'zh', 'auto'), default='zh', help='Explicit caption language; no silent cross-language fallback.')
    ap.add_argument('--cookie-file')
    ap.add_argument('--proxy', help='Explicit proxy; omission means direct, never system proxy.')
    ap.add_argument('--out', required=True, help='New absolute directory, must not already exist.')
    args = ap.parse_args()
    if not re.fullmatch(r'BV[A-Za-z0-9]{10}', args.bvid) or args.page < 1:
        raise SafeFailure('invalid_target', 'arguments')
    out = Path(args.out)
    if not out.is_absolute() or out.exists():
        raise SafeFailure('output_must_be_new_absolute_directory', 'arguments')
    if session_override is not None and args.cookie_file:
        raise SafeFailure('credential_conflict', 'credentials') from None
    secret = (validate_session(session_override) if session_override is not None
              else session_value(args.cookie_file) if args.cookie_file else None)
    opener = build_opener(ProxyHandler({'http': args.proxy, 'https': args.proxy} if args.proxy else {}), NoRedirect())
    ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'

    def fetch(url, phase, auth=False):
        parsed = urlparse(url)
        host = parsed.hostname or ''
        approved = host == 'api.bilibili.com' if auth else (host == 'api.bilibili.com' or host.endswith('.hdslb.com') or host.endswith('.bilibili.com'))
        if parsed.scheme != 'https' or not approved or parsed.username or parsed.password:
            raise SafeFailure('unapproved_subtitle_host', phase)
        headers = {'User-Agent': ua, 'Referer': 'https://www.bilibili.com/'}
        if auth and secret:
            headers['Cookie'] = 'SESSDATA=' + secret
        req = Request(url, headers=headers, method='GET')
        try:
            with opener.open(req, timeout=35) as response:
                raw = response.read(12000001)
            if len(raw) > 12000000:
                raise SafeFailure('response_too_large', phase)
        except HTTPError as error:
            status = 'rate_limited' if error.code == 429 else 'login_or_platform_restricted' if error.code in (401, 403, 412) else 'http_error'
            raise SafeFailure(status, phase, http_status=error.code)
        except (URLError, TimeoutError, OSError):
            raise SafeFailure('network_error', phase)
        try:
            data = json.loads(raw.decode('utf-8-sig'))
        except (UnicodeError, ValueError):
            raise SafeFailure('non_json_response', phase)
        return data, raw

    def api(path, params, phase, auth=False):
        data, _ = fetch('https://api.bilibili.com' + path + '?' + urlencode(params), phase, auth)
        if data.get('code') != 0:
            code = data.get('code')
            status = 'login_required' if code in (-101, -400, -403) else 'rate_limited' if code in (-412, -509) else 'platform_error'
            raise SafeFailure(status, phase, api_code=code)
        return data['data']

    view = api('/x/web-interface/view', {'bvid': args.bvid}, 'metadata')
    pages = [p for p in view.get('pages', []) if p.get('page') == args.page]
    if len(pages) != 1:
        raise SafeFailure('page_not_found', 'metadata')
    page = pages[0]
    # Current yt-dlp Bilibili extractor uses this endpoint, not legacy /v2.
    player = api('/x/player/wbi/v2', {'aid': view['aid'], 'cid': page['cid']}, 'subtitle_listing', auth=True)
    expected_identity = {'aid': view['aid'], 'bvid': args.bvid, 'cid': page['cid'], 'page_no': args.page}
    missing = [k for k in expected_identity if k not in player]
    if missing:
        raise SafeFailure('incomplete_video_identity', 'subtitle_listing', missing_fields=missing)
    mismatches = [k for k, expected in expected_identity.items() if player[k] != expected]
    if mismatches:
        raise SafeFailure('video_identity_mismatch', 'subtitle_listing', mismatched_fields=mismatches)
    tracks = player.get('subtitle', {}).get('subtitles', [])
    login_verified = bool(player.get('login_mid'))
    need_login = bool(player.get('need_login_subtitle'))
    safe_tracks = [{k: t.get(k) for k in ('lan', 'lan_doc', 'ai_type', 'ai_status', 'is_lock') if k in t} for t in tracks]
    if not tracks:
        raise SafeFailure('login_required' if need_login else 'no_subtitle_tracks_returned', 'subtitle_listing', bvid=args.bvid, page=args.page, part=page['part'], authenticated=login_verified, need_login_subtitle=need_login, tracks=safe_tracks)
    def caption_language(track):
        language = str(track.get('lan', '')).lower()
        return language[3:] if language.startswith('ai-') else language
    def is_ai(track):
        return str(track.get('lan', '')).startswith('ai-') or track.get('ai_type', 0) != 0 or '自动' in str(track.get('lan_doc', ''))
    wanted = ('zh', 'en') if args.lang == 'auto' else (args.lang,)
    choices = []
    for language in wanted:
        choices = [t for t in tracks if caption_language(t) == language or caption_language(t).startswith(language + '-')]
        if choices:
            break
    if not choices:
        raise SafeFailure('language_unavailable', 'subtitle_listing', tracks=safe_tracks, authenticated=login_verified)
    choices.sort(key=lambda t: (is_ai(t), caption_language(t) not in ('zh-cn', 'zh-hans', 'zh', 'en')))
    track = choices[0]
    url = track.get('subtitle_url', '')
    if url.startswith('//'):
        url = 'https:' + url
    subtitle, raw = fetch(url, 'subtitle_download', auth=False)
    cues = subtitle.get('body')
    if not isinstance(cues, list) or not cues:
        raise SafeFailure('empty_or_invalid_subtitle_body', 'subtitle_parse')
    lines = []
    max_end = 0
    try:
        for cue in cues:
            start, end, content = float(cue['from']), float(cue['to']), str(cue['content'])
            if start < 0 or end < start:
                raise ValueError()
            content = html.unescape(content).replace('\r', ' ').replace('\n', ' ')
            lines.append(f'[{stamp(start)} --> {stamp(end)}] {content}')
            max_end = max(max_end, end)
    except (ValueError, TypeError, KeyError):
        raise SafeFailure('subtitle_parse_error', 'subtitle_parse')
    kind = 'auto' if is_ai(track) else 'not_marked_ai'
    metadata = dict(status='ok', platform='bilibili', bvid=args.bvid, page=args.page, cid=page['cid'], title=view.get('title'), part=page['part'], duration_seconds=page['duration'], source_url=f'https://www.bilibili.com/video/{args.bvid}/?p={args.page}', language=track.get('lan'), language_label=track.get('lan_doc'), caption_kind=kind, classification_note='not_marked_ai means not labelled AI by the platform; human authorship is not verified.', language_fallback=False, authenticated=login_verified, need_login_subtitle=need_login, available_tracks=safe_tracks, segments=len(cues), maximum_end_seconds=max_end, original_sha256=hashlib.sha256(raw).hexdigest(), warnings=[], obtained_at=dt.datetime.now(dt.timezone.utc).isoformat(), content_verified=False, content_verification_note='Download success does not verify topic or provenance; read the transcript before claiming success.', listing_endpoint='/x/player/wbi/v2', trailing_gap_seconds=max(0, page['duration'] - max_end))
    if max_end > page['duration'] + 3:
        metadata['warnings'].append('Subtitle end exceeds platform duration by over 3s; not truncated.')
    if page['duration'] - max_end > 45:
        metadata['warnings'].append('Subtitles end over 45s before video duration; verify coverage and topic.')
    metadata = redact_session(metadata, secret)
    out.mkdir(mode=0o777, parents=True, exist_ok=False)
    (out / 'original.json').write_bytes(raw)
    (out / 'transcript.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (out / 'metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(dict(status='ok', output=str(out), **{k: metadata[k] for k in ('bvid', 'page', 'part', 'duration_seconds', 'language', 'language_label', 'caption_kind', 'authenticated', 'segments', 'maximum_end_seconds', 'warnings')}), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print(json.dumps(error.payload, ensure_ascii=False))
        sys.exit(2)
    except Exception as error:
        # Never stringify exceptions: request URLs or credential contents can leak.
        print(json.dumps(dict(status='unexpected_error', error_type=type(error).__name__), ensure_ascii=False))
        sys.exit(3)
