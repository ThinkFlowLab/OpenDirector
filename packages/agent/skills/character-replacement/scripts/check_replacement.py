#!/usr/bin/env python3
"""Build prompts from inspected source tracks and verify the saved execution inputs."""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from build_head_prompts import build_prompt
from validate_frame_plan import asset_version, check_run, decoded_frame_count, validate_plan


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def fingerprint(path):
    with path.open("rb") as stream:
        return "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()


def audio_span(path):
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=start_time,duration:format=format_name", "-of", "json", str(path),
    ]))
    if not info["streams"]:
        return None
    stream = info["streams"][0]
    start = 0.0 if "start_time" not in stream and info["format"]["format_name"] == "wav" else float(stream["start_time"])
    return start, start + float(stream["duration"])


def build_replacement(plan, inspection, options):
    validate_plan(plan, inspection, enforce_window_limit=True)
    tracks = inspection["identityMap"]
    if not isinstance(tracks, dict) or not tracks:
        raise ValueError("identityMap must map source track IDs to their cue and pinned portrait.")
    for track, info in tracks.items():
        asset_version(info["portrait"], f"identityMap.{track}.portrait", "image")
        if not isinstance(info.get("cue"), str) or not info["cue"].strip():
            raise ValueError(f"Track {track!r} needs a verified source-person cue.")

    shots = inspection["shots"]
    for shot in shots:
        start, end = shot["source"]
        evidence = shot["trackFrames"]
        if set(evidence) != set(shot["selectedTracks"]) or not set(evidence) <= tracks.keys():
            raise ValueError(f"Shot {shot['source']} needs confirming frames for exactly its selected tracks.")
        for track, frame in evidence.items():
            if type(frame) is not int or not start <= frame < end:
                raise ValueError(f"Shot {shot['source']} has an out-of-range evidence frame for {track!r}.")

    def visible_at(frame):
        declared = next(set(shot["selectedTracks"]) for shot in shots
                        if shot["source"][0] <= frame < shot["source"][1])
        evidence = inspection["frameTracks"].get(str(frame))
        if not isinstance(evidence, list) or not set(evidence) <= declared:
            raise ValueError(f"Inspect source frame {frame} and list its identifiable tracks in frameTracks.")
        return set(evidence)

    if set(options) != {segment["id"] for segment in plan["segments"]}:
        raise ValueError("Prompt options must cover exactly the planned segment IDs.")

    prompts, inputs = {}, {}
    for segment in plan["segments"]:
        segment_id = segment["id"]
        start, end = segment["source"]
        reverse = "reverseLimit" in segment
        first = end - 1 if reverse else start
        ordered_shots = [shot for shot in shots if shot["source"][0] < end and start < shot["source"][1]]
        ordered_tracks = segment["portraits"]
        required = {track for shot in ordered_shots for track in shot["selectedTracks"]}
        if not ordered_tracks or len(set(ordered_tracks)) != len(ordered_tracks) or set(ordered_tracks) != required:
            raise ValueError(f"Segment {segment_id}: portraits must list exactly its visible source track IDs in binding order.")
        visible = visible_at(first)
        if not visible:
            raise ValueError(f"Segment {segment_id}: first input frame {first} has no identifiable assigned person.")
        guided = "guide" in segment
        if guided:
            second = first - 21 if reverse else first + 21
            retained = [row["source"] for row in plan["timeline"] if row.get("segment") == segment_id]
            assigned = {track for shot in ordered_shots for left, right in retained
                        if shot["source"][0] < right and left < shot["source"][1] for track in shot["selectedTracks"]}
            missing = assigned - (visible | visible_at(second))
            if missing:
                raise ValueError(f"Segment {segment_id}: guides at {first} and {second} miss {sorted(missing)}.")
        spec = dict(options[segment_id])
        if {"tracks", "shotSubjects", "timelineGuides"} & spec.keys():
            raise ValueError(f"Segment {segment_id}: tracks, shotSubjects and timelineGuides come from the inspection and plan.")
        occluder = spec.get("foregroundOccluder")
        if occluder and not any(row.get("object") == occluder and row["track"] in required and
                                any(start <= frame < end and row["source"][0] <= frame < row["source"][1]
                                    for frame in row.get("evidenceFrames", []))
                                for row in inspection["occludedFaceRanges"]):
            raise ValueError(f"Segment {segment_id}: {occluder!r} lacks an in-window occlusion evidence frame.")
        if reverse:
            ordered_shots.reverse()
        spec.update(
            tracks=[tracks[track]["cue"] for track in ordered_tracks],
            shotSubjects=[[index for index, track in enumerate(ordered_tracks, 1) if track in shot["selectedTracks"]]
                          for shot in ordered_shots],
            timelineGuides=guided,
        )
        prompts[segment_id] = build_prompt(spec)
        inputs[segment_id] = spec
    return prompts, inputs


def check_media(plan, master, options):
    fps = plan["delivery"]["fps"]
    audio = audio_span(master)
    for segment in plan["segments"]:
        segment_id = segment["id"]
        path = Path(segment["clip"])
        count = decoded_frame_count(path)
        if count != segment["rawFrames"]:
            raise ValueError(f"Segment {segment_id}: decoded {count} frames, expected {segment['rawFrames']}.")
        if "video" in segment and fingerprint(path) != segment["video"]["fingerprint"]:
            raise ValueError(f"Segment {segment_id}: checked clip bytes differ from the planned pinned video.")
        start, end = (frame / fps for frame in segment["source"])
        expected = max(0, min(end, audio[1]) - max(start, audio[0])) if audio else 0
        clip_audio = audio_span(path)
        actual = clip_audio[1] - clip_audio[0] if clip_audio else 0
        if bool(clip_audio) != options[segment_id]["sourceAudio"] or abs(expected - actual) > 0.022:
            raise ValueError(f"Segment {segment_id}: audio has {actual:.3f}s, expected {expected:.3f}s of real source audio.")
        if clip_audio and abs(clip_audio[0]) > 1 / fps:
            raise ValueError(f"Segment {segment_id}: audio starts at {clip_audio[0]:.3f}s after cutting.")


def check_saved(plan, inspection, prompts, snapshot, run_id):
    if run_id:
        group = next((item for item in snapshot["canvasItems"] if item["id"] == run_id), None)
        if not group or not group.get("runPlan") or group["runPlan"]["source"]["fingerprint"] != inspection["sourceFingerprint"]:
            raise ValueError("Published Run must reference the inspected normalized source.")
        fps, audio = plan["delivery"]["fps"], plan["delivery"]["audio"]
        problems = check_run(plan, snapshot, run_id, fps, audio)
        if problems:
            raise ValueError("\n".join(problems))
    items = {item["id"]: item for item in snapshot["canvasItems"]}
    specs = {spec["id"]: spec for spec in snapshot["generationSpecs"]}
    segments = {segment["id"]: segment for segment in plan["segments"]}
    for segment_id, segment in segments.items():
        spec = specs[items[segment["itemId"]]["binding"]["objectRef"]["id"]]
        if spec["prompt"] != prompts[segment_id]:
            raise ValueError(f"Segment {segment_id}: saved prompt differs from the inspected-track prompt.")
        refs = sorted((ref for ref in snapshot["references"] if ref["targetSpecId"] == spec["id"]
                       and ref["active"]), key=lambda ref: ref["order"])
        portraits = [ref["source"] for ref in refs if ref["binding"] == "pinned" and ref["source"]["kind"] == "image"]
        expected = [inspection["identityMap"][track]["portrait"] for track in segment["portraits"]]
        if portraits != expected:
            raise ValueError(f"Segment {segment_id}: saved ordered portraits differ from track bindings.")
        videos = [ref["source"] for ref in refs if ref["binding"] == "pinned" and ref["source"]["kind"] == "video"]
        if videos != [segment["video"]]:
            raise ValueError(f"Segment {segment_id}: saved pinned video differs from the checked clip.")
        guide = segment.get("guide")
        params = spec["parameters"].get("h3Segment")
        if params is None or params.get("sourceFrames") != (guide["frames"] if guide else None):
            raise ValueError(f"Segment {segment_id}: saved generation spec has different guide indices.")
        if guide:
            donor = segments[guide["segment"]]["itemId"]
            if not any(ref["id"] == params.get("guideReferenceId") and ref["binding"] == "follow_current"
                       and ref["source"]["id"] == donor for ref in refs):
                raise ValueError(f"Segment {segment_id}: saved guide link differs from the planned upstream node.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("inspection", type=Path)
    parser.add_argument("options", type=Path)
    parser.add_argument("--normalized-source", type=Path, required=True)
    parser.add_argument("--check-clips", action="store_true")
    parser.add_argument("--project-snapshot", type=Path)
    parser.add_argument("--soundtrack", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--prompt-inputs", type=Path)
    args = parser.parse_args()
    if args.run_id and not args.project_snapshot:
        parser.error("--run-id requires --project-snapshot")
    try:
        plan, inspection, options = map(read_json, (args.plan, args.inspection, args.options))
        if fingerprint(args.normalized_source) != inspection["sourceFingerprint"]:
            raise ValueError("Inspection belongs to a different normalized source.")
        if decoded_frame_count(args.normalized_source) != plan["totalFrames"]:
            raise ValueError("Decoded source frame count differs from the frame plan.")
        prompts, inputs = build_replacement(plan, inspection, options)
        if args.prompt_inputs:
            args.prompt_inputs.write_text(json.dumps(inputs, ensure_ascii=False, indent=2), encoding="utf-8")
        if args.check_clips or args.project_snapshot:
            check_media(plan, args.normalized_source, options)
        if args.soundtrack:
            actual = audio_span(args.soundtrack)
            source = audio_span(args.normalized_source)
            planned = plan["delivery"]["audio"]["asset"]["fingerprint"]
            if (not actual or not source or abs(actual[1] - actual[0] - (source[1] - source[0])) > 0.022
                    or fingerprint(args.soundtrack) != planned):
                raise ValueError("Saved delivery soundtrack must match the inspected source audio without padding.")
        if args.project_snapshot:
            check_saved(plan, inspection, prompts, read_json(args.project_snapshot), args.run_id)
            print(f"Saved replacement inputs verified for {len(prompts)} segment(s).", file=sys.stderr)
        print(json.dumps(prompts, indent=2, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Replacement preflight failed: {error}\n")


if __name__ == "__main__":
    main()
