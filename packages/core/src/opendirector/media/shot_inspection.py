"""Local shot probing, contact-sheet rendering, and deterministic video QC."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageStat

from opendirector.domain.projects import ProjectError
from opendirector.media import processing as media


def _probe_streams(path: Path) -> dict:
    raw = json.loads(media._run([
        "ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_entries",
        "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames",
        "-of",
        "json",
        str(path),
    ], timeout=60))
    streams = raw.get("streams", [])
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if video is None:
        raise ProjectError("素材中没有视频画面。", 422)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    num, _, den = (video.get("r_frame_rate") or "24/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 24.0
    fps = fps or 24.0
    duration = float(raw.get("format", {}).get("duration") or 0.0)
    raw_frames = video.get("nb_frames")
    frame_count = int(raw_frames) if str(raw_frames or "").isdigit() else max(1, round(duration * fps))
    nearest_h3 = max(5, 17 * max(0, round((frame_count - 5) / 17)) + 5)
    return {
        "durationSeconds": round(duration, 4),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": round(fps, 4),
        "frameCount": frame_count,
        "matchesH3Grid": frame_count >= 5 and (frame_count - 5) % 17 == 0,
        "nearestH3Frames": nearest_h3,
        "videoCodec": str(video.get("codec_name") or "unknown"),
        "hasAudio": audio is not None,
        "audioCodec": str(audio.get("codec_name")) if audio is not None and audio.get("codec_name") else None,
        "sizeBytes": int(raw.get("format", {}).get("size") or path.stat().st_size),
    }


def _sample_timestamps(duration_seconds: float, count: int, fps: float) -> list[float]:
    if count <= 0:
        return []
    safe_end = max(0.0, duration_seconds - max(1.0 / max(fps, 1.0), 0.05))
    if count == 1 or safe_end <= 0:
        return [0.0] * count
    return [round(safe_end * index / (count - 1), 3) for index in range(count)]


def _write_exclusive_bytes(destination: Path, payload: bytes) -> None:
    """Create destination exclusively without unlinking public paths on error."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(destination, flags, 0o600)
    except FileExistsError:
        raise ProjectError(f"联系表输出文件已存在：{destination}", 409) from None
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
        handle.flush()


def _write_cache_bytes(destination: Path, payload: bytes) -> None:
    """Atomically refresh a trusted internal preview-cache rendition."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".sheet-", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
        os.replace(temp_name, destination)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _mean_abs_diff(first: Image.Image, second: Image.Image) -> float:
    diff = ImageChops.difference(first, second)
    return float(ImageStat.Stat(diff).mean[0])


def _compute_measured_facts(technical: dict, gray_frames: list[Image.Image] | None) -> dict:
    warnings: list[str] = []
    if not technical["matchesH3Grid"]:
        warnings.append(
            f"Frame count {technical['frameCount']} does not align to MiniMax-H3 17n+5 grid "
            f"(nearest: {technical['nearestH3Frames']})."
        )
    if not technical["hasAudio"]:
        warnings.append("Video contains no audio stream.")

    motion = None
    exposure = None
    if gray_frames:
        luma_stats = [
            (float(stat.mean[0]), float(stat.stddev[0]))
            for stat in (ImageStat.Stat(frame) for frame in gray_frames)
        ]
        deltas = [
            round(_mean_abs_diff(gray_frames[index], gray_frames[index + 1]), 3)
            for index in range(len(gray_frames) - 1)
        ]
        mean_delta = round(sum(deltas) / len(deltas), 3) if deltas else 0.0
        max_delta = round(max(deltas), 3) if deltas else 0.0
        first_last_diff = _mean_abs_diff(gray_frames[0], gray_frames[-1]) if len(gray_frames) >= 2 else 0.0
        similarity = round(max(0.0, min(1.0, 1.0 - first_last_diff / 255.0)), 4)
        suspected_frozen = bool(len(gray_frames) >= 2 and max_delta < 1.5)
        black_indices = [
            index for index, (mean_luma, std_luma) in enumerate(luma_stats)
            if mean_luma < 6.0 and std_luma < 3.0
        ]
        black_ratio = round(len(black_indices) / len(luma_stats), 4)
        if suspected_frozen:
            warnings.append(
                "Sampled frames show near-zero pixel motion (maxFrameDelta < 1.5); "
                "verify whether the video actually animates."
            )
        if black_indices:
            warnings.append(
                f"Detected {len(black_indices)} near-black sampled frame(s) at tile index(es) {black_indices}."
            )
        motion = {
            "sampledFrames": len(gray_frames),
            "meanFrameDelta": mean_delta,
            "maxFrameDelta": max_delta,
            "firstLastSimilarity": similarity,
            "suspectedFrozen": suspected_frozen,
        }
        exposure = {
            "blackFrameIndices": black_indices,
            "blackFrameRatio": black_ratio,
        }

    return {
        "source": "measured",
        "reviewRequired": True,
        "technical": technical,
        "motion": motion,
        "exposure": exposure,
        "warnings": warnings,
    }


def inspect_video_shot(
    video_path: Path,
    *,
    contact_sheet_path: Path | None = None,
    columns: int = 4,
    rows: int = 3,
    tile_long_edge: int = 320,
    overwrite_cache: bool = False,
) -> dict:
    """Probe a video file and optionally render a timestamped JPEG contact sheet."""
    if not video_path.is_file():
        raise ProjectError(f"视频文件不存在：{video_path}", 404)
    if columns < 1 or columns > 8 or rows < 1 or rows > 8:
        raise ProjectError("联系表网格行列数必须在 1 到 8 之间。", 422)

    technical = _probe_streams(video_path)
    if contact_sheet_path is None:
        return {
            "path": str(video_path.resolve()),
            "technical": technical,
            "contactSheet": None,
            "measuredFacts": _compute_measured_facts(technical, None),
        }
    if not overwrite_cache and contact_sheet_path.exists():
        raise ProjectError(f"联系表输出文件已存在：{contact_sheet_path}", 409)

    total_tiles = columns * rows
    timestamps = _sample_timestamps(technical["durationSeconds"], total_tiles, technical["fps"])
    aspect = technical["width"] / max(1, technical["height"])
    if aspect >= 1.0:
        tile_w = tile_long_edge
        tile_h = max(48, round(tile_long_edge / aspect))
    else:
        tile_h = tile_long_edge
        tile_w = max(48, round(tile_long_edge * aspect))

    pad = 6
    sheet_w = columns * tile_w + (columns + 1) * pad
    sheet_h = rows * tile_h + (rows + 1) * pad
    sheet = Image.new("RGB", (sheet_w, sheet_h), (18, 18, 22))
    draw = ImageDraw.Draw(sheet)
    gray_frames: list[Image.Image] = []

    with media.Workspace() as work:
        for index, stamp in enumerate(timestamps):
            frame_bytes = media.frame_at(video_path, stamp, work.path / f"tile-{index:02d}.png")
            frame = media.open_image(frame_bytes).convert("RGB")
            gray_frames.append(frame.convert("L").resize((64, 64), Image.Resampling.BILINEAR))
            resized = media.resize(frame, tile_w, tile_h)
            col, row = index % columns, index // columns
            x = pad + col * (tile_w + pad)
            y = pad + row * (tile_h + pad)
            sheet.paste(resized, (x, y))
            minutes = int(stamp // 60)
            seconds = stamp - minutes * 60
            label = f"#{index + 1:02d} {minutes:02d}:{seconds:05.2f}"
            badge_w = max(78, len(label) * 7 + 8)
            draw.rectangle((x + 4, y + 4, x + 4 + badge_w, y + 20), fill=(0, 0, 0))
            draw.text((x + 8, y + 6), label, fill=(245, 245, 245))

    buffer = io.BytesIO()
    sheet.save(buffer, format="JPEG", quality=84, optimize=True)
    jpeg_bytes = buffer.getvalue()
    if overwrite_cache:
        _write_cache_bytes(contact_sheet_path, jpeg_bytes)
    else:
        _write_exclusive_bytes(contact_sheet_path, jpeg_bytes)

    return {
        "path": str(video_path.resolve()),
        "technical": technical,
        "contactSheet": {
            "path": str(contact_sheet_path.resolve()),
            "columns": columns,
            "rows": rows,
            "tileCount": total_tiles,
            "width": sheet_w,
            "height": sheet_h,
            "sizeBytes": len(jpeg_bytes),
            "timestamps": timestamps,
        },
        "measuredFacts": _compute_measured_facts(technical, gray_frames),
    }
