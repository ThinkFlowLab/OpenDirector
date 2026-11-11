"""Bounded static font inspection; never resolve fonts from the host system."""
from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import BinaryIO

from fontTools.ttLib import TTFont

from opendirector.domain.projects import ProjectError
from opendirector.domain.timeline_errors import timeline_error, timeline_error_message

from opendirector.domain.rule_facts import TIMELINE_FONT_BYTES as MAX_FONT_BYTES
FONT_MIMES = frozenset({'font/ttf', 'font/otf'})
FONT_SIGNATURES = (b'\x00\x01\x00\x00', b'OTTO', b'true', b'ttcf', b'wOFF', b'wOF2')


@dataclass(frozen=True)
class FontInspection:
    mimeType: str
    family: str
    characters: frozenset[int]


_cache: OrderedDict[str, FontInspection] = OrderedDict()
_cache_lock = Lock()


def _bytes(path: Path | BinaryIO) -> bytes:
    try:
        if hasattr(path, 'read'):
            path.seek(0)
            value = path.read(MAX_FONT_BYTES + 1)
            path.seek(0)
        else:
            if path.stat().st_size > MAX_FONT_BYTES:
                raise timeline_error('timeline_font_too_large', 413)
            with path.open('rb') as stream:
                value = stream.read(MAX_FONT_BYTES + 1)
    except OSError:
        raise timeline_error('timeline_font_unavailable', 409) from None
    if len(value) > MAX_FONT_BYTES:
        raise timeline_error('timeline_font_too_large', 413)
    return value


def _inspect(value: bytes) -> FontInspection:
    if value[:4] not in {b'\x00\x01\x00\x00', b'OTTO'}:
        raise timeline_error('timeline_font_unsupported', 400)
    try:
        with TTFont(BytesIO(value), lazy=False) as font:
            if any(table in font for table in ('fvar', 'gvar', 'avar', 'CFF2')):
                raise timeline_error('timeline_font_unsupported', 400)
            required = {'head', 'hhea', 'maxp', 'name', 'OS/2', 'hmtx', 'cmap'}
            if not required.issubset(font.keys()):
                raise ValueError('Required font tables missing')
            cff = value[:4] == b'OTTO'
            if cff and 'CFF ' not in font or not cff and not {'glyf', 'loca'}.issubset(font.keys()):
                raise ValueError('Font outline format differs from signature')
            table_end = 12 + 16 * len(font.reader.tables)
            intervals = []
            for table in font.reader.tables.values():
                if table.offset < table_end or table.offset + table.length > len(value):
                    raise ValueError('Invalid font table range')
                intervals.append((table.offset, table.offset + table.length))
            intervals.sort()
            if any(start < previous_end for (_, previous_end), (start, _) in zip(intervals, intervals[1:])):
                raise ValueError('Overlapping font tables')
            font.ensureDecompiled()
            cmap = font.getBestCmap()
            family = font['name'].getBestFamilyName()
            if not cmap or not family or len(family) > 255 or font['maxp'].numGlyphs < 1:
                raise ValueError('Missing font identity or Unicode coverage')
            glyphs = set(font.getGlyphOrder()) - {'.notdef'}
            characters = frozenset(code for code, glyph in cmap.items() if glyph in glyphs and 0 <= code <= 0x10FFFF)
            if not characters:
                raise ValueError('Empty Unicode coverage')
            return FontInspection('font/otf' if cff else 'font/ttf', family, characters)
    except ProjectError:
        raise
    except Exception:
        # Third-party table parsers raise several format-specific exceptions.
        # Do not expose table contents, paths, or user text through the error.
        raise timeline_error('timeline_font_invalid', 400) from None


def _cached_inspection(value: bytes, *, fingerprint: str | None = None) -> FontInspection:
    actual = 'sha256:' + sha256(value).hexdigest()
    if fingerprint is not None and actual != fingerprint:
        raise timeline_error('timeline_font_fingerprint', 409)
    with _cache_lock:
        inspection = _cache.get(actual)
        if inspection is not None:
            _cache.move_to_end(actual)
    if inspection is None:
        inspection = _inspect(value)
        with _cache_lock:
            _cache[actual] = inspection
            _cache.move_to_end(actual)
            while len(_cache) > 16:
                _cache.popitem(last=False)
    return inspection


def inspect_font(path: Path | BinaryIO) -> FontInspection:
    return _cached_inspection(_bytes(path))


def require_font_characters(path: Path | BinaryIO, fingerprint: str, text: str) -> None:
    inspection = _cached_inspection(_bytes(path), fingerprint=fingerprint)
    if any(ord(char) not in inspection.characters for char in text if char not in '\n\t'):
        raise timeline_error('timeline_font_coverage', 400)
