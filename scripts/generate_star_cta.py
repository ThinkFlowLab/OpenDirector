#!/usr/bin/env python3
"""Render the README's original, stylized GitHub star demonstration.

Optional authoring dependency only: python3 -m pip install Pillow==13.0.0
Run from any directory: python3 scripts/generate_star_cta.py
Requires DejaVu Sans (Debian/Ubuntu: fonts-dejavu-core). For another install,
pass --font-dir containing DejaVuSans.ttf and DejaVuSans-Bold.ttf.
Outputs: docs/guides/assets/star-opendirector.{gif,png}; 960x560, 5.6 s, infinite loop.
No network calls, screenshots, adoption counters, or GitHub mutations.
"""

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
W, H, SCALE = 960, 560, 2


def render(font_dir: Path, output: Path) -> None:
    fonts = {}

    def font(size, bold=False):
        key = (size, bold)
        if key not in fonts:
            name = 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf'
            fonts[key] = ImageFont.truetype(str(font_dir / name), size * SCALE)
        return fonts[key]

    background = Image.new('RGB', (W, H))
    pixels = background.load()
    for y in range(H):
        for x in range(W):
            glow = max(0, 1 - math.hypot(x / W, y / H) / 1.2)
            blue = max(0, 1 - math.hypot((x - W) / W, (y - H) / H))
            pixels[x, y] = (int(11 + 10 * glow + 10 * blue),
                            int(24 + 53 * glow + 10 * blue),
                            int(54 + 61 * glow + 44 * blue))
    background = background.resize((W * SCALE, H * SCALE))

    def frame(t):
        im = background.copy()
        d = ImageDraw.Draw(im)

        def box(bounds, fill, outline=None, radius=8, width=1):
            d.rounded_rectangle(tuple(round(v * SCALE) for v in bounds),
                                radius * SCALE, fill, outline, width * SCALE)

        def text(x, y, value, size=16, color='#dbe7f5', bold=False):
            d.text((x * SCALE, y * SCALE), value, font=font(size, bold), fill=color)

        def line(points, fill, width=1):
            d.line([(round(x * SCALE), round(y * SCALE)) for x, y in points],
                   fill, width * SCALE)

        def star(x, y, radius, fill, outline=None):
            points = []
            for i in range(10):
                angle = -math.pi / 2 + i * math.pi / 5
                r = radius if i % 2 == 0 else radius * .46
                points.append(((x + math.cos(angle) * r) * SCALE,
                               (y + math.sin(angle) * r) * SCALE))
            d.polygon(points, fill=fill, outline=outline, width=SCALE)

        text(46, 26, 'A little star. A big encouragement.', 27, bold=True)
        text(47, 65, 'OpenDirector on GitHub', 15, '#a7c8ef')
        box((37, 110, 923, 511), '#08152c', radius=18)
        box((32, 100, 928, 500), '#0d1117', '#35577e', 16)
        box((33, 101, 927, 145), '#161d29', radius=15)
        for x, c in [(55, '#f27b82'), (73, '#e8bf6a'), (91, '#66b99c')]:
            d.ellipse(((x-4)*SCALE, 119*SCALE, (x+4)*SCALE, 127*SCALE), fill=c)
        text(126, 113, 'github.com/ThinkFlowLab/OpenDirector', 14, '#9eafc4')
        text(57, 166, 'ThinkFlowLab /', 19, '#8cbbff')
        text(218, 165, 'OpenDirector', 20, '#8cbbff', True)
        box((387, 169, 443, 192), '#0d1117', '#39434e', 12)
        text(399, 172, 'Public', 11, '#9da9b8')
        active = 2.25 <= t < 4.85
        box((742, 159, 899, 202), '#273241' if active else '#202833',
            '#a18c4b' if active else '#465364', 8)
        star(767, 180, 10, '#eac45c' if active else None, '#eac45c' if active else '#b7c3d2')
        text(788, 168, 'Starred' if active else 'Star', 17, '#f0e2b4' if active else '#edf3fa', True)
        text(58, 220, '< >  Code', 14, bold=True)
        text(180, 220, 'Issues', 14, '#9eafc4')
        text(265, 220, 'Pull requests', 14, '#9eafc4')
        line([(33, 253), (927, 253)], '#303946')
        line([(54, 252), (143, 252)], '#72a8ff', 3)
        box((56, 274, 615, 470), '#101722', '#303d4e', 9)
        text(76, 288, 'README.md', 12, '#92a4bb')
        text(76, 319, 'OpenDirector', 32, '#f0f5fc', True)
        text(77, 370, 'From an idea to a short film.', 18, '#bacce0')
        for x, label, width in [(78, 'Chat', 70), (159, 'Canvas', 91), (261, 'Timeline', 106)]:
            box((x, 414, x+width, 444), '#1a304d', radius=15)
            text(x+15, 420, label, 12, '#a9ceff')
        text(647, 285, 'About', 15, bold=True)
        text(647, 321, 'AI video creation', 16, '#bacce0')
        text(647, 347, 'in a local workspace.', 16, '#bacce0')
        text(647, 402, 'ThinkFlowLab', 14, '#86b9ff')
        text(647, 431, 'Open source', 13, '#91a4bd')
        text(46, 520, 'Support the project. Help others discover it.', 14, '#b8d0ee')
        # One deliberate click, then a quiet hold. Fade the pointer before
        # resetting the illustrated state, so the loop never depicts un-starring.
        if .8 <= t < 4.4:
            p = min(1, (t-.8)/1.3)
            p = 1-(1-p)**3
            x, y = 664+163*p, 382-197*p
            alpha = min(1, (t-.8)/.25, (4.4-t)/.35)
            overlay = Image.new('RGBA', im.size)
            od = ImageDraw.Draw(overlay)
            if 2.25 <= t < 2.95:
                q = (t-2.25)/.7
                r = 15+34*q
                od.ellipse(((x-r)*SCALE,(y-r)*SCALE,(x+r)*SCALE,(y+r)*SCALE),
                           outline=(242,205,105,int(230*(1-q))), width=2*SCALE)
            points = [(0,0),(2,29),(9,22),(16,35),(22,32),(15,19),(26,18)]
            od.polygon([((x+a)*SCALE,(y+b)*SCALE) for a,b in points],
                       fill=(248,251,255,int(255*alpha)),
                       outline=(7,15,28,int(255*alpha)), width=2*SCALE)
            im = Image.alpha_composite(im.convert('RGBA'), overlay).convert('RGB')
        return im.resize((W,H), Image.Resampling.LANCZOS)

    output.mkdir(parents=True, exist_ok=True)
    first = frame(0)
    first.save(output / 'star-opendirector.png', optimize=True)
    # Shared palette prevents background shimmer. 80 ms frames = 12.5 fps.
    palette = Image.new('RGB', (W, H*2))
    palette.paste(first)
    palette.paste(frame(2.56), (0,H))
    palette = palette.quantize(colors=125)
    colors = palette.getpalette()
    colors[375:384] = [234, 196, 92, 242, 205, 105, 240, 226, 180]
    palette.putpalette(colors)
    frames = [frame(i*.08).quantize(palette=palette, dither=Image.Dither.NONE)
              for i in range(70)]
    frames[0].save(output / 'star-opendirector.gif', save_all=True,
                   append_images=frames[1:], duration=80, loop=0,
                   optimize=True, disposal=1)
    print(f'Generated {output / "star-opendirector.gif"}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-dir', type=Path,
                        default=Path('/usr/share/fonts/truetype/dejavu'))
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'docs/guides/assets')
    args = parser.parse_args()
    render(args.font_dir, args.output_dir)
