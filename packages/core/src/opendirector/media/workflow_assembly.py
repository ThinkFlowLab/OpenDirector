"""Frame-indexed assembly of retained clips from a generation workflow."""

import json
from collections.abc import Sequence
from fractions import Fraction
from pathlib import Path

from opendirector.domain.projects import ProjectError
from opendirector.media.processing import Workspace, _run


def _invalid(message: str) -> ProjectError:
    return ProjectError(message, 422, code='workflow_media_invalid')


def _execute(arguments: list[str], *, timeout: int = 900) -> bytes:
    try:
        return _run(arguments, timeout=timeout)
    except ProjectError as error:
        raise ProjectError(
            '无法处理工作流媒体，请检查输入文件和 FFmpeg。',
            error.status,
            code='workflow_media_failed',
        ) from error


def _stream(path: Path, selector: str, *, count_frames: bool = False) -> dict:
    arguments = ['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', selector]
    if count_frames:
        arguments.append('-count_frames')
    entries = 'codec_name,width,height,avg_frame_rate,nb_read_frames,duration_ts,time_base'
    data = json.loads(_execute([*arguments, '-show_entries', f'stream={entries}', '-of', 'json',
                                str(path.resolve())], timeout=90))
    streams = data.get('streams', [])
    if len(streams) != 1:
        raise _invalid('工作流素材缺少所需的视频或原声音轨。')
    return streams[0]


def _duration(stream: dict) -> Fraction:
    try:
        return int(stream['duration_ts']) * Fraction(stream['time_base'])
    except (KeyError, ValueError, ZeroDivisionError):
        raise _invalid('无法确定工作流素材时长。') from None


def probe_video_frames(path: Path, *, fps: int, width: int | None = None,
                       height: int | None = None, exact_duration: bool = False) -> int:
    stream = _stream(path, 'v:0', count_frames=True)
    try:
        frame_rate = Fraction(stream['avg_frame_rate'])
        count = int(stream['nb_read_frames'])
    except (KeyError, ValueError, ZeroDivisionError):
        raise _invalid('无法确定工作流视频素材的帧率或帧数。') from None
    if (frame_rate != fps or count < 1 or (width is not None and stream.get('width') != width)
            or (height is not None and stream.get('height') != height)):
        raise _invalid('工作流视频素材的尺寸、帧率或帧数不符合配置。')
    if exact_duration and _duration(stream) != Fraction(count, fps):
        raise _invalid('组装视频的时长与保留帧数不一致。')
    return count


def prepare_clip(source: Path, output: Path, *, fps: int, width: int, height: int,
                 in_frame: int, out_frame: int, reverse: bool = False, frame_limit: int | None = None,
                 normalize_size: bool = False) -> None:
    """Write a silent MP4 from a half-open window in the capped, oriented clip."""
    total = probe_video_frames(source, fps=fps,
                               width=None if normalize_size else width, height=None if normalize_size else height)
    capped_end = total if frame_limit is None else min(frame_limit, total)
    if not 0 <= in_frame < out_frame <= capped_end:
        raise _invalid('裁切范围超出了工作流片段的有效帧数。')
    start, end = in_frame, out_frame
    if reverse:
        # Map the oriented window to source ordinals before buffering the frames.
        start, end = capped_end - out_frame, capped_end - in_frame
    filters = [f'trim=start_frame={start}:end_frame={end}']
    if reverse:
        filters.append('reverse')
    if normalize_size:
        filters.extend([f'scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2',
                        f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2'])
    filters.extend([f'settb=1/{fps}', 'setpts=N', 'setsar=1'])
    count = out_frame - in_frame
    _execute(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-n', '-protocol_whitelist', 'file,pipe',
              '-i', str(source.resolve()), '-map', '0:v:0', '-vf', ','.join(filters),
              '-an', '-frames:v', str(count), '-r', str(fps),
              '-video_track_timescale', str(fps), '-c:v', 'libx264', '-bf', '0', '-preset', 'veryfast', '-crf', '18',
              '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(output.resolve())])
    if probe_video_frames(output, fps=fps, width=width, height=height, exact_duration=True) != count:
        raise _invalid('裁切视频的实际帧数与保留范围不一致。')


def _concat_entry(path: Path, frames: int, fps: int) -> str:
    name = path.resolve().as_posix()
    if '\n' in name or '\r' in name:
        raise _invalid('工作流视频的文件路径包含换行符。')
    quoted = name.replace("'", "'\\''")
    return f"file '{quoted}'\nduration {frames / fps:.9f}\n"


def assemble_clips(clips: Sequence[Path], soundtrack: Path, output: Path, *,
                   fps: int, width: int, height: int, frames: int) -> None:
    """Mux the prepared pictures in order and attach the original soundtrack."""
    counts = [probe_video_frames(path, fps=fps, width=width, height=height, exact_duration=True) for path in clips]
    if not counts or sum(counts) != frames:
        raise _invalid('片段总帧数与成片配置不一致。')
    expected_duration = Fraction(frames, fps)
    soundtrack_info = _stream(soundtrack, 'a:0')
    if _duration(soundtrack_info) < expected_duration - Fraction(1, 2 * fps):
        raise _invalid('原声音轨未覆盖成片的完整时长。')
    audio_codec = 'copy' if soundtrack_info.get('codec_name') == 'aac' else 'aac'
    duration = f'{float(expected_duration):.9f}'
    with Workspace() as workspace:
        manifest = ''.join(_concat_entry(path, count, fps) for path, count in zip(clips, counts, strict=True))
        listing = workspace.write('clips.ffconcat', manifest.encode('utf-8'))
        _execute(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-n', '-protocol_whitelist', 'file,pipe',
                  '-f', 'concat', '-safe', '0', '-i', str(listing), '-protocol_whitelist', 'file,pipe',
                  '-t', duration, '-i', str(soundtrack.resolve()), '-map', '0:v:0', '-map', '1:a:0',
                  '-c:v', 'copy', '-c:a', audio_codec, '-video_track_timescale', str(fps),
                  '-movflags', '+faststart', str(output.resolve())])
    if (probe_video_frames(output, fps=fps, width=width, height=height, exact_duration=True) != frames
            or abs(_duration(_stream(output, 'a:0')) - expected_duration) > Fraction(1, fps)):
        raise _invalid('成片的视频帧数或原声时长与配置不一致。')
