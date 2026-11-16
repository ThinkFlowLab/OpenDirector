"""Local, model-free media steps that operations compose with model capabilities."""

import io
import json
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

from opendirector.domain.projects import ProjectError

MAX_PIXELS = 8192 * 8192
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


# Images ---------------------------------------------------------------------

def open_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (OSError, ValueError, EOFError, Image.DecompressionBombError):
        raise ProjectError('无法读取图片素材。', 422, code='image_decode') from None
    # A source profile for other channels cannot describe the converted RGB pixels.
    if image.mode not in {'RGB', 'RGBA', 'P', 'PA'}:
        image.info.pop('icc_profile', None)
    return ImageOps.exif_transpose(image).convert('RGBA')


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, 'PNG', optimize=False)
    return buffer.getvalue()


def rgb_png(image: Image.Image) -> bytes:
    """Model inputs: opaque RGB, transparency flattened onto white."""
    background = Image.new('RGBA', image.size, (255, 255, 255, 255))
    return png(Image.alpha_composite(background, image.convert('RGBA')).convert('RGB'))


def mask_from(data: bytes, size) -> Image.Image:
    """Editor masks are white paint on transparency; plain greyscale masks also work."""
    image = Image.open(io.BytesIO(data))
    image.load()
    mask = image.getchannel('A') if 'A' in image.getbands() else image.convert('L')
    if mask.size != tuple(size):
        mask = mask.resize(size, Image.Resampling.BILINEAR)
    if not mask.getbbox():
        raise ProjectError('选区为空，请先涂抹需要处理的区域。', 422)
    return mask


def feather(mask: Image.Image, radius: float) -> Image.Image:
    return mask.filter(ImageFilter.GaussianBlur(radius)) if radius > 0 else mask


def resize(image: Image.Image, width: int, height: int) -> Image.Image:
    if image.size == (width, height):
        return image
    return image.resize((width, height), Image.Resampling.LANCZOS)


def scale_to_long_edge(image: Image.Image, edge: int) -> Image.Image:
    ratio = edge / max(image.size)
    return resize(image, max(1, round(image.width * ratio)), max(1, round(image.height * ratio)))


def blend(base: Image.Image, overlay: Image.Image, mask: Image.Image) -> Image.Image:
    """overlay where mask is white, base elsewhere; overlay is resampled to base."""
    overlay = resize(overlay.convert('RGBA'), *base.size)
    return Image.composite(overlay, base.convert('RGBA'), mask.convert('L'))


def soften_region(image: Image.Image, mask: Image.Image) -> Image.Image:
    """Wash a region out with its surroundings so image-to-image redraws it as background."""
    blurred = image.filter(ImageFilter.GaussianBlur(max(image.size) / 24))
    return blend(image, blurred, feather(mask.point(lambda value: 255 if value > 8 else 0), max(image.size) / 80))


def extend_canvas(image: Image.Image, left: int, top: int, right: int, bottom: int):
    """A larger canvas whose new border continues the picture softly, plus a mask of that border."""
    width, height = image.width + left + right, image.height + top + bottom
    backdrop = resize(image, width, height).filter(ImageFilter.GaussianBlur(max(width, height) / 30))
    canvas = backdrop.copy()
    canvas.paste(image, (left, top), image)
    mask = Image.new('L', (width, height), 255)
    mask.paste(0, (left, top, left + image.width, top + image.height))
    return canvas, mask


def cover_box(image: Image.Image, box) -> Image.Image:
    """image scaled to fit inside box (x, y, w, h), centred, on a transparent layer the box's size."""
    x, y, width, height = box
    scale = min(width / image.width, height / image.height)
    fitted = resize(image, max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    layer.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2), fitted)
    return layer


# Video ----------------------------------------------------------------------

def _run(arguments, *, timeout=900):
    try:
        completed = subprocess.run(arguments, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise ProjectError('未找到 ffmpeg/ffprobe，请安装后重试。', 503) from None
    except subprocess.TimeoutExpired:
        raise ProjectError('本地媒体处理超时。', 504) from None
    if completed.returncode != 0:
        detail = completed.stderr.decode(errors='replace').strip().splitlines()[-1:] or ['']
        raise ProjectError(f'本地媒体处理失败：{detail[0][:200]}', 422)
    return completed.stdout


class Workspace:
    """A temporary directory for one operation's intermediate files."""

    def __enter__(self):
        self._directory = tempfile.TemporaryDirectory(prefix='opendirector-')
        self.path = Path(self._directory.name)
        return self

    def __exit__(self, *_):
        self._directory.cleanup()

    def write(self, name: str, data: bytes) -> Path:
        path = self.path / name
        path.write_bytes(data)
        return path


def video_info(path: Path) -> dict:
    value = json.loads(_run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate',
                             '-of', 'json', str(path)], timeout=60))
    streams = value.get('streams', [])
    picture = next((item for item in streams if item.get('codec_type') == 'video'), None)
    if picture is None:
        raise ProjectError('素材中没有视频画面。', 422)
    numerator, _, denominator = (picture.get('r_frame_rate') or '24/1').partition('/')
    fps = float(numerator) / float(denominator or 1) if float(denominator or 1) else 24.0
    return {'duration': float(value.get('format', {}).get('duration') or 0), 'width': int(picture['width']),
            'height': int(picture['height']), 'fps': fps or 24.0,
            'hasAudio': any(item.get('codec_type') == 'audio' for item in streams)}


def frame_at(path: Path, seconds: float, out: Path) -> bytes:
    _run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{max(seconds, 0):.3f}', '-i', str(path), '-frames:v', '1', str(out)], timeout=120)
    return out.read_bytes()


def _normalized(source: Path, out: Path, info: dict, *, start=None, end=None):
    """One segment re-encoded to the reference size, rate and stereo AAC (silence when missing)."""
    width, height, fps = info['width'] - info['width'] % 2, info['height'] - info['height'] % 2, info['fps']
    probe = video_info(source)
    window, length = [], []
    if start is not None:
        window += ['-ss', f'{start:.3f}']
    if end is not None:
        # An output-side duration is frame-exact; an input-side -to is not on ffmpeg 4.
        length += ['-t', f'{end - (start or 0):.3f}']
    picture = (f'scale={width}:{height}:force_original_aspect_ratio=decrease,'
               f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.3f},format=yuv420p')
    arguments = ['ffmpeg', '-v', 'error', '-y', *window, '-i', str(source)]
    if probe['hasAudio']:
        arguments += ['-filter_complex', f'[0:v]{picture}[v];[0:a]aresample=48000,aformat=channel_layouts=stereo[a]', '-map', '[v]', '-map', '[a]']
    else:
        arguments += ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
                      '-filter_complex', f'[0:v]{picture}[v]', '-map', '[v]', '-map', '1:a', '-shortest']
    _run([*arguments, *length, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', str(out)])


def splice(workspace: Workspace, source: Path, start: float, end: float, insert: Path) -> bytes:
    """source[:start] + insert + source[end:], all at the source's size and frame rate."""
    info = video_info(source)
    parts = []
    if start > 0.05:
        parts.append(workspace.path / 'head.mp4')
        _normalized(source, parts[-1], info, end=start)
    parts.append(workspace.path / 'middle.mp4')
    _normalized(insert, parts[-1], info)
    if info['duration'] - end > 0.05:
        parts.append(workspace.path / 'tail.mp4')
        _normalized(source, parts[-1], info, start=end)
    listing = workspace.write('parts.txt', ''.join(f"file '{part}'\n" for part in parts).encode())
    out = workspace.path / 'spliced.mp4'
    _run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(out)])
    return out.read_bytes()


def trim(source: Path, seconds: float, out: Path) -> Path:
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-t', f'{seconds:.3f}', '-c:v', 'libx264', '-preset', 'veryfast',
          '-crf', '18', '-c:a', 'aac', str(out)])
    return out


def upscale(source: Path, long_edge: int, out: Path) -> bytes:
    info = video_info(source)
    if max(info['width'], info['height']) >= long_edge:
        raise ProjectError('视频已达到或超过目标清晰度。', 422)
    scale = long_edge / max(info['width'], info['height'])
    width, height = (round(info['width'] * scale / 2) * 2, round(info['height'] * scale / 2) * 2)
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vf', f'scale={width}:{height}:flags=lanczos,unsharp=5:5:0.6',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-c:a', 'copy', '-movflags', '+faststart', str(out)], timeout=1800)
    return out.read_bytes()


def interpolate(source: Path, fps: int, out: Path) -> bytes:
    info = video_info(source)
    if info['fps'] >= fps - 0.5:
        raise ProjectError(f'视频已是 {round(info["fps"])} fps，无需补帧到 {fps} fps。', 422)
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vf', f'minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1',
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', str(out)], timeout=1800)
    return out.read_bytes()


def conform(source: Path, out: Path, *, width: int, height: int, fps: float, start=None, end=None) -> Path:
    """A window of source re-encoded to an exact canvas and rate, with stereo AAC (silence when absent)."""
    _normalized(source, out, {'width': width, 'height': height, 'fps': fps}, start=start, end=end)
    return out


@lru_cache(maxsize=1)
def _frame_sync_option() -> str:
    """Probe once per server process: FFmpeg 9 removed vsync; 4 lacks fps_mode."""
    help_text = _run(['ffmpeg', '-hide_banner', '-h', 'full'], timeout=10).decode(errors='replace')
    options = {line.split()[0].split('[', 1)[0].split(':', 1)[0]
               for line in help_text.splitlines() if line.startswith('-')}
    for option in ('-fps_mode', '-vsync'):
        if option in options:
            return option
    raise ProjectError('当前 ffmpeg 不支持保留视频帧时序，请安装完整版本并重启应用。', 503)


def picture(source: Path, out: Path, *, width: int, height: int) -> Path:
    """The silent picture resized to width x height, keeping every decoded frame and its timing."""
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vf', f'scale={width}:{height},setsar=1,format=yuv420p', '-an',
          _frame_sync_option(), 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', str(out)])
    return out


def disparity(source: Path, out: Path, *, near: float, far: float) -> bytes:
    """A depth video whose gray maps linearly from near (black) to far (white), re-mapped to inverse depth:
    near is white and far black, with detail spread over near objects. Sound is dropped."""
    near = max(near, 1e-3)
    if far <= near:
        curve = '0'
    else:
        curve = f'255*(1/({near}+val/255*({far - near}))-{1 / far})/{1 / near - 1 / far}'
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vf', f"format=gray,lut=y='{curve}',format=yuv420p", '-an',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart', str(out)])
    return out.read_bytes()


def concat(workspace: Workspace, parts: list[Path], name='joined.mp4') -> bytes:
    """Join parts that share one canvas, rate and audio layout."""
    if len(parts) == 1:
        return parts[0].read_bytes()
    listing = workspace.write(name + '.txt', ''.join(f"file '{part}'\n" for part in parts).encode())
    out = workspace.path / name
    _run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(out)])
    return out.read_bytes()


def audio_track(source: Path, out: Path, *, mode='all') -> bytes:
    """The soundtrack, or a filter-based estimate of its voice or accompaniment.

    No model runs here: `voice` keeps the centred speech band, `background`
    cancels centre-panned sound (stereo only) — useful drafts, not clean stems.
    """
    probe = video_info(source) if source.suffix in {'.mp4', '.mov', '.webm'} else None
    if probe is not None and not probe['hasAudio']:
        raise ProjectError('视频中没有音轨。', 422)
    filters = {
        'all': None,
        'voice': 'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=120,lowpass=f=7000,afftdn=nf=-25,dynaudnorm',
        'background': 'pan=stereo|c0=c0-c1|c1=c1-c0,dynaudnorm',
    }
    arguments = ['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-vn']
    if filters[mode]:
        arguments += ['-af', filters[mode]]
    _run([*arguments, '-c:a', 'libmp3lame', '-q:a', '2', str(out)])
    return out.read_bytes()


def without_audio(source: Path, out: Path) -> bytes:
    _run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-an', '-c:v', 'copy', '-movflags', '+faststart', str(out)])
    return out.read_bytes()


def is_stereo_with_side(source: Path) -> bool:
    """Whether L-R carries sound, i.e. a centre-cancelling background estimate means anything."""
    value = json.loads(_run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', str(source)], timeout=60))
    streams = value.get('streams') or []
    return bool(streams) and int(streams[0].get('channels') or 1) >= 2


# Segmentation ---------------------------------------------------------------

def rle_mask(counts, width: int, height: int) -> Image.Image:
    """A COCO uncompressed RLE (column-major, starting with background) as a mode-L mask, 255 inside."""
    data = b''.join((b'\xff' if index % 2 else b'\x00') * count for index, count in enumerate(counts))
    if len(data) != width * height:
        raise ProjectError('分割结果与视频尺寸不一致。', 502)
    # Column-major bytes fill a height-wide image whose transpose is the frame.
    return Image.frombytes('L', (height, width), data).transpose(Image.Transpose.TRANSPOSE)


MATTE_BACKGROUNDS = {'black': '0x000000', 'green': '0x00FF00'}


def matte(source: Path, masks: str, fps: float, out_stem: Path, *, background: str) -> tuple[bytes, str]:
    """Keep source pixels where the mask sequence is white; elsewhere a solid colour or transparency.

    masks is an ffmpeg image-sequence pattern with one frame per source frame.
    Transparent output is VP9 WebM with alpha; solid backgrounds are H.264 MP4.
    """
    info = video_info(source)
    width, height = info['width'], info['height']
    picture = (f'[1:v]format=gray,scale={width}:{height},setpts=PTS-STARTPTS[m];'
               '[0:v]setpts=PTS-STARTPTS[v];[v][m]alphamerge[fg];')
    arguments = ['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-framerate', f'{fps:.6f}', '-i', masks]
    if background == 'transparent':
        out = out_stem.with_suffix('.webm')
        arguments += ['-filter_complex', picture + '[fg]format=yuva420p[out]', '-map', '[out]', '-map', '0:a?',
                      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'good',
                      '-cpu-used', '4', '-row-mt', '1', '-auto-alt-ref', '0', '-c:a', 'libopus', '-b:a', '160k']
    else:
        out = out_stem.with_suffix('.mp4')
        colour = MATTE_BACKGROUNDS[background]
        arguments += ['-filter_complex', f'{picture}color=c={colour}:s={width}x{height}:r={fps:.6f}[bg];'
                                         '[bg][fg]overlay=shortest=1,format=yuv420p[out]',
                      '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                      '-c:a', 'aac', '-b:a', '192k']
    _run([*arguments, '-shortest', str(out)], timeout=3600)
    return out.read_bytes(), out.suffix[1:]
