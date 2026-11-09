"""Video recipes over local media steps and video-model capabilities."""
import math

from PIL import Image, ImageChops, ImageFilter

from opendirector.application.tool_context import Output, Source, ToolContext, ToolInputError
from opendirector.domain.capabilities import EditMask, Tracks
from opendirector.domain.projects import ProjectError
from opendirector.media import processing as media
from opendirector.media.async_work import blocking


def _source_video(ctx: ToolContext) -> Source:
    if not ctx.sources or ctx.sources[0].kind != 'video':
        raise ProjectError('请提供视频素材。', 422)
    return ctx.sources[0]

async def _redraw_pieces(ctx: ToolContext, source: Source, prompt: str, picture, sound, *, window=None):
    """Redraw a clip within the model's per-request length: the whole clip in even pieces, or only
    the stretch around `window` (seconds), spliced back. Output keeps the source size and rate."""
    low, high = ctx.edit_seconds
    with media.Workspace() as work:
        path = work.write('source.mp4', source.data)
        info = await blocking(media.video_info, path)
        duration = info['duration']
        if duration < low:
            raise ProjectError(f'视频至少需要 {low:g} 秒。', 422)
        if window:
            start, end = window
            if end - start > high:
                raise ProjectError(f'一次最多重绘 {high:g} 秒，请缩短区间。', 422)
            length = min(duration, max(low, min(high, end - start + 2)))
            first = min(max(0.0, (start + end - length) / 2), duration - length)
            pieces = [(first, first + length)]
        else:
            count = math.ceil(duration / high)
            pieces = [(duration * index / count, duration * (index + 1) / count) for index in range(count)]
        done = []
        for index, (first, last) in enumerate(pieces):
            await ctx.progress(f'正在重绘（{index + 1}/{len(pieces)}）' if len(pieces) > 1 else '正在重绘')
            clip = await blocking(media.conform, path, work.path / f'in-{index}.mp4', width=info['width'], height=info['height'],
                                           fps=info['fps'], start=first, end=last)
            local = (lambda mask: mask and EditMask(mask.level, mask.region, None if mask.start is None else mask.start - first,
                                                    None if mask.end is None else mask.end - first))
            drawn = await ctx.redraw(clip.read_bytes(), last - first, info['width'], info['height'], prompt, local(picture), local(sound))
            done.append(await blocking(media.conform, work.write(f'drawn-{index}.mp4', drawn), work.path / f'out-{index}.mp4',
                                                width=info['width'], height=info['height'], fps=info['fps'], end=last - first))
        await ctx.progress('正在合成结果')
        if window:
            return await blocking(media.splice, work, path, pieces[0][0], pieces[0][1], done[0])
        return await blocking(media.concat, work, done)

def _box_region(ctx: ToolContext, width, height, rows=36, columns=64):
    """Selection boxes (source pixels) as a 0/1 grid over the frame, or None without boxes."""
    if not ctx.boxes:
        return None
    grid = [[0.0] * columns for _ in range(rows)]
    for box in ctx.boxes:
        x0, y0 = box['x'] / width, box['y'] / height
        x1, y1 = (box['x'] + box['width']) / width, (box['y'] + box['height']) / height
        for row in range(rows):
            for column in range(columns):
                if x0 <= (column + 0.5) / columns <= x1 and y0 <= (row + 0.5) / rows <= y1:
                    grid[row][column] = 1.0
    return tuple(tuple(row) for row in grid)

async def _video_size(source: Source):
    with media.Workspace() as work:
        info = await blocking(media.video_info, work.write('probe.mp4', source.data))
    return info['width'], info['height']

async def partial_reshoot(ctx: ToolContext):
    source = _source_video(ctx)
    prompt = ctx.text('prompt')
    if not prompt:
        raise ProjectError('请描述重拍片段的内容。', 422)
    start = ctx.number('startMs', 0, 0) / 1000
    end = ctx.number('endMs', 0, 0) / 1000
    if end - start < 0.5:
        raise ProjectError('重拍区间至少 0.5 秒。', 422)
    # Only the chosen stretch is redrawn, picture and sound; the rest of the clip stays the source.
    window = EditMask(1.0, None, start, end)
    prompt = await ctx.video_prompt(prompt, 'Keep the people, setting, lighting and camera continuous with the surrounding footage.')
    data = await _redraw_pieces(ctx, source, prompt, window, window, window=(start, end))
    return [Output('video', data, 'mp4', '局部重拍')]

MATTE_MAX_FRAMES = 2048

def _write_mattes(tracks: Tracks, folder):
    folder.mkdir()
    for index, frame in enumerate(tracks.frames):
        matte = Image.new('L', (tracks.width, tracks.height), 0)
        for counts in frame:
            matte = ImageChops.lighter(matte, media.rle_mask(counts, tracks.width, tracks.height))
        # A one-pixel blur anti-aliases the hard mask edge.
        matte.filter(ImageFilter.GaussianBlur(0.8)).save(folder / f'{index:05d}.png', compress_level=1)

async def video_matting(ctx: ToolContext):
    source = _source_video(ctx)
    background = ctx.choice('background', ('black', 'green', 'transparent'), 'green')
    pairs = await ctx.concepts(ctx.text('prompt'), ('人物',))
    with media.Workspace() as work:
        raw = work.write('source', source.data)
        info = await blocking(media.video_info, raw)
        if info['duration'] * info['fps'] > MATTE_MAX_FRAMES:
            raise ProjectError(f'视频抠像单次最多处理 {MATTE_MAX_FRAMES} 帧（约 {MATTE_MAX_FRAMES / info["fps"]:.0f} 秒），请先裁剪视频。', 422)
        await ctx.progress('正在整理视频')
        # A constant-rate, even-sized clip decodes to the same frames for the tracker and ffmpeg.
        clip = await blocking(media.conform, raw, work.path / 'clip.mp4', width=info['width'] - info['width'] % 2,
                                       height=info['height'] - info['height'] % 2, fps=info['fps'])
        await ctx.progress(f"正在识别并跟踪「{'、'.join(label for _, label in pairs)}」")
        tracks = await ctx.track(clip.read_bytes(), tuple(concept for concept, _ in pairs))
        if not any(tracks.frames):
            label = '、'.join(label for _, label in pairs)
            raise ToolInputError(f'视频中没有识别到「{label}」，请换一种描述后重试。',
                                 code='tool_no_video_match', label=label)
        await ctx.progress('正在合成抠像视频')
        await blocking(_write_mattes, tracks, work.path / 'mattes')
        data, suffix = await blocking(media.matte, clip, str(work.path / 'mattes' / '%05d.png'), info['fps'],
                                               work.path / 'matted', background=background)
    return [Output('video', data, suffix, '视频抠像')]

DEPTH_MAX_SECONDS = 30

DEPTH_MAX_FRAMES = 2048

DEPTH_SHORT_EDGES = {'480P': 480, '720P': 720}

def _depth_size(width, height, short_edge):
    """The source size scaled down so its short side is at most short_edge, on even pixels."""
    scale = min(1.0, short_edge / min(width, height))
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)

async def depth_capture(ctx: ToolContext):
    source = _source_video(ctx)
    resolution = ctx.choice('resolution', tuple(DEPTH_SHORT_EDGES), '480P')
    with media.Workspace() as work:
        raw = work.write('source', source.data)
        info = await blocking(media.video_info, raw)
        if not 0 < info['duration'] <= DEPTH_MAX_SECONDS + 0.05:
            raise ProjectError(f'深度动作捕捉需要不超过 {DEPTH_MAX_SECONDS} 秒的素材，请先裁剪视频。', 422)
        if info['duration'] * info['fps'] > DEPTH_MAX_FRAMES:
            raise ProjectError(f'深度动作捕捉单次最多处理 {DEPTH_MAX_FRAMES} 帧，请先裁剪视频或降低帧率。', 422)
        await ctx.progress('正在整理视频')
        # The depth service returns the size it receives, so the clip is sized here; every
        # source frame is kept so depth frame i lines up with source frame i.
        width, height = _depth_size(info['width'], info['height'], DEPTH_SHORT_EDGES[resolution])
        clip = await blocking(media.picture, raw, work.path / 'clip.mp4', width=width, height=height)
        await ctx.progress('正在估计每一帧的深度')
        data = await ctx.depth(clip.read_bytes())
    return [Output('video', data, 'mp4', f'深度动作捕捉 {resolution}')]

async def video_edit(ctx: ToolContext):
    source = _source_video(ctx)
    prompt = ctx.text('prompt')
    if not prompt:
        raise ProjectError('请描述要如何修改视频。', 422)
    width, height = await _video_size(source)
    region = _box_region(ctx, width, height)
    # Masked redraw regenerates a region; a whole-frame restyle would discard the source entirely.
    if region is None:
        raise ProjectError('请先框选要重绘的区域。', 422)
    prompt = await ctx.video_prompt(prompt, 'The rest of the picture, its light and motion stay as they are.')
    data = await _redraw_pieces(ctx, source, prompt, EditMask(1.0, region), None)
    return [Output('video', data, 'mp4', '视频编辑')]

SUBTITLE_BAND = tuple((1.0,) if row >= 39 else (0.0,) for row in range(50))  # Bottom 22% of the frame.

async def subtitle_erasure(ctx: ToolContext):
    source = _source_video(ctx)
    width, height = await _video_size(source)
    picture = EditMask(1.0, _box_region(ctx, width, height) or SUBTITLE_BAND)
    prompt = await ctx.video_prompt(ctx.text('prompt'), 'This part of the frame continues the surrounding scene naturally, '
                                                         'matching its texture, light and motion.')
    data = await _redraw_pieces(ctx, source, prompt, picture, None)
    return [Output('video', data, 'mp4', '字幕擦除')]

AUDIO_MODES = {'all': '完整音轨', 'voice': '人声（近似）', 'backgroundSound': '背景声（近似）'}

async def audio_separation(ctx: ToolContext):
    if not ctx.sources or ctx.sources[0].kind not in {'video', 'audio'}:
        raise ProjectError('请提供视频或音频素材。', 422)
    source = ctx.sources[0]
    mode = ctx.choice('mode', AUDIO_MODES, 'all')
    outputs = []
    with media.Workspace() as work:
        suffix = source.name.rsplit('.', 1)[-1].lower() if '.' in source.name else ('mp4' if source.kind == 'video' else 'mp3')
        path = work.write(f'source.{suffix}', source.data)
        if mode == 'backgroundSound' and not await blocking(media.is_stereo_with_side, path):
            raise ProjectError('单声道音频无法在本地估计背景声，需要接入具备音轨分离能力的模型。', 422)
        await ctx.progress('正在分离音轨')
        audio = await blocking(media.audio_track, path, work.path / 'track.mp3',
                                        mode={'all': 'all', 'voice': 'voice', 'backgroundSound': 'background'}[mode])
        outputs.append(Output('audio', audio, 'mp3', AUDIO_MODES[mode]))
        if mode == 'all' and source.kind == 'video':
            # Splitting a clip yields both halves: its soundtrack and the silent picture.
            outputs.append(Output('video', await blocking(media.without_audio, path, work.path / 'silent.mp4'), 'mp4', '无声视频'))
    return outputs

async def video_upscale(ctx: ToolContext):
    source = _source_video(ctx)
    edge = {'2K': 2560, '4K': 3840}[ctx.choice('resolution', ('2K', '4K'), '4K')]
    await ctx.progress('正在放大视频')
    with media.Workspace() as work:
        data = await blocking(media.upscale, work.write('source.mp4', source.data), edge, work.path / 'out.mp4')
    return [Output('video', data, 'mp4', f'超清 {ctx.parameters.get("resolution", "4K")}')]

async def frame_interpolation(ctx: ToolContext):
    source = _source_video(ctx)
    fps = int(ctx.choice('fps', (30, 60, '30', '60'), 60))
    await ctx.progress(f'正在补帧到 {fps} fps')
    with media.Workspace() as work:
        data = await blocking(media.interpolate, work.write('source.mp4', source.data), fps, work.path / 'out.mp4')
    return [Output('video', data, 'mp4', f'补帧 {fps}fps')]
