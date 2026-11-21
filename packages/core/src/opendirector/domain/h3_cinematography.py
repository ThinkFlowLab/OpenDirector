"""MiniMax-H3 cinematography vocabulary, prompt compiler, and shot-plan linter.

Pure domain logic shared by Agent tools, CLI subcommands, and tests. It encodes
the official H3 prompt grammar across T2VA, I2VA, FL2VA, L2VA, and Ref2VA, plus
H3's per-modality reference numbering and 17n+5 frame-grid rules.
"""
from __future__ import annotations

import re
from typing import Any

from opendirector.domain.projects import ProjectError

H3_MIN_DURATION = 4.0
H3_MAX_DURATION = 15.0
H3_DEFAULT_FPS = 24

H3_MODES = ("t2va", "i2va", "fl2va", "l2va", "ref2va")

H3_STYLES = (
    "Live-action, cinematic",
    "Cinematic",
    "live-action",
    "2D-animated",
    "3D CG",
    "claymation",
    "watercolor",
    "vintage film",
)

SHOT_SIZES = (
    "extreme wide shot",
    "wide shot",
    "medium-wide shot",
    "medium shot",
    "medium close-up",
    "close shot",
    "close-up",
    "extreme close-up",
    "over-the-shoulder shot",
    "two-shot",
    "low-angle shot",
    "high-angle shot",
    "overhead shot",
    "bird's-eye shot",
)

CAMERA_MOTIONS: dict[str, str] = {
    "Zoom In": "zooms in",
    "Zoom Out": "zooms out",
    "Push In": "pushes in",
    "Pull Out": "pulls out",
    "Pan Left": "pans left",
    "Pan Right": "pans right",
    "Truck Left": "trucks left",
    "Truck Right": "trucks right",
    "Tilt Up": "tilts up",
    "Tilt Down": "tilts down",
    "Pedestal Up": "pedestals up",
    "Pedestal Down": "pedestals down",
    "Arc Shot": "moves in an arc shot",
    "Tracking Shot": "tracks in a tracking shot",
    "Static Shot": "holds a static shot",
    "Shake Slightly": "shakes slightly",
    "Shake Strongly": "shakes strongly",
    "POV": "frames from a first-person POV",
    "Roll Clockwise": "rolls clockwise",
    "Roll Counterclockwise": "rolls counterclockwise",
}

CAMERA_AMPLITUDES: dict[str, str] = {
    "small": "with small amplitude",
    "medium": "",
    "large": "with large amplitude",
}

CAMERA_SPEEDS: dict[str, str] = {
    "slow": "at slow speed",
    "normal": "",
    "fast": "at fast speed",
}

CUT_TRANSITIONS = (
    "the camera cuts to",
    "the shot cuts to",
    "the shot transitions to",
    "the shot changes to",
    "the shot switches to",
    "cross-dissolves to",
    "fades to",
    "wipes to",
)

REF2VA_TASK_TYPES = (
    "keyframe completion",
    "reference generation",
    "video editing",
    "video continuation",
    "audio reuse",
    "audio reference",
)

VISUAL_RETENTION_MARKERS = (
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
)

AUDIO_RETENTION_MARKERS = (
    "fully_copy",
    "partially_copy",
    "reference",
    "weak_reference",
)

BASE_SECTIONS = (
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
)

REF2VA_SECTIONS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)

_SHOT_HEADER_RE = re.compile(r"\[Shot (\d+)\]")
_CUT_TIME_RE = re.compile(r"^\s*At (\d{2}):(\d{2}\.\d{3}),\s*")
_SPEAKER_ID_RE = re.compile(r"\(S\d+(?:,S\d+)*\)")
_DIALOGUE_BLOCK_RE = re.compile(r"<d>(.*?)</d>", re.S)
_DIALOGUE_LANG_RE = re.compile(r"^\s*\[[^\[\]\n]+\]\s+\S", re.S)
_TAG_RE = re.compile(r"<(Subject|Picture|Video|Audio) (\d+)>")
_ABSTRACT_TAG_RE = re.compile(r"\b(?:8k|4k\s*uhd|masterpiece|best quality|unreal engine|photorealistic|trending on artstation)\b", re.I)
_PSEUDO_PARAM_RE = re.compile(
    r"(?:(?<!\w)--(?:ar|aspect|v|version|fps|cfg|seed|steps|stylize|chaos|q|quality|iw|no)\b"
    r"|<lora:[^>\n]+>"
    r"|\([A-Za-z0-9 _-]+:\d+(?:\.\d+)?\)"
    r"|\b(?:cfg_scale|num_frames|guidance_scale|fps|aspect_ratio)\s*=\s*\S+)",
    re.I,
)

OPPOSING_CAMERA_MOTIONS: tuple[tuple[str, str], ...] = (
    ("Zoom In", "Zoom Out"),
    ("Push In", "Pull Out"),
    ("Pan Left", "Pan Right"),
    ("Truck Left", "Truck Right"),
    ("Tilt Up", "Tilt Down"),
    ("Pedestal Up", "Pedestal Down"),
    ("Roll Clockwise", "Roll Counterclockwise"),
    ("Shake Slightly", "Shake Strongly"),
)
MOVING_CAMERA_MOTIONS: frozenset[str] = frozenset(
    key for key in CAMERA_MOTIONS if key not in {"Static Shot", "POV"}
)

_CAMERA_MOTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (
        canonical,
        re.compile(
            r"(?<![A-Za-z])(?:"
            + "|".join(
                re.escape(phrase)
                for phrase in sorted({canonical, verb}, key=len, reverse=True)
            )
            + r")(?![A-Za-z])",
            re.I,
        ),
    )
    for canonical, verb in sorted(
        CAMERA_MOTIONS.items(),
        key=lambda item: max(len(item[0]), len(item[1])),
        reverse=True,
    )
)


def strip_dialogue_blocks(text: str) -> str:
    """Replace verbatim <d>...</d> spoken lines with spaces before structural scanning."""
    return _DIALOGUE_BLOCK_RE.sub(" ", text or "")


def detect_camera_motions(text: str) -> list[str]:
    """Return canonical H3 camera motions detected outside dialogue blocks in appearance order."""
    scrubbed = strip_dialogue_blocks(text)
    hits: list[tuple[int, str]] = []
    occupied: list[tuple[int, int]] = []
    for canonical, pattern in _CAMERA_MOTION_PATTERNS:
        for match in pattern.finditer(scrubbed):
            start, end = match.span()
            if any(not (end <= s or start >= e) for s, e in occupied):
                continue
            occupied.append((start, end))
            hits.append((start, canonical))
    hits.sort(key=lambda pair: pair[0])
    ordered: list[str] = []
    for _, canonical in hits:
        if canonical not in ordered:
            ordered.append(canonical)
    return ordered


def h3_frame_grid(duration_seconds: float, fps: int = H3_DEFAULT_FPS) -> dict[str, int | float]:
    """Compute H3's 17n+5 latent frame grid for a 4-15s clip."""
    seconds = float(duration_seconds)
    if not H3_MIN_DURATION <= seconds <= H3_MAX_DURATION:
        raise ProjectError(f"MiniMax-H3 视频时长必须在 {H3_MIN_DURATION:g} 到 {H3_MAX_DURATION:g} 秒之间。", 422)
    if fps <= 0:
        raise ProjectError("帧率必须大于 0。", 422)
    requested = round(seconds * fps)
    frames = requested + (5 - requested) % 17
    vllm_omni_frames = 17 * min(max(round((seconds * fps - 5) / 17), 6), 20) + 5
    return {
        "durationSeconds": round(seconds, 4),
        "fps": fps,
        "requestedFrames": requested,
        "gridFrames": frames,
        "vllmOmniFrames": vllm_omni_frames,
        "effectiveGridSeconds": round(frames / fps, 4),
    }


def h3_reference_ordinals(sources: list[dict[str, Any]] | tuple[dict[str, Any], ...]) -> list[dict[str, Any]]:
    """Compute H3 per-modality tags matching fasth3.native_prompt's audio offset.

    FastH3 reserves `<Audio 1..K>` for embedded soundtracks of reference videos
    (`hasAudio=True`) in source order before numbering standalone audio files, and
    `CreationGeneration.task` deduplicates transmitted references by `assetId`.
    """
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in sources:
        raw_id = str(item.get("id") or "")
        if raw_id:
            if raw_id in seen_ids:
                continue
            seen_ids.add(raw_id)
        deduped.append(item)

    audio_offset = sum(
        item.get("kind") == "video" and bool(item.get("hasAudio"))
        for item in deduped
    )
    counts: dict[str, int] = {}
    embedded_audio_index = 0
    assigned: list[dict[str, Any]] = []
    for item in deduped:
        kind = str(item.get("kind") or "")
        counts[kind] = counts.get(kind, 0) + 1
        tag = None
        embedded_audio_tag = None
        if kind == "image":
            tag = f"<Picture {counts[kind]}>"
        elif kind == "video":
            tag = f"<Video {counts[kind]}>"
            if bool(item.get("hasAudio")):
                embedded_audio_index += 1
                embedded_audio_tag = f"<Audio {embedded_audio_index}>"
        elif kind == "audio":
            tag = f"<Audio {counts[kind] + audio_offset}>"
        assigned.append({
            "id": str(item.get("id") or ""),
            "name": str(item.get("name") or ""),
            "kind": kind,
            "role": item.get("role"),
            "hasAudio": bool(item.get("hasAudio")),
            "tag": tag,
            "embeddedAudioTag": embedded_audio_tag,
        })
    return assigned


def format_cut_timestamp(seconds: float) -> str:
    if seconds <= 0:
        raise ProjectError("Subsequent H3 shot cut timestamps must be strictly greater than 0.")
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    return f"{minutes:02d}:{remainder:06.3f}"


def format_camera_motion(
    motion: str,
    *,
    amplitude: str = "medium",
    speed: str = "normal",
    detail: str = "",
) -> str:
    """Format an H3 camera movement as a natural English sentence."""
    canonical = next((key for key in CAMERA_MOTIONS if key.lower() == motion.strip().lower()), None)
    if canonical is None:
        allowed = ", ".join(CAMERA_MOTIONS)
        raise ProjectError(f"Unsupported H3 camera motion '{motion}'. Choose one of: {allowed}.")
    amp_key = amplitude.strip().lower() if amplitude else "medium"
    speed_key = speed.strip().lower() if speed else "normal"
    if amp_key not in CAMERA_AMPLITUDES:
        raise ProjectError(f"Unsupported camera amplitude '{amplitude}'. Use small, medium, or large.")
    if speed_key not in CAMERA_SPEEDS:
        raise ProjectError(f"Unsupported camera speed '{speed}'. Use slow, normal, or fast.")
    parts = ["The camera", CAMERA_MOTIONS[canonical]]
    if canonical not in {"Static Shot", "POV"}:
        if CAMERA_AMPLITUDES[amp_key]:
            parts.append(CAMERA_AMPLITUDES[amp_key])
        if CAMERA_SPEEDS[speed_key]:
            parts.append(CAMERA_SPEEDS[speed_key])
    tail = detail.strip()
    if tail:
        tail = tail.rstrip(".")
        parts.append(tail)
    return " ".join(parts) + "."


def format_dialogue(
    speaker_id: str,
    language: str,
    text: str,
    *,
    speaker_intro: str = "The speaker",
    delivery: str = "says:",
    voiceover: bool = False,
    cross_cut: bool = False,
    cutoff: bool = False,
    closed_lips_clause: str = "while their lips remain completely closed.",
) -> str:
    """Format H3 speaker identity and verbatim <d>[Language] ...</d> dialogue."""
    sid = speaker_id.strip()
    if not sid.startswith("("):
        sid = f"({sid})"
    if not _SPEAKER_ID_RE.fullmatch(sid):
        raise ProjectError(f"Invalid H3 speaker ID '{speaker_id}'. Expected '(S1)' or '(S1,S2)'.")
    lang = language.strip().strip("[]")
    if not lang:
        raise ProjectError("Dialogue requires an explicit language tag such as 'English' or 'Chinese'.")
    spoken = text.strip()
    if not spoken:
        raise ProjectError("Dialogue text inside <d> cannot be empty.")
    markers = ""
    if cross_cut:
        markers += " <scenetrans>"
    if cutoff:
        markers += " <cutoff>"
    intro = speaker_intro.strip()
    verb = "says in an off-screen voiceover:" if voiceover else delivery.strip()
    prefix = f"{intro} {sid} {verb}".strip()
    sentence = f"{prefix} <d>[{lang}] {spoken}{markers}</d>"
    if voiceover:
        tail = closed_lips_clause.strip()
        if not tail.endswith("."):
            tail += "."
        sentence = f"{sentence} {tail}"
    return sentence


def _alignment_instruction(mode: str, final_shot: int, duration_seconds: float) -> str | None:
    if mode in {"t2va", "ref2va"}:
        return None
    if mode == "i2va":
        return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
    stamp = f"{duration_seconds:.2f}"
    if mode == "fl2va":
        return (
            "How the reference pictures align with the target video — "
            "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; "
            f"Picture 2 (from Shot {final_shot}) aligns with the {stamp}-second mark of the target video."
        )
    if mode == "l2va":
        return (
            "How the reference pictures align with the target video — "
            f"<Picture 1> (from [Shot {final_shot}]) aligns with the {stamp}-second mark of the target video."
        )
    raise ProjectError(f"Unsupported H3 mode '{mode}'.")


def _compile_shot_text(index: int, shot: dict[str, Any], *, style_prefix: str = "") -> str:
    shot_size = str(shot.get("shotSize") or "").strip()
    subject_action = str(shot.get("description") or shot.get("action") or "").strip()
    if not subject_action:
        raise ProjectError(f"Shot {index} requires a non-empty 'description' or 'action'.")

    pieces: list[str] = []
    if index == 1:
        opening_parts = [part for part in (style_prefix.strip().rstrip(","), shot_size) if part]
        if opening_parts and not subject_action.lower().startswith(tuple(p.lower() for p in opening_parts)):
            if shot_size and not shot_size.lower().startswith(("a ", "an ", "the ")):
                article = "an" if shot_size[0].lower() in "aeiou" else "a"
                framing = f"{article} {shot_size}"
            else:
                framing = shot_size
            lead = ", ".join([p for p in (style_prefix.strip().rstrip(","), framing) if p])
            first_sentence = f"{lead}: {subject_action}" if subject_action[0].isupper() else f"{lead} {subject_action}"
        else:
            first_sentence = f"{style_prefix.strip().rstrip(',')}, {subject_action}" if style_prefix else subject_action
        pieces.append(first_sentence.rstrip(".") + ".")
    else:
        at = shot.get("atSeconds")
        if at is None:
            raise ProjectError(f"Shot {index} requires 'atSeconds' (> 0 and < durationSeconds).")
        cut_phrase = str(shot.get("cutTransition") or "the camera cuts to").strip()
        if shot_size:
            article = "" if shot_size.lower().startswith(("a ", "an ", "the ")) else ("an " if shot_size[0].lower() in "aeiou" else "a ")
            pieces.append(f"At {format_cut_timestamp(float(at))}, {cut_phrase} {article}{shot_size}. {subject_action.rstrip('.')}.")
        else:
            pieces.append(f"At {format_cut_timestamp(float(at))}, {cut_phrase} {subject_action.rstrip('.')}.")

    motion = shot.get("cameraMotion")
    if motion:
        if isinstance(motion, dict):
            pieces.append(format_camera_motion(
                str(motion.get("type") or motion.get("motion") or "Static Shot"),
                amplitude=str(motion.get("amplitude") or "medium"),
                speed=str(motion.get("speed") or "normal"),
                detail=str(motion.get("detail") or ""),
            ))
        else:
            pieces.append(format_camera_motion(
                str(motion),
                amplitude=str(shot.get("cameraAmplitude") or "medium"),
                speed=str(shot.get("cameraSpeed") or "normal"),
                detail=str(shot.get("cameraDetail") or ""),
            ))

    for line in shot.get("dialogues") or ():
        pieces.append(format_dialogue(
            str(line["speakerId"]),
            str(line["language"]),
            str(line["text"]),
            speaker_intro=str(line.get("speakerIntro") or "The speaker"),
            delivery=str(line.get("delivery") or "says:"),
            voiceover=bool(line.get("voiceover", False)),
            cross_cut=bool(line.get("crossCut", False)),
            cutoff=bool(line.get("cutoff", False)),
            closed_lips_clause=str(line.get("closedLipsClause") or "while their lips remain completely closed."),
        ))

    diegetic = str(shot.get("diegeticSound") or "").strip()
    if diegetic:
        pieces.append(diegetic.rstrip(".") + ".")

    return f"[Shot {index}] " + " ".join(pieces)


def compile_h3_prompt(spec: dict[str, Any]) -> dict[str, Any]:
    """Compile structured H3 shot/reference metadata into a canonical H3 prompt."""
    mode = str(spec.get("mode") or "t2va").strip().lower()
    if mode not in H3_MODES:
        raise ProjectError(f"Unsupported H3 mode '{mode}'. Choose from {', '.join(H3_MODES)}.")
    duration = float(spec.get("durationSeconds") or 5.0)
    grid = h3_frame_grid(duration, int(spec.get("fps") or H3_DEFAULT_FPS))
    shots = list(spec.get("shots") or ())
    if not shots:
        raise ProjectError("H3 prompt compilation requires at least one shot in 'shots'.")

    style = str(spec.get("style") or "Live-action, cinematic").strip()
    soundscape = str(spec.get("overallSoundscape") or "Natural ambient room tone and subtle physical movement sounds continue throughout the scene.").strip()
    music = str(spec.get("nonDiegeticMusic") or "N/A").strip()

    if mode != "ref2va":
        compiled_shots = [
            _compile_shot_text(idx, shot, style_prefix=style if idx == 1 else "")
            for idx, shot in enumerate(shots, start=1)
        ]
        header = _alignment_instruction(mode, len(shots), duration)
        body = (
            f"integrated_multimodal_description: {' '.join(compiled_shots)}\n\n"
            f"overall_soundscape: {soundscape}\n\n"
            f"non_diegetic_music: {music}"
        )
        prompt = f"{header}\n\n{body}" if header else body
    else:
        subject_defs = [str(line).strip() for line in (spec.get("subjectDefinitions") or ()) if str(line).strip()]
        if not subject_defs:
            raise ProjectError("Ref2VA compilation requires non-empty 'subjectDefinitions'.")
        task_types = [str(item).strip() for item in (spec.get("taskTypes") or ("reference generation",)) if str(item).strip()]
        seen_types: list[str] = []
        for task_type in task_types:
            if task_type not in REF2VA_TASK_TYPES:
                raise ProjectError(f"Unsupported Ref2VA task type '{task_type}'.")
            if task_type not in seen_types:
                seen_types.append(task_type)
        summary_body = str(spec.get("summary") or "").strip()
        if not summary_body:
            raise ProjectError("Ref2VA compilation requires a 'summary' sentence.")
        if not summary_body.startswith("["):
            summary_body = f"[{' + '.join(seen_types)}] {summary_body}"

        retentions = [str(line).strip() for line in (spec.get("retentionAnalysis") or ()) if str(line).strip()]
        if not retentions:
            raise ProjectError("Ref2VA compilation requires non-empty 'retentionAnalysis'.")

        style_opening = str(spec.get("styleOpening") or f"The target video uses a {style.lower()} style.").strip()
        if not style_opening.endswith("."):
            style_opening += "."
        compiled_shots = [_compile_shot_text(idx, shot, style_prefix="") for idx, shot in enumerate(shots, start=1)]
        detailed = "\n".join([style_opening, *compiled_shots])
        prompt = (
            "subject_definitions:\n" + "\n".join(subject_defs) + "\n\n"
            "summary:\n" + summary_body + "\n\n"
            "retention_analysis:\n" + "\n".join(retentions) + "\n\n"
            "detailed_description:\n" + detailed + "\n\n"
            "overall_soundscape:\n" + soundscape + "\n\n"
            "non_diegetic_music:\n" + music
        )

    lint = lint_h3_prompt(
        prompt,
        mode=mode,
        duration_seconds=duration,
        reference_sources=spec.get("referenceSources"),
    )
    return {
        "mode": mode,
        "durationSeconds": duration,
        "frameGrid": grid,
        "prompt": prompt,
        "lint": lint,
    }


def _extract_sections(prompt: str, names: tuple[str, ...]) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    matches: list[tuple[int, int, str]] = []
    for name in names:
        pattern = re.compile(rf"(?m)^{re.escape(name)}:\s*")
        found = list(pattern.finditer(prompt))
        if not found:
            errors.append(f"Missing required section '{name}:'.")
        elif len(found) > 1:
            errors.append(f"Duplicate section '{name}:'.")
        else:
            matches.append((found[0].start(), found[0].end(), name))
    if errors:
        return {}, errors
    ordered = [name for _, _, name in sorted(matches)]
    if tuple(ordered) != names:
        errors.append(f"Sections out of order: found {ordered}, expected {list(names)}.")
        return {}, errors
    sorted_matches = sorted(matches)
    sections: dict[str, str] = {}
    for index, (_, end, name) in enumerate(sorted_matches):
        next_start = sorted_matches[index + 1][0] if index + 1 < len(sorted_matches) else len(prompt)
        sections[name] = prompt[end:next_start].strip()
    return sections, errors


def lint_h3_prompt(
    prompt: str,
    *,
    mode: str,
    duration_seconds: float,
    reference_sources: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None = None,
) -> dict[str, Any]:
    """Validate an H3 prompt against official structural, temporal, and ordinal rules."""
    normalized_mode = mode.strip().lower()
    errors: list[str] = []
    warnings: list[str] = []
    if normalized_mode not in H3_MODES:
        errors.append(f"Unsupported H3 mode '{mode}'. Choose from {', '.join(H3_MODES)}.")
        return {"valid": False, "mode": normalized_mode, "errors": errors, "warnings": warnings, "detectedShots": 0, "referencedTags": []}

    if not H3_MIN_DURATION <= float(duration_seconds) <= H3_MAX_DURATION:
        errors.append(f"Duration {duration_seconds:g}s is outside MiniMax-H3's supported {H3_MIN_DURATION:g}-{H3_MAX_DURATION:g}s range.")

    expected_sections = REF2VA_SECTIONS if normalized_mode == "ref2va" else BASE_SECTIONS
    sections, section_errors = _extract_sections(prompt, expected_sections)
    errors.extend(section_errors)

    main_field = "detailed_description" if normalized_mode == "ref2va" else "integrated_multimodal_description"
    shot_body = sections.get(main_field, "")
    shot_headers = list(_SHOT_HEADER_RE.finditer(shot_body))
    shot_numbers = [int(match.group(1)) for match in shot_headers]
    if sections and not shot_numbers:
        errors.append(f"'{main_field}' must contain at least '[Shot 1]'.")
    elif shot_numbers and shot_numbers != list(range(1, len(shot_numbers) + 1)):
        errors.append(f"Shot numbers must start at 1 and increment sequentially; found {shot_numbers}.")

    last_cut = 0.0
    for idx, match in enumerate(shot_headers, start=1):
        seg_end = shot_headers[idx].start() if idx < len(shot_headers) else len(shot_body)
        segment = shot_body[match.end():seg_end]
        cut_match = _CUT_TIME_RE.match(segment)
        if idx == 1 and cut_match:
            errors.append("[Shot 1] must not start with a cut timestamp.")
        elif idx > 1:
            if not cut_match:
                errors.append(f"[Shot {idx}] must begin with 'At MM:SS.mmm, ...'.")
            else:
                seconds = int(cut_match.group(1)) * 60 + float(cut_match.group(2))
                if seconds <= last_cut:
                    errors.append(f"[Shot {idx}] cut time ({seconds:.3f}s) must strictly exceed the previous cut ({last_cut:.3f}s).")
                if seconds >= float(duration_seconds):
                    errors.append(f"[Shot {idx}] cut time ({seconds:.3f}s) must fall strictly within duration ({duration_seconds:.2f}s).")
                last_cut = seconds

        segment_motions = set(detect_camera_motions(segment))
        for first_motion, second_motion in OPPOSING_CAMERA_MOTIONS:
            if first_motion in segment_motions and second_motion in segment_motions:
                errors.append(
                    f"[Shot {idx}] combines contradictory camera motions ({first_motion} vs {second_motion}); "
                    "split opposing movements across separate shots."
                )
        if "Static Shot" in segment_motions:
            moving = sorted(segment_motions & MOVING_CAMERA_MOTIONS)
            if moving:
                errors.append(
                    f"[Shot {idx}] combines 'Static Shot' with moving camera instruction(s) {moving}; "
                    "add a cut timestamp before moving the camera."
                )

    final_shot = max(len(shot_numbers), 1)
    expected_header = _alignment_instruction(normalized_mode, final_shot, float(duration_seconds))
    first_line = prompt.splitlines()[0].strip() if prompt.splitlines() else ""
    if expected_header is not None:
        if first_line != expected_header:
            errors.append(f"First line must match {normalized_mode.upper()} alignment header: '{expected_header}'.")
        lines = prompt.splitlines()
        if len(lines) < 2 or lines[1].strip() != "":
            errors.append("Alignment instruction must be followed by one blank line before core sections.")
    elif first_line.startswith(("For the target video,", "How the reference pictures align")):
        errors.append(f"Mode '{normalized_mode}' must not start with a keyframe alignment instruction.")

    for block in _DIALOGUE_BLOCK_RE.findall(shot_body):
        if not _DIALOGUE_LANG_RE.match(block):
            warnings.append("Dialogue block '<d>...</d>' should begin with an explicit '[Language]' tag.")
    if "says in an off-screen voiceover" in shot_body and "lips remain" not in shot_body:
        warnings.append("Off-screen voiceover should explicitly state after </d> that the on-screen character's lips remain closed.")

    scrubbed_prompt = strip_dialogue_blocks(prompt)
    pseudo_matches = sorted({m.group(0).strip() for m in _PSEUDO_PARAM_RE.finditer(scrubbed_prompt)})
    if pseudo_matches:
        errors.append(
            f"Prompt contains unsupported pseudo-parameter tag(s) {pseudo_matches}; "
            "pass aspect ratio, duration, and resolution via structured GenerationSpec parameters instead."
        )
    if _ABSTRACT_TAG_RE.search(scrubbed_prompt):
        warnings.append("Avoid stacked quality buzzwords (e.g. '8k', 'masterpiece', 'unreal engine'); describe concrete visual and acoustic facts.")

    for audio_sec in ("overall_soundscape", "non_diegetic_music"):
        val = sections.get(audio_sec, "")
        if "<d>" in val:
            errors.append(f"'{audio_sec}' must not contain '<d>' dialogue blocks; keep dialogue in '{main_field}'.")

    all_tags = [(m.group(1), int(m.group(2))) for m in _TAG_RE.finditer(prompt)]
    unique_tag_strings = sorted({f"<{kind} {num}>" for kind, num in all_tags})

    if normalized_mode == "ref2va" and sections:
        summary_val = sections["summary"]
        prefix_match = re.match(r"^\[([^\[\]]+)\]\s+\S", summary_val)
        if not prefix_match:
            errors.append("Ref2VA 'summary' must begin with '[task type] ...'.")
        else:
            raw_types = [part.strip() for part in prefix_match.group(1).split("+")]
            invalid_types = [item for item in raw_types if item not in REF2VA_TASK_TYPES]
            if invalid_types:
                errors.append(f"Ref2VA 'summary' contains unknown task types: {invalid_types}.")
            if len(set(raw_types)) != len(raw_types):
                errors.append("Ref2VA 'summary' task types must not contain duplicates.")

        retention_val = sections["retention_analysis"]
        if _SPEAKER_ID_RE.search(retention_val):
            errors.append("Ref2VA 'retention_analysis' must not include speaker IDs like '(S1)'.")
        valid_markers = set(VISUAL_RETENTION_MARKERS) | set(AUDIO_RETENTION_MARKERS)
        for line in [ln.strip() for ln in retention_val.splitlines() if ln.strip()]:
            if not any(f": {marker}" in line for marker in valid_markers):
                warnings.append(f"Retention line does not use a canonical H3 relationship marker: '{line[:80]}'.")

        defined_subjects = {
            f"<Subject {m.group(2)}>"
            for m in _TAG_RE.finditer(sections["subject_definitions"])
            if m.group(1) == "Subject"
        }
        used_subjects = {
            f"<Subject {m.group(2)}>"
            for sec_name in ("summary", "retention_analysis", "detailed_description")
            for m in _TAG_RE.finditer(sections[sec_name])
            if m.group(1) == "Subject"
        }
        undefined_subjects = sorted(used_subjects - defined_subjects)
        if undefined_subjects:
            errors.append(f"Undefined subject labels referenced outside 'subject_definitions': {undefined_subjects}.")

        if shot_headers and shot_headers[0].start() == 0:
            warnings.append("Ref2VA 'detailed_description' should establish overall visual style in 1-2 sentences before '[Shot 1]'.")

    if reference_sources is not None:
        ordinals = h3_reference_ordinals(reference_sources)
        available_tags = {
            tag
            for entry in ordinals
            for tag in (entry["tag"], entry["embeddedAudioTag"])
            if tag is not None
        }
        used_media_tags = {
            f"<{kind} {num}>"
            for kind, num in all_tags
            if kind in {"Picture", "Video", "Audio"}
        }
        missing_tags = sorted(used_media_tags - available_tags)
        if missing_tags:
            errors.append(
                f"Prompt references media tags {missing_tags} that do not match active reference ordinals {sorted(available_tags)}."
            )

    return {
        "valid": not errors,
        "mode": normalized_mode,
        "errors": errors,
        "warnings": warnings,
        "detectedShots": len(shot_numbers),
        "referencedTags": unique_tag_strings,
    }


def lint_shot_plan(shots: list[dict[str, Any]] | tuple[dict[str, Any], ...]) -> dict[str, Any]:
    """Validate a multi-shot storyboard plan for H3 bounds and visual variety."""
    errors: list[str] = []
    warnings: list[str] = []
    if not shots:
        return {
            "valid": False,
            "shotCount": 0,
            "totalDurationSeconds": 0.0,
            "shotSizeDiversity": 0.0,
            "cameraMotionDiversity": 0.0,
            "errors": ["Shot plan must contain at least one shot."],
            "warnings": [],
        }

    total_duration = 0.0
    normalized_sizes: list[str] = []
    normalized_motions: list[str] = []
    run_length = 0
    previous_pair: tuple[str, str] | None = None

    for idx, shot in enumerate(shots, start=1):
        duration = float(shot.get("durationSeconds") or 0)
        if not H3_MIN_DURATION <= duration <= H3_MAX_DURATION:
            errors.append(
                f"Shot {idx} duration ({duration:g}s) is outside MiniMax-H3's {H3_MIN_DURATION:g}-{H3_MAX_DURATION:g}s bounds."
            )
        total_duration += max(0.0, duration)

        size = str(shot.get("shotSize") or "").strip().lower()
        if not size:
            errors.append(f"Shot {idx} is missing 'shotSize'.")
        elif size not in {s.lower() for s in SHOT_SIZES}:
            warnings.append(f"Shot {idx} uses non-standard shotSize '{shot.get('shotSize')}'.")
        normalized_sizes.append(size)

        motion_raw = str(shot.get("cameraMotion") or "").strip()
        canonical_motion = next((key for key in CAMERA_MOTIONS if key.lower() == motion_raw.lower()), None)
        if not motion_raw:
            errors.append(f"Shot {idx} is missing 'cameraMotion'.")
        elif canonical_motion is None:
            errors.append(f"Shot {idx} uses unsupported H3 cameraMotion '{motion_raw}'.")
        normalized_motions.append(canonical_motion or motion_raw)

        mode = str(shot.get("mode") or "i2va").strip().lower()
        if mode not in H3_MODES and mode != "continuation":
            errors.append(f"Shot {idx} uses unsupported mode '{mode}'.")

        pair = (size, canonical_motion or motion_raw)
        if pair == previous_pair and size and motion_raw:
            run_length += 1
            if run_length >= 3:
                errors.append(
                    f"Shot {idx} repeats ({size}, {canonical_motion or motion_raw}) for {run_length} consecutive shots; vary framing or camera movement to prevent visual homogenization."
                )
        else:
            previous_pair = pair
            run_length = 1

    valid_sizes = [s for s in normalized_sizes if s]
    valid_motions = [m for m in normalized_motions if m]
    if len(shots) >= 3 and len(set(valid_sizes)) <= 1:
        errors.append("Multi-shot sequence (3+ shots) uses only a single shotSize across all shots.")
    if len(shots) >= 4 and len(set(valid_motions)) <= 1:
        warnings.append("Sequence of 4+ shots uses the same cameraMotion throughout; consider alternating static and moving shots.")

    return {
        "valid": not errors,
        "shotCount": len(shots),
        "totalDurationSeconds": round(total_duration, 3),
        "shotSizeDiversity": round(len(set(valid_sizes)) / len(shots), 3),
        "cameraMotionDiversity": round(len(set(valid_motions)) / len(shots), 3),
        "errors": errors,
        "warnings": warnings,
    }
