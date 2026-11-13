"""Downscaled previews for grid cards.

A library card is about 200 px wide, while the media behind it can be several
megabytes. Rendering a preview with the FFmpeg that media probing already needs
keeps a grid of cards from downloading originals.
"""
import subprocess
import tempfile
from collections import OrderedDict
from io import BytesIO
from pathlib import Path

from PIL import Image

from opendirector.domain.projects import ProjectError
from opendirector.media import heif_type
from opendirector.media.processing import open_image

WIDTH = 480
_CAPACITY = 256
_CACHE: "OrderedDict[str, bytes]" = OrderedDict()


def preview(key: str, data: bytes, kind: str) -> bytes | None:
    """A JPEG preview for image or video bytes, or None when FFmpeg cannot render one.

    The key identifies immutable content (node, revision and slot), so a cached
    entry never needs invalidating.
    """
    if kind not in {'image', 'video'}:
        return None
    cached = lookup(key)
    if cached is not None:
        return cached
    rendered = _render(data, kind)
    if rendered:
        remember(key, rendered)
    return rendered


def lookup(key: str) -> bytes | None:
    """An already rendered preview, so callers can skip reading the original."""
    cached = _CACHE.get(key)
    if cached is not None:
        _CACHE.move_to_end(key)
    return cached


def remember(key: str, rendered: bytes) -> None:
    _CACHE[key] = rendered
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CAPACITY:
        _CACHE.popitem(last=False)


def _render(data: bytes, kind: str) -> bytes | None:
    if kind == 'image' and heif_type(data):
        try:
            image = open_image(data)
            image.thumbnail((WIDTH, WIDTH))
            output = BytesIO()
            background = Image.new('RGB', image.size, 'white')
            background.paste(image, mask=image.getchannel('A'))
            background.save(output, 'JPEG', quality=80, icc_profile=image.info.get('icc_profile'))
            return output.getvalue()
        except ProjectError:
            return None
    with tempfile.TemporaryDirectory(prefix='opendirector-preview-') as folder:
        source = Path(folder) / 'source'
        source.write_bytes(data)
        target = Path(folder) / 'preview.jpg'
        command = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
        if kind == 'video':
            # Seeking before the input keeps this fast; a first frame is often black.
            command += ['-ss', '0.3']
        command += ['-i', str(source), '-vf', f'scale={WIDTH}:-2', '-frames:v', '1',
                    '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', str(target)]
        try:
            subprocess.run(command, capture_output=True, timeout=60, check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        return target.read_bytes() if target.is_file() else None
