"""Pure cloud-result validation and output formatting; no ASR engine or model access."""
from __future__ import annotations

from dataclasses import asdict, is_dataclass
import hashlib
import html
import json
import math
from pathlib import Path
import re


_MESSAGES = {
    'empty_output': '云端转写未产生非空文字。',
    'invalid_timestamp': '云端转写时间戳无效；原始结果已保留。',
    'duration_mismatch': '音轨来源时长、云端时长或段落时间范围不一致。',
    'audio_invalid': '下载模块返回的音轨路径、大小或来源数据无效。',
}


class CloudOutputError(Exception):
    def __init__(self, code):
        self.code = code
        self.message = _MESSAGES[code]
        super().__init__(self.message)


def json_data(value):
    """Preserve structured raw data; nonfinite raw values remain explicit."""
    if is_dataclass(value):
        return json_data(asdict(value))
    if hasattr(value, '_asdict'):
        return json_data(value._asdict())
    if hasattr(value, '__dict__'):
        return json_data(vars(value))
    if isinstance(value, dict):
        return {str(k): json_data(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_data(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    # Never expose arbitrary repr (URLs, credentials, addresses).
    return {'unsupported_type': type(value).__name__}


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(json_data(value), handle, ensure_ascii=False, allow_nan=False, indent=2)
        handle.write('\n')


def finite_number(value, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CloudOutputError('invalid_timestamp')
    if value < 0 or (positive and value <= 0):
        raise CloudOutputError('invalid_timestamp')
    return float(value)


def validate_segments(raw_segments, info, source, max_duration):
    duration = finite_number(info.get('duration'), positive=True)
    if duration > max_duration:
        raise CloudOutputError('duration_mismatch')
    source_duration = finite_number(source.get('duration_seconds'), positive=True)
    if abs(source_duration - duration) > max(2.0, source_duration * 0.02):
        raise CloudOutputError('duration_mismatch')
    segments, warnings = [], []
    previous_start = -1
    seen_text = set()
    for index, raw in enumerate(raw_segments):
        if not isinstance(raw, dict) or not isinstance(raw.get('text'), str):
            raise CloudOutputError('invalid_timestamp')
        start, end = finite_number(raw.get('start')), finite_number(raw.get('end'))
        if (end <= start or round(end * 1000) <= round(start * 1000)
                or start < previous_start or end > duration + 0.05):
            raise CloudOutputError('invalid_timestamp')
        if 'duration' in raw and abs(finite_number(raw['duration'], positive=True) - (end-start)) > 0.001:
            raise CloudOutputError('duration_mismatch')
        previous_start = start
        text = raw['text']  # no normalization, deletion, de-duplication or guessed repairs
        normalized = {'start': start, 'end': end, 'duration': end-start, 'text': text}
        for field in ('avg_logprob', 'no_speech_prob', 'compression_ratio'):
            value = raw.get(field)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                warnings.append(f'segment_{index}:invalid_{field}')
            normalized[field] = value
        if ((isinstance(raw.get('avg_logprob'), (int, float)) and raw['avg_logprob'] < -1)
                or (isinstance(raw.get('no_speech_prob'), (int, float)) and raw['no_speech_prob'] > 0.6)
                or (isinstance(raw.get('compression_ratio'), (int, float)) and raw['compression_ratio'] > 2.4)):
            warnings.append(f'segment_{index}:low_confidence_or_repetition_risk_preserved')
        if text.strip() in seen_text and text.strip():
            warnings.append(f'segment_{index}:repeated_text_preserved')
        seen_text.add(text.strip())
        segments.append(normalized)
    if not segments or not any(segment['text'].strip() for segment in segments):
        raise CloudOutputError('empty_output')
    if segments[0]['start'] > 15:
        warnings.append('leading_audio_without_transcribed_text')
    if duration - max(s['end'] for s in segments) > max(30, duration * 0.05):
        warnings.append('trailing_audio_without_transcribed_text_possible_early_stop')
    prior_end = 0
    for segment in segments:
        if segment['start'] - prior_end > 30:
            warnings.append('long_gap_without_transcribed_text')
        prior_end = max(prior_end, segment['end'])
    warnings.append('coverage_and_content_not_verified_no_visual_or_speaker_verification')
    return segments, duration, list(dict.fromkeys(warnings))


def safe_source(raw):
    """Whitelist metadata; rebuild public URL so tokens/signatures cannot persist."""
    if not isinstance(raw, dict):
        raise CloudOutputError('audio_invalid')
    keys = ('platform', 'id', 'title', 'duration_seconds', 'bvid', 'page', 'cid', 'part',
            'audio_format_id', 'audio_language', 'audio_track_note', 'audio_sha256', 'audio_bytes',
            'identity_verification', 'warnings')
    result = {key: raw[key] for key in keys if key in raw}
    platform = result.get('platform')
    if platform == 'youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}', str(result.get('id', ''))):
        result['source_url'] = 'https://www.youtube.com/watch?v=' + result['id']
    elif platform == 'bilibili' and re.fullmatch(r'BV[0-9A-Za-z]{10}', str(result.get('bvid', ''))):
        page = result.get('page')
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise CloudOutputError('audio_invalid')
        result['source_url'] = f'https://www.bilibili.com/video/{result["bvid"]}?p={page}'
    else:
        raise CloudOutputError('audio_invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', str(result.get('audio_sha256', ''))):
        raise CloudOutputError('audio_invalid')
    return result


def verify_audio(path, directory, source, args):
    original = Path(path)
    audio = original.resolve()
    root = Path(directory).resolve()
    if audio.parent != root or not audio.is_file() or original.is_symlink():
        raise CloudOutputError('audio_invalid')
    size = audio.stat().st_size
    if size <= 0 or size > args.max_audio_mib * 1024 * 1024 or source.get('audio_bytes') != size:
        raise CloudOutputError('audio_invalid')
    digest = hashlib.sha256()
    with audio.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != source.get('audio_sha256'):
        raise CloudOutputError('audio_invalid')
    duration = finite_number(source.get('duration_seconds'), positive=True)
    if duration > args.max_duration:
        raise CloudOutputError('duration_mismatch')
    return audio


def stamp(seconds, srt=False):
    total = round(seconds * 1000)
    hours, total = divmod(total, 3600000)
    minutes, total = divmod(total, 60000)
    secs, millis = divmod(total, 1000)
    return f'{hours:02}:{minutes:02}:{secs:02}{"," if srt else "."}{millis:03}'


def markdown_literal(text):
    # HTML/backslash escaping keeps untrusted transcript text as literal data.
    escaped = html.escape(text, quote=False)
    return re.sub(r'([\\`*_{}\[\]()#+.!|>~-])', r'\\\1', escaped).replace('\n', '  \n')
