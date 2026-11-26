"""Probe uploaded/generated media using a bounded local ffprobe process."""

from fractions import Fraction
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile

from opendirector.domain.projects import ProjectError


def require_ffprobe():
    if not shutil.which("ffprobe"):
        raise ProjectError("视频和音频需要 FFmpeg：请安装并确保 ffprobe 在 PATH 中，然后重启服务。", 409)


def probe(data: bytes, suffix: str, kind: str, *, include_codecs=False):
    require_ffprobe()
    with tempfile.TemporaryDirectory(prefix="opendirector-probe-") as folder:
        file = Path(folder) / ("input" + suffix)
        file.write_bytes(data)
        return probe_file(file, kind, include_codecs=include_codecs)


def _packet_duration(file: Path) -> float:
    """Derive duration from demuxed packet timestamps.

    MediaRecorder WebM is written as a live stream and often has no duration in
    its container or stream headers. The packets still carry timestamps, so use
    the last packet end as a bounded fallback instead of rejecting valid media.
    """
    process = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", str(file)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
    if len(process.stdout) > 8 * 1024 * 1024:
        raise ValueError()
    end = last = None
    for line in process.stdout.decode("utf-8", "replace").splitlines():
        values = line.split(",")
        try:
            pts = float(values[0])
        except (ValueError, IndexError):
            continue
        if not math.isfinite(pts):
            continue
        last = pts if last is None else max(last, pts)
        try:
            packet_end = pts + float(values[1])
        except (ValueError, IndexError):
            continue
        if math.isfinite(packet_end):
            end = packet_end if end is None else max(end, packet_end)
    if end is not None and end > 0:
        return end
    # A final packet without a duration still has a useful presentation time.
    return last + 0.001 if last is not None else 0


def probe_file(file: Path, kind: str, *, include_container=False, include_codecs=False):
    """Inspect an existing staged file without copying it into memory."""
    require_ffprobe()
    try:
        process = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", str(file)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
        if len(process.stdout) > 1024 * 1024:
            raise ValueError()
        value = json.loads(process.stdout)
        stream = next(item for item in value["streams"] if item["codec_type"] == kind)
        duration = float(value.get("format", {}).get("duration") or stream.get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0:
            duration = _packet_duration(file)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError()
        common = {"kind": kind, "durationMs": round(duration * 1000)}
        if include_codecs:
            common.update(codec=stream['codec_name'], audioCodecs=[item['codec_name'] for item in value['streams'] if item['codec_type'] == 'audio'])
        if include_container:
            common.update(durationSeconds=duration, container=value['format']['format_name'],
                          majorBrand=value.get('format', {}).get('tags', {}).get('major_brand', '').strip())
        if kind == "video":
            numerator, denominator = stream.get("avg_frame_rate", "0/1").split("/")
            fps = float(numerator) / float(denominator) if float(denominator) else None
            if fps is not None and (not math.isfinite(fps) or fps < 0):
                raise ValueError()
            return {**common, "width": stream["width"], "height": stream["height"], "frameRate": fps or None,
                    "hasAudio": any(item.get("codec_type") == "audio" for item in value["streams"])}
        return {**common, "sampleRate": int(stream["sample_rate"]), "channels": stream["channels"]}
    except (subprocess.SubprocessError, ValueError, TypeError, KeyError, StopIteration, OverflowError):
        raise ProjectError("无法读取视频或音频，请检查文件格式及完整性。") from None



def count_video_frames(path: Path, *, fps: int) -> int:
    require_ffprobe()
    try:
        output = subprocess.run(
            ['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
             '-select_streams', 'v:0', '-count_frames', '-show_entries',
             'stream=avg_frame_rate,nb_read_frames', '-of', 'json', str(path)],
            check=True, capture_output=True, timeout=90,
        )
        stream = json.loads(output.stdout)['streams'][0]
        count = int(stream['nb_read_frames'])
        if Fraction(stream['avg_frame_rate']) == fps and count > 0:
            return count
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, KeyError, IndexError, ValueError, ZeroDivisionError):
        raise ProjectError('无法核对源片的帧数或帧率。', 409, code='reference_invalid') from None
    raise ProjectError('计划帧率与实际源片不一致。', 409, code='reference_invalid')
