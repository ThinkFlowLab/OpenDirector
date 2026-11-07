"""Built-in deterministic placeholder generation: the zero-key first attempt.

Never a model protocol: outputs are stylized local compositions so a first
submit succeeds without any key or network. Provenance records
protocol='placeholder' and the presentation labels results for replacement.
"""
import asyncio
import colorsys
import hashlib
from io import BytesIO

from PIL import Image, ImageDraw

from opendirector.domain.projects import ProjectError

MAX_PLACEHOLDER_EDGE = 2048
MIN_PLACEHOLDER_EDGE = 64


def _clamp_size(size, default='1024x1024'):
    raw = size if size and 'x' in size else default
    try:
        width, height = (max(MIN_PLACEHOLDER_EDGE, min(MAX_PLACEHOLDER_EDGE, int(value))) for value in raw.split('x', 1))
    except ValueError:
        width, height = map(int, default.split('x'))
    return width, height


def _palette(seed, count=3):
    # Hue walks the wheel per tone; fixed saturation/lightness keeps every
    # composition calm and readable instead of gambling on random colors.
    tones = []
    for index in range(count):
        hue = ((seed[index * 4] << 24 | seed[index * 4 + 1] << 16 | seed[index * 4 + 2] << 8 | seed[index * 4 + 3]) % 360) / 360
        tones.append(tuple(round(channel * 255) for channel in colorsys.hls_to_rgb(hue, index and .62 or .38, .45)))
    return tones


def _gradient(image, top, bottom):
    width, height = image.size
    draw = ImageDraw.Draw(image)
    for y in range(height):
        blend = y / max(1, height - 1)
        color = tuple(round(top[index] + (bottom[index] - top[index]) * blend) for index in range(3))
        draw.line([(0, y), (width, y)], fill=color)


def _orbits(draw, size, accent, ink):
    width, height = size
    center = (width * .68, height * .34)
    for radius, color in ((width * .42, ink), (width * .30, accent), (width * .18, ink)):
        draw.ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
                     outline=color, width=max(6, width // 42))


def _waves(draw, size, accent, ink):
    width, height = size
    step = max(14, height // 12)
    for index, y in enumerate(range(height // 3, height, step)):
        points = [(x, y + (6 if (x // step + index) % 2 else -6)) for x in range(0, width + step, step)]
        draw.line(points, fill=accent if index % 2 else ink, width=max(5, width // 128))


def _ridges(draw, size, accent, ink):
    width, height = size
    base = height * .58
    for layer, (peak, color) in enumerate(((height * .30, ink), (height * .18, accent))):
        offset = (layer * width * .18) % (width * .5)
        points = [(0, height), (0, base)]
        x = 0
        while x < width:
            points.append((x + offset * .2, base - peak * (.4 + ((x // 97 + layer) % 3) / 3)))
            x += width / 7
        points += [(width, base), (width, height)]
        draw.polygon(points, fill=color)


class PlaceholderGeneration:
    """Deterministic local compositions for generation kinds without a model."""

    def validate(self, kind, config):
        if kind != 'image':
            raise ProjectError('占位生成器当前仅支持图片；视频与音频占位将在后续版本提供。', 409,
                               code='placeholder_image_only')

    def prepare_inputs(self, project_id, node, config, *, complete=True):
        # Nothing to upload or freeze: references stay in the spec, the
        # composition is derived from the prompt and parameters alone.
        return {'profile': 'placeholder', 'references': []}

    async def generate(self, config, task, submitted, *, result_ready=None):
        if task['kind'] != 'image':
            self.validate(task['kind'], config)
        width, height = _clamp_size(task['parameters'].get('size'))
        data = await asyncio.to_thread(
            self._composition, task['prompt'], task['parameters'].get('size'), width, height)
        return 'png', data

    def _composition(self, prompt, size, width, height):
        seed = hashlib.sha256(f"placeholder|{prompt}|{size or ''}".encode('utf-8')).digest()
        base, accent, ink = _palette(seed)
        image = Image.new('RGB', (width, height), base)
        _gradient(image, base, accent)
        overlay = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        shape = (seed[0] + seed[1]) % 3
        ink_layer = (*ink, 150)
        accent_layer = (*accent, 190)
        if shape == 0:
            _orbits(draw, (width, height), accent_layer, ink_layer)
        elif shape == 1:
            _waves(draw, (width, height), accent_layer, ink_layer)
        else:
            _ridges(draw, (width, height), accent_layer, ink_layer)
        image = Image.alpha_composite(image.convert('RGBA'), overlay).convert('RGB')
        out = BytesIO()
        image.save(out, 'PNG')
        return out.getvalue()
