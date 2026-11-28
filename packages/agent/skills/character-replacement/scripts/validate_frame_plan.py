#!/usr/bin/env python3
"""Validate a frame plan against saved OpenDirector assembly inputs and the rendered file."""

import argparse
import hashlib
import json
import subprocess
import sys
from fractions import Fraction
from itertools import zip_longest
from math import isfinite
from pathlib import Path


FRAME_TOLERANCE = 0.001  # Allow rounding in serialized seconds, never a fractional-frame edit.


def frame_range(value, limit, label):
    if not isinstance(value, list) or len(value) != 2 or not all(type(n) is int for n in value):
        raise ValueError(f"{label} must be a pair of integer frame indices.")
    start, end = value
    if not 0 <= start < end <= limit:
        raise ValueError(f"{label} [{start}, {end}) must be nonempty and within [0, {limit}).")
    return start, end


def rows(plan, key):
    value = plan.get(key)
    if not isinstance(value, list):
        raise ValueError(f"{key} must be an array.")
    return value


def contiguous_ranges(ranges):
    merged = []
    for start, end in ranges:
        if merged and start == merged[-1][1]:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def describe_range(interval):
    return "none" if interval is None else f"[{interval[0]}, {interval[1]})"


def object_fields(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object.")
    return value


def asset_version(value: object, label: str, kind: str) -> tuple[str, int, str]:
    asset = object_fields(value, label)
    asset_id, revision, digest = (asset.get(field) for field in ("assetId", "revision", "fingerprint"))
    if (asset.get("kind") != kind or not isinstance(asset_id, str) or not asset_id.strip()
            or type(revision) is not int or revision < 1 or not isinstance(digest, str) or not digest):
        raise ValueError(f"{label} requires a {kind} AssetRef with assetId, revision, and fingerprint.")
    return asset_id, revision, digest


def read_delivery(plan: dict[str, object]) -> tuple[int, dict[str, object]]:
    delivery = object_fields(plan.get("delivery"), "delivery")
    fps = delivery.get("fps")
    if type(fps) is not int or fps <= 0:
        raise ValueError("delivery.fps must be a positive integer.")
    audio = object_fields(delivery.get("audio"), "delivery.audio")
    if "asset" in audio:
        asset_version(audio.get("asset"), "delivery.audio.asset", "audio")
    return fps, audio


def inspected_ranges(
    inspection: dict[str, object], total_frames: int,
) -> tuple[list[tuple[int, int]], list[int]]:
    inspected_frames = inspection.get("totalFrames")
    if type(inspected_frames) is not int or inspected_frames != total_frames:
        raise ValueError(f"Shot inspection totalFrames must be {total_frames}. Found {inspected_frames!r}.")

    source_only = []
    required_cuts = []
    cursor = 0
    previous_tracks: set[str] = set()
    for index, shot in enumerate(rows(inspection, "shots")):
        label = f"shots[{index}]"
        if not isinstance(shot, dict):
            raise ValueError(f"{label} must be an object.")
        start, end = frame_range(shot.get("source"), total_frames, f"{label}.source")
        if start != cursor:
            raise ValueError(f"{label}.source starts at frame {start}. Expected {cursor}.")
        selected_tracks = shot.get("selectedTracks")
        if not isinstance(selected_tracks, list) or any(
            not isinstance(track, str) or not track.strip() for track in selected_tracks
        ):
            raise ValueError(f"{label}.selectedTracks must be an array of nonempty string IDs.")
        if not selected_tracks:
            source_only.append((start, end))
        required_cut = shot.get("requiredTimelineCut", False)
        if type(required_cut) is not bool:
            raise ValueError(f"{label}.requiredTimelineCut must be a boolean.")
        tracks = set(selected_tracks)
        if required_cut or (start and tracks != previous_tracks):
            required_cuts.append(start)
        previous_tracks = tracks
        cursor = end
    if cursor != total_frames:
        raise ValueError(f"Shot inspection ends at frame {cursor}. Missing [{cursor}, {total_frames}).")
    return source_only, required_cuts


def window_planning_issues(plan, inspection, fps, retained_frames):
    """Find feasible local improvements without changing source ownership."""
    total = plan["totalFrames"]
    occlusions = {}
    ranges = inspection.get("occludedFaceRanges")
    if not isinstance(ranges, list):
        raise ValueError("Shot inspection must record occludedFaceRanges (use [] after checking).")
    for index, row in enumerate(ranges):
        label = f"occludedFaceRanges[{index}]"
        row = object_fields(row, label)
        start, end = frame_range(row.get("source"), total, f"{label}.source")
        if not isinstance(row.get("track"), str) or not row["track"].strip():
            raise ValueError(f"{label}.track must identify the assigned source person.")
        for frame in range(start, end):
            occlusions.setdefault(frame, set()).add(row["track"])
    blocked = occlusions.keys()

    def clear_join(frame):
        return frame - 1 not in blocked and frame not in blocked

    def aligned(frames):
        return 5 + 17 * max(0, (max(frames, 4 * fps) - 5 + 16) // 17)

    cap = 5 + 17 * ((6 * fps - 5) // 17)
    windows = {segment["id"]: segment for segment in plan["segments"]}
    delivered = {}
    issues = []
    previous = None
    for row in plan["timeline"]:
        segment_id = row.get("segment")
        if segment_id is not None:
            delivered.setdefault(segment_id, []).append(row["source"])
        cut = row["source"][0]
        if previous is not None and segment_id is not None and previous != segment_id and not clear_join(cut):
            issues.append(f"Generation join {cut - 1}/{cut} for {segment_id!r} touches an occluded face.")
        previous = segment_id

    for segment_id, segment in windows.items():
        start, end = segment["source"]
        if "reverseLimit" in segment and segment["reverseLimit"] != end - start:
            issues.append(
                f"Segment {segment_id!r} reverseLimit {segment['reverseLimit']} must equal "
                f"its source window length {end - start}."
            )
        first_frame = end - 1 if "reverseLimit" in segment else start
        if first_frame in blocked:
            issues.append(f"Segment {segment_id!r} starts on occluded source frame {first_frame}.")

    shots = inspection["shots"]

    def source_frame(window, index):
        start, end = window["source"]
        if not 0 <= index < end - start:
            return None
        return end - 1 - index if "reverseLimit" in window else start + index

    def visible_tracks(frame):
        tracks = next(shot["selectedTracks"] for shot in shots if shot["source"][0] <= frame < shot["source"][1])
        return set(tracks) - occlusions.get(frame, set())

    for segment_id, segment in windows.items():
        if "guide" not in segment:
            continue
        guide = object_fields(segment["guide"], f"Segment {segment_id!r} guide")
        donor = windows.get(guide.get("segment"))
        indices = guide.get("frames")
        if donor is None or not isinstance(indices, list) or len(indices) != 2 or any(
            type(index) is not int for index in indices
        ):
            raise ValueError(f"Segment {segment_id!r} needs a donor and two ordered guide indices.")
        frames = [source_frame(donor, index) for index in indices]
        if None in frames or frames != [source_frame(segment, index) for index in (0, 21)]:
            issues.append(f"Segment {segment_id!r} guide source frames {frames} must match its input slots 0 and 21.")
            continue
        delivered_ranges = delivered.get(segment_id) or [segment["source"]]
        assigned = {
            track
            for interval_start, interval_end in delivered_ranges
            for shot in shots
            if shot["source"][0] < interval_end and interval_start < shot["source"][1]
            for track in shot["selectedTracks"]
        }
        missing = assigned - set.union(*(visible_tracks(frame) for frame in frames))
        if assigned and missing:
            issues.append(
                f"Segment {segment_id!r} guide source frames {frames} both miss assigned tracks "
                f"{', '.join(sorted(missing))}. Replan the windows and guides before publishing."
            )

    ordered = list(delivered)
    for left_id, right_id in zip(ordered, ordered[1:]):
        left, right = windows[left_id], windows[right_id]
        if (not left.get("portraits") or left["portraits"] != right.get("portraits")
                or "reverseLimit" in left or "reverseLimit" in right):
            continue
        left_start, left_end = delivered[left_id][0][0], delivered[left_id][-1][1]
        right_start, right_end = delivered[right_id][0][0], delivered[right_id][-1][1]
        if left_end > right_start:
            continue
        if not left.get("guide") and not right.get("guide"):
            for start in range(left_start, max(-1, right_end - cap - 1), -1):
                end = start + aligned(right_end - start)
                if end <= total and start not in blocked:
                    issues.append(f"Anchors {left_id!r} and {right_id!r} fit one forward input "
                                  f"[{start}, {end}). Keep separate assembly trims.")
                    break
        guide = right.get("guide")
        if (not isinstance(guide, dict) or guide.get("segment") != left_id or left_end != right_start
                or 2 * retained_frames[right_id] >= right["rawFrames"]):
            continue
        left_input = left["source"][0]
        midpoint = (left_start + right_end) // 2
        for cut in sorted(range(left_start + 1, left_end), key=lambda frame: abs(frame - midpoint)):
            right_input = cut - 22
            left_raw = aligned(cut - left_input)
            right_raw = aligned(right_end - right_input)
            if (right_input < left_input or not clear_join(cut) or right_input in blocked
                    or max(left_raw, right_raw) > cap
                    or left_input + left_raw > total or right_input + right_raw > total
                    or 2 * (cut - left_start) < left_raw or 2 * (right_end - cut) < right_raw):
                continue
            issues.append(f"Guided tail {right_id!r} can share retained frames with {left_id!r}: "
                          f"move the join to frame {cut}, then recompute guides and trims.")
            break
    return issues


def validate_plan(plan: object, inspection: dict[str, object] | None = None, *,
                  enforce_window_limit: bool = False) -> tuple[int, int]:
    if not isinstance(plan, dict):
        raise ValueError("The plan must be a JSON object.")
    total_frames = plan.get("totalFrames")
    if type(total_frames) is not int or total_frames <= 0:
        raise ValueError("totalFrames must be a positive integer.")
    fps = None
    if "delivery" in plan or enforce_window_limit:
        fps, _ = read_delivery(plan)

    source_only = []
    for index, interval in enumerate(rows(plan, "sourceOnly")):
        start, end = frame_range(interval, total_frames, f"sourceOnly[{index}]")
        if source_only and start < source_only[-1][1]:
            raise ValueError(f"sourceOnly[{index}] [{start}, {end}) overlaps or precedes the previous interval.")
        source_only.append((start, end))

    required_cuts = []
    if inspection is not None:
        inspected, required_cuts = inspected_ranges(inspection, total_frames)
        for expected, declared in zip_longest(contiguous_ranges(inspected), contiguous_ranges(source_only)):
            if expected != declared:
                raise ValueError(
                    f"Source ownership differs from shot inspection. Expected {describe_range(expected)}, "
                    f"found {describe_range(declared)} in sourceOnly."
                )

    segments = {}
    window_keys = {}
    for index, segment in enumerate(rows(plan, "segments")):
        if not isinstance(segment, dict):
            raise ValueError(f"segments[{index}] must be an object.")
        segment_id = segment.get("id")
        if not isinstance(segment_id, str) or not segment_id.strip():
            raise ValueError(f"segments[{index}].id must be a nonempty string.")
        if segment_id in segments:
            raise ValueError(f"Segment {segment_id!r} appears more than once.")
        label = f"Segment {segment_id!r}"
        start, end = frame_range(segment.get("source"), total_frames, f"{label} source")
        raw_frames = segment.get("rawFrames")
        if type(raw_frames) is not int or raw_frames < end - start:
            raise ValueError(f"{label} rawFrames must be an integer of at least {end - start}.")
        if enforce_window_limit and (raw_frames < 107 or (raw_frames - 5) % 17 or end - start != raw_frames):
            raise ValueError(
                f"{label} input range has {end - start} frames and requests {raw_frames}. "
                "Both must match 17k+5 with k >= 6 (at least 107 frames)."
            )
        if enforce_window_limit and raw_frames > 6 * fps:
            raise ValueError(f"{label} requests {raw_frames} frames at {fps} FPS. The six-second limit is {6 * fps} frames.")
        keep_limit = segment.get("reverseLimit", raw_frames)
        if type(keep_limit) is not int or not 0 < keep_limit <= raw_frames:
            raise ValueError(f"{label} reverseLimit must be an integer from 1 to {raw_frames}.")
        if enforce_window_limit and "reverseLimit" in segment and keep_limit != end - start:
            raise ValueError(
                f"{label} reverseLimit is {keep_limit}, expected {end - start} to match the full reversed input window."
            )
        if enforce_window_limit and inspection is not None:
            window_key = json.dumps(
                [start, end, raw_frames, segment.get("reverseLimit"), segment.get("portraits"),
                 segment.get("guide")], sort_keys=True,
            )
            if window_key in window_keys:
                raise ValueError(f"{label} duplicates the generation window {window_keys[window_key]!r}. "
                                 "Reuse one segment with separate keep ranges.")
            window_keys[window_key] = segment_id
        segments[segment_id] = (start, end, keep_limit)

    timeline = rows(plan, "timeline")
    if not timeline:
        raise ValueError("timeline must have at least one interval.")
    copied = []
    retained_frames = dict.fromkeys(segments, 0)
    cursor = 0
    for index, entry in enumerate(timeline):
        label = f"timeline[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{label} must be an object.")
        start, end = frame_range(entry.get("source"), total_frames, f"{label} source")
        if start != cursor:
            kind = "leaves a gap" if start > cursor else "overlaps or is out of order"
            raise ValueError(f"{label} [{start}, {end}) {kind}; expected start frame {cursor}.")
        cursor = end
        owner = entry.get("owner")
        if owner == "source":
            if "segment" in entry or "keep" in entry:
                raise ValueError(f"{label} [{start}, {end}) is source-owned and cannot specify segment or keep.")
            copied.append((start, end))
            continue
        if owner != "generated":
            raise ValueError(f"{label} [{start}, {end}) owner must be 'source' or 'generated'.")
        segment_id = entry.get("segment")
        if not isinstance(segment_id, str) or segment_id not in segments:
            raise ValueError(f"{label} [{start}, {end}) refers to an unknown segment {segment_id!r}.")
        source_start, source_end, keep_limit = segments[segment_id]
        if not source_start <= start < end <= source_end:
            raise ValueError(
                f"{label} [{start}, {end}) is outside segment {segment_id!r} source [{source_start}, {source_end})."
            )
        retained_frames[segment_id] += end - start
        keep_start, keep_end = frame_range(entry.get("keep"), keep_limit, f"{label} segment {segment_id!r} keep")
        if keep_end - keep_start != end - start:
            raise ValueError(
                f"{label} [{start}, {end}) needs {end - start} frames; "
                f"segment {segment_id!r} keep [{keep_start}, {keep_end}) supplies {keep_end - keep_start}."
            )
        if enforce_window_limit:
            expected_keep = (start - source_start, end - source_start)
            if (keep_start, keep_end) != expected_keep:
                raise ValueError(
                    f"{label} [{start}, {end}) in segment {segment_id!r} [{source_start}, {source_end}) "
                    f"keeps [{keep_start}, {keep_end}), expected [{expected_keep[0]}, {expected_keep[1]})."
                )
    if cursor != total_frames:
        raise ValueError(f"Timeline ends at frame {cursor}; missing [{cursor}, {total_frames}).")

    if enforce_window_limit and inspection is not None:
        short_windows = [
            segment for segment in plan["segments"]
            if 0 < 2 * retained_frames[segment["id"]] < segment["rawFrames"]
        ]
        issues = window_planning_issues(plan, inspection, fps, retained_frames)
        if issues:
            raise ValueError("\n".join(issues))
        if len(short_windows) > 1:
            for segment in short_windows:
                reason = segment.get("splitReason")
                if not isinstance(reason, str) or not reason.strip():
                    raise ValueError(f"Segment {segment['id']!r} retains less than half its window. "
                                     "Merge compatible shots or record the concrete splitReason.")

    planned_cuts = [entry["source"][0] for entry in timeline]
    for required_cut in required_cuts:
        if required_cut not in planned_cuts:
            nearest = min(planned_cuts, key=lambda frame: abs(frame - required_cut))
            raise ValueError(f"Required timeline cut at frame {required_cut} is missing. "
                             f"Nearest planned cut is {nearest} ({nearest - required_cut:+d} frames).")

    for expected, actual in zip_longest(contiguous_ranges(source_only), contiguous_ranges(copied)):
        if expected != actual:
            raise ValueError(
                f"Source ownership differs: expected {describe_range(expected)}, found {describe_range(actual)}. "
                "Use owner 'source' for exactly the inspected sourceOnly ranges."
            )
    return total_frames, len(timeline)


def saved_object(
    snapshot: dict[str, object], collection: str, object_id: object, kind: str,
) -> dict[str, object]:
    if not isinstance(object_id, str) or not object_id:
        raise ValueError(f"Missing saved {kind} ID in {collection}.")
    for value in rows(snapshot, collection):
        item = object_fields(value, f"{collection} entry")
        if item.get("id") == object_id and item.get("kind") == kind:
            return item
    raise ValueError(f"Saved {kind} {object_id} was not found in {collection}.")


def saved_timeline(snapshot: dict[str, object], item_id: str) -> dict[str, object]:
    item = saved_object(snapshot, "canvasItems", item_id, "timeline")
    binding = object_fields(item.get("binding"), f"Timeline {item_id} binding")
    if item.get("visible") is False or binding.get("role") != "editor":
        raise ValueError(f"Timeline {item_id} must be visible and bound to an editor document.")
    ref = object_fields(binding.get("objectRef"), f"Timeline {item_id} editor reference")
    document = saved_object(snapshot, "editorDocuments", ref.get("id"), "timeline")
    return object_fields(document.get("data"), f"Timeline {item_id} data")


def seconds_to_frames(value: object, fps: int, label: str) -> int:
    if type(value) not in (int, float) or not isfinite(value) or value < 0:
        raise ValueError(f"{label} must be nonnegative seconds.")
    frames = value * fps
    nearest = round(frames)
    if abs(frames - nearest) > FRAME_TOLERANCE:
        raise ValueError(f"{label} falls between frames at {fps} FPS ({frames:.4f}).")
    return nearest


def active_clip(track: dict[str, object], clip: dict[str, object]) -> bool:
    return not track.get("muted", False) and not clip.get("muted", False) and clip.get("volume", 1) != 0


def check_audio(
    timeline: dict[str, object], audio: dict[str, object], fps: int, total_frames: int, *, strict: bool,
) -> list[str]:
    tracks = rows(timeline, "tracks")
    audio_tracks = [track for track in tracks if track["kind"] == "audio"]
    audible = [clip for track in audio_tracks for clip in rows(track, "clips") if active_clip(track, clip)]
    issues = []
    if strict and (len(tracks) != 2 or len(audio_tracks) != 1 or len(audio_tracks[0]["clips"]) != 1
                   or timeline.get("overlays")):
        issues.append("Published group requires one visual track, one soundtrack clip and no overlays.")
    expected = audio.get("asset")
    expected_version = asset_version(expected, "delivery.audio.asset", "audio") if expected is not None else None
    for clip in audible:
        resource = clip["resource"]
        title = resource.get("title") or clip.get("id")
        actual = asset_version(resource.get("asset"), f"Audio clip {title!r}", "audio")
        if actual != expected_version:
            issues.append(f"Audio clip {title!r} (asset {actual[0]} revision {actual[1]}) is not the planned delivery track.")
    if strict:
        if len(audible) != 1:
            issues.append(f"Published group needs one active delivery audio clip, found {len(audible)}.")
        else:
            clip = audible[0]
            if (clip.get("start") not in (None, 0) or clip["inPoint"] != 0 or clip.get("speed", 1) != 1
                    or clip.get("volume", 1) != 1
                    or abs(clip["outPoint"] - total_frames / fps) > 1 / fps):
                issues.append(f"Delivery audio must start at zero, end within one frame of {total_frames}, and keep normal speed and volume.")
    elif expected_version is not None and not audible:
        issues.append("The planned delivery audio track is missing or muted.")
    return issues


def check_run(
    plan: dict[str, object], snapshot: dict[str, object], run_id: str, fps: int, audio: dict[str, object],
) -> list[str]:
    group = saved_object(snapshot, "canvasItems", run_id, "group")
    assembly = object_fields(group.get("assembly"), f"Group {run_id} assembly")
    timeline = saved_timeline(snapshot, assembly.get("timelineItemId"))
    issues = []
    if timeline.get("fps") != fps:
        issues.append(f"Saved timeline FPS is {timeline.get('fps')}, expected {fps}.")
    source_only = plan["sourceOnly"]
    published = group.get("runPlan")
    if published is not None:
        saved_entries = rows(published, "entries")
        actual = [(entry["kind"], [entry["sourceStart"], entry["sourceEnd"]]) for entry in saved_entries]
        planned = [(entry["owner"], entry["source"]) for entry in rows(plan, "timeline")]
        if actual != planned:
            issues.append("Published group ranges or their source/generated ownership differ from the frame plan.")
        if published.get("frameCount") != plan["totalFrames"] or published.get("fps") != fps:
            issues.append("Published group frame count or FPS differs from the frame plan.")
    elif source_only:
        ranges = ", ".join(describe_range(interval) for interval in source_only)
        issues.append(f"Published group cannot preserve source-only ranges {ranges} without a saved runPlan. Publish the group with group.publishRun.")
    clips = rows(assembly, "clips")
    expected = [entry for entry in rows(plan, "timeline") if entry["owner"] == "generated"]
    segments = {segment["id"]: segment for segment in rows(plan, "segments")}
    if published is None and any(segments[entry["segment"]].get("independent") is True for entry in expected):
        issues.append("Published group cannot mix independent shots and guided continuations without a saved runPlan. Publish the group with group.publishRun.")
    frames = sum(clip["outFrame"] - clip["inFrame"] for clip in clips)
    if published is not None:
        frames += sum(end - start for kind, (start, end) in actual if kind == "source")
    if frames != plan["totalFrames"]:
        issues.append(f"Group assembles {frames} frames, expected {plan['totalFrames']}.")
    if len(clips) != len(expected):
        issues.append(f"Group has {len(clips)} generated intervals, expected {len(expected)}.")
    saved_generated = [entry for entry in saved_entries if entry["kind"] == "generated"] if published is not None else []
    for number, (clip, entry) in enumerate(zip(clips, expected), 1):
        segment = segments[entry["segment"]]
        item_id = segment.get("itemId")
        if not item_id or clip["itemId"] != item_id:
            issues.append(f"Group clip {number} must bind segment {entry['segment']!r} to its planned itemId.")
        if published is not None and (number > len(saved_generated) or saved_generated[number - 1].get("itemId") != clip["itemId"]):
            issues.append(f"Group clip {number} differs from the published generation node.")
        if published is not None and number <= len(saved_generated) and "guide" in segment:
            guide = segment["guide"]
            donor = segments[guide["segment"]]
            expected_step = {"kind": "continuation", "upstreamItemId": donor.get("itemId"),
                             "sourceFrames": guide["frames"]}
            if saved_generated[number - 1].get("step") != expected_step:
                issues.append(f"Group clip {number} for {entry['segment']!r} has different published guides.")
        if [clip["inFrame"], clip["outFrame"]] != entry["keep"]:
            issues.append(f"Group clip {number} for {entry['segment']!r} trims "
                          f"{describe_range((clip['inFrame'], clip['outFrame']))}, "
                          f"expected {describe_range(entry['keep'])}.")
        reverse_limit = segment.get("reverseLimit")
        if (clip.get("reverse", False) != (reverse_limit is not None)
                or (clip.get("frameLimit") or segment["rawFrames"]) != (reverse_limit or segment["rawFrames"])):
            issues.append(f"Group clip {number} for {entry['segment']!r} has a different playback direction or frame limit.")
    issues.extend(check_audio(timeline, audio, fps, plan["totalFrames"], strict=True))
    return issues


def check_timeline(
    plan: dict[str, object], timeline: dict[str, object], fps: int, audio: dict[str, object], *, preflight: bool,
) -> list[str]:
    if timeline.get("fps") != fps:
        raise ValueError(f"Saved timeline FPS is {timeline.get('fps')}, expected {fps}.")
    issues = check_audio(timeline, audio, fps, plan["totalFrames"], strict=False)
    visual_tracks = [track for track in rows(timeline, "tracks") if track["kind"] == "visual"]
    if len(visual_tracks) != 1:
        raise ValueError("Expected a single saved visual track.")
    expected = rows(plan, "timeline")
    if preflight:
        expected = [entry for entry in expected if entry["owner"] == "source"]
    cursor = 0
    for number, (clip, entry) in enumerate(zip_longest(rows(visual_tracks[0], "clips"), expected), 1):
        label = f"Timeline clip {number}"
        if entry is None:
            issues.append(f"{label} is unexpected ({clip['resource'].get('title')!r}).")
            continue
        start, end = entry["source"]
        if clip is None:
            issues.append(f"{label} is missing planned {entry['owner']} range {describe_range((start, end))}.")
            continue
        actual = asset_version(clip["resource"].get("asset"), label, "video")
        planned = asset_version(entry.get("asset"), f"Plan interval {describe_range((start, end))} asset", "video")
        if actual != planned:
            issues.append(f"{label} ({describe_range((start, end))}) uses asset {actual[0]} revision {actual[1]}, "
                          f"expected {planned[0]} revision {planned[1]} with its saved fingerprint.")
        in_frame = seconds_to_frames(clip["inPoint"], fps, f"{label} inPoint")
        out_frame = seconds_to_frames(clip["outPoint"], fps, f"{label} outPoint")
        expected_in = entry.get("assetInFrame", entry.get("keep", (start,))[0])
        if type(expected_in) is not int or expected_in < 0:
            raise ValueError(f"assetInFrame for {describe_range((start, end))} must be a nonnegative integer.")
        if [in_frame, out_frame] != [expected_in, expected_in + end - start] or clip.get("speed", 1) != 1:
            issues.append(f"{label} trims {describe_range((in_frame, out_frame))}, expected "
                          f"{describe_range((expected_in, expected_in + end - start))} at normal speed.")
        if not preflight and cursor != start:
            issues.append(f"{label} starts at frame {cursor}, expected {start} ({cursor - start:+d} frames).")
        cursor += out_frame - in_frame
    if not preflight and cursor != plan["totalFrames"]:
        issues.append(f"Saved timeline has {cursor} frames, expected {plan['totalFrames']}.")
    return issues


def probe_output(path: Path, fps: int, total_frames: int, audio: dict[str, object]) -> None:
    command = [
        "ffprobe", "-v", "error", "-count_frames", "-show_entries",
        "stream=codec_type,avg_frame_rate,nb_read_frames", "-of", "json", "-i", str(path.resolve()),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode or result.stderr.strip():
        raise ValueError(f"Could not decode output {path}: {result.stderr.strip() or result.returncode}.")
    streams = json.loads(result.stdout)["streams"]
    video = [stream for stream in streams if stream["codec_type"] == "video"]
    if len(video) != 1 or video[0].get("nb_read_frames") != str(total_frames):
        actual = [stream.get("nb_read_frames") for stream in video]
        raise ValueError(f"Output video frame counts {actual}, expected one stream with {total_frames} frames.")
    actual_fps = video[0].get("avg_frame_rate", "")
    if actual_fps in ("", "0/0") or Fraction(actual_fps) != fps:
        raise ValueError(f"Output video frame rate {actual_fps}, expected {fps} FPS.")
    audio_streams = [stream for stream in streams if stream["codec_type"] == "audio"]
    if audio.get("asset") is not None and len(audio_streams) != 1:
        raise ValueError(f"Output must contain one delivery audio stream, found {len(audio_streams)}.")


def check_soundtrack_asset(path: Path, audio: dict[str, object]) -> None:
    _, _, fingerprint = asset_version(audio.get("asset"), "delivery.audio.asset", "audio")
    with path.open("rb") as stream:
        actual = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != fingerprint:
        raise ValueError(f"{path} does not match the planned soundtrack fingerprint.")


def decoded_frame_count(source: Path) -> int:
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=nb_read_frames",
        "-of", "default=noprint_wrappers=1:nokey=1", "-i", str(source.resolve()),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise ValueError("Install ffprobe to check the normalized source with --normalized-source.") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or f"exit code {error.returncode}"
        raise ValueError(f"ffprobe failed to decode {source}: {detail}") from error

    count = result.stdout.strip()
    if not count.isdecimal() or int(count) <= 0:
        raise ValueError(f"ffprobe reported no decoded frame count for the first video stream in {source}.")
    return int(count)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path, help="JSON frame plan to validate")
    parser.add_argument("--inspection", type=Path, help="JSON shot inspection used to verify source ownership")
    parser.add_argument("--normalized-source", type=Path, help="Normalized video used to verify totalFrames")
    parser.add_argument("--project-snapshot", type=Path, help="Saved output of opendirector project show")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--run-id", help="Check the saved published group before generation")
    target.add_argument("--timeline-id", help="Check the saved timeline canvas item")
    parser.add_argument("--preflight", action="store_true", help="Check the mixed timeline's saved source-only clips before generation")
    parser.add_argument("--soundtrack", type=Path, help="Verify the downloaded soundtrack against its planned fingerprint")
    parser.add_argument("--output", type=Path, help="Check the exact rendered file against the saved timeline and delivery")
    parser.add_argument("--enforce-window-limit", action="store_true",
                        help="Reject generation windows longer than six seconds.")
    args = parser.parse_args()
    if bool(args.project_snapshot) != bool(args.run_id or args.timeline_id):
        parser.error("--project-snapshot requires --run-id or --timeline-id, and vice versa")
    if args.preflight and not args.timeline_id:
        parser.error("--preflight requires --timeline-id")
    if args.soundtrack and not args.run_id:
        parser.error("--soundtrack requires --run-id")
    if args.output and (not args.timeline_id or args.preflight):
        parser.error("--output requires a completed --timeline-id check")
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8-sig"))
        inspection = None
        if args.inspection is not None:
            inspection = json.loads(args.inspection.read_text(encoding="utf-8-sig"))
            if not isinstance(inspection, dict):
                raise ValueError("The shot inspection must be a JSON object.")
        frames, intervals = validate_plan(plan, inspection, enforce_window_limit=args.enforce_window_limit)
        if args.normalized_source is not None:
            decoded = decoded_frame_count(args.normalized_source)
            if decoded != frames:
                raise ValueError(f"Normalized source decodes to {decoded} frames. Plan totalFrames is {frames}.")
        if args.project_snapshot:
            fps, audio = read_delivery(plan)
            snapshot = object_fields(json.loads(args.project_snapshot.read_text(encoding="utf-8-sig")), "Project snapshot")
            if args.run_id:
                issues = check_run(plan, snapshot, args.run_id, fps, audio)
                if args.soundtrack and not audio.get("asset"):
                    issues.append("--soundtrack requires a planned delivery.audio.asset.")
            else:
                timeline = saved_timeline(snapshot, args.timeline_id)
                issues = check_timeline(plan, timeline, fps, audio, preflight=args.preflight)
            if issues:
                raise ValueError("\n" + "\n".join(f"- {issue}" for issue in issues))
            if args.soundtrack:
                check_soundtrack_asset(args.soundtrack, audio)
            if args.output:
                probe_output(args.output, fps, frames, audio)
    except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError) as error:
        print(f"Invalid frame plan. {error}", file=sys.stderr)
        return 1
    print(f"Frame plan verified: {frames} frames across {intervals} timeline intervals.")
    if args.project_snapshot:
        print("Saved assembly inputs match the plan." if args.run_id or args.preflight else "Saved timeline matches the plan.")
    if args.output:
        print(f"Rendered output verified at {fps} FPS with {frames} frames.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
