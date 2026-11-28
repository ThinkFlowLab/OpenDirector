#!/usr/bin/env python3
"""Build fixed-format Ref2VA prompts from structured character bindings."""

import argparse
import json
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined


PROMPT_TEMPLATE = Environment(
    loader=FileSystemLoader(Path(__file__).resolve().parent),
    autoescape=False,
    trim_blocks=True,
    lstrip_blocks=True,
    undefined=StrictUndefined,
).get_template("head_prompt.jinja")


APPEARANCE = {
    "face_only": "face",
    "head": "face, hairstyle and eyewear",
    "appearance": "face, hairstyle, clothing and worn accessories, including eyewear",
}


def is_short_phrase(value: object, limit: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value.strip()) <= limit
        and all(c.isprintable() and c not in ":<>[]{}.!?;" for c in value)
    )


def build_prompt(spec: object) -> str:
    allowed = {
        "tracks", "sourceAudio", "foregroundOccluder", "foregroundOccluderExit", "eyewear",
        "scope", "timelineGuides", "shotSubjects",
        "preservedPeople", "retainedDetails", "dialogueBinding", "portraitAppearanceOnly", "completeHairReplacement", "targetHairOutline",
    }
    if not isinstance(spec, dict):
        raise ValueError("expected a segment object")
    unknown = spec.keys() - allowed
    if unknown:
        raise ValueError(f"unknown fields: {', '.join(sorted(unknown))}")

    tracks = spec.get("tracks")
    source_audio = spec.get("sourceAudio")
    scope = spec.get("scope", "head")
    guides = spec.get("timelineGuides", False)
    eyewear = spec.get("eyewear")
    occluder = spec.get("foregroundOccluder")
    occluder_exit = spec.get("foregroundOccluderExit", False)
    preserved_people = spec.get("preservedPeople")
    retained_details = spec.get("retainedDetails")

    if not isinstance(tracks, list) or not tracks or any(
        not is_short_phrase(track, 120) for track in tracks
    ):
        raise ValueError("tracks must contain one short source-person phrase per bound picture")
    normalized_tracks = [track.strip() for track in tracks]
    if len({" ".join(track.casefold().split()) for track in normalized_tracks}) != len(tracks):
        raise ValueError("tracks must distinguish each assigned source person")
    if type(source_audio) is not bool or type(guides) is not bool:
        raise ValueError("sourceAudio and timelineGuides must be booleans")
    if not isinstance(scope, str) or scope not in APPEARANCE:
        raise ValueError("scope must be face_only, head, or appearance")
    if occluder is not None and not is_short_phrase(occluder, 48):
        raise ValueError("foregroundOccluder must be a short object name")
    if (type(occluder_exit) is not bool and occluder_exit != "lowers") or (occluder_exit and not occluder):
        raise ValueError("foregroundOccluderExit requires a named occluder and accepts true, false, or lowers")
    if eyewear is not None and (
        scope == "face_only" or not isinstance(eyewear, list)
        or len(eyewear) != len(tracks) or any(type(value) is not bool for value in eyewear)
    ):
        raise ValueError("eyewear requires one boolean per picture and a scope that replaces eyewear")
    if preserved_people is not None and (
        not isinstance(preserved_people, list)
        or not preserved_people
        or any(not is_short_phrase(person, 80) for person in preserved_people)
    ):
        raise ValueError("preservedPeople must be a nonempty list of short verified source-person cues")
    if retained_details is not None:
        if (
            not isinstance(retained_details, list)
            or len(retained_details) != len(tracks)
            or any(detail is not None and not is_short_phrase(detail, 80) for detail in retained_details)
        ):
            raise ValueError("retainedDetails must contain one short retained garment/accessory phrase or null per track")
        normalized_details = [detail.strip() if detail is not None else None for detail in retained_details]
    else:
        normalized_details = [None] * len(tracks)

    subjects = set(range(1, len(tracks) + 1))
    shots = spec.get("shotSubjects", [sorted(subjects)])
    if not isinstance(shots, list) or not shots or any(
        not isinstance(shot, list)
        or any(type(subject) is not int or subject not in subjects for subject in shot)
        or len(set(shot)) != len(shot)
        for shot in shots
    ):
        raise ValueError("shotSubjects must contain ordered shot lists of unique bound subject numbers")
    if {subject for shot in shots for subject in shot} != subjects:
        raise ValueError("shotSubjects must cover every bound subject")

    portrait_appearance_only = spec.get("portraitAppearanceOnly", False)
    if type(portrait_appearance_only) is not bool:
        raise ValueError("portraitAppearanceOnly must be a boolean")

    hair_subject = spec.get("completeHairReplacement")
    if "completeHairReplacement" in spec and (
            scope == "face_only" or type(hair_subject) is not int or hair_subject not in subjects):
        raise ValueError("completeHairReplacement requires a bound subject in a scope that replaces hair")

    hair_outline = spec.get("targetHairOutline")
    if "targetHairOutline" in spec and (
            hair_subject is not None or scope == "face_only"
            or type(hair_outline) is not int or hair_outline not in subjects):
        raise ValueError("targetHairOutline requires a bound subject and replaces the generic hair clause")

    dialogue = spec.get("dialogueBinding")
    if "dialogueBinding" in spec:
        if (not source_audio or not isinstance(dialogue, dict)
                or dialogue.keys() not in ({"shot", "subject"}, {"shot", "subject", "mouthMotion"})
                or dialogue.get("mouthMotion", "source_frame") != "source_frame"
                or type(dialogue["shot"]) is not int or not 1 <= dialogue["shot"] <= len(shots)
                or type(dialogue["subject"]) is not int
                or dialogue["subject"] not in shots[dialogue["shot"] - 1]):
            raise ValueError("dialogueBinding requires source audio and a subject assigned to the specified shot")

    return PROMPT_TEMPLATE.render(
        tracks=normalized_tracks,
        appearance=APPEARANCE[scope],
        shots=shots,
        eyewear=eyewear or [],
        occluder=occluder.strip() if occluder else None,
        occluder_exit=occluder_exit,
        preserved_people=[person.strip() for person in (preserved_people or [])],
        retained_details=normalized_details,
        guides=guides,
        source_audio=source_audio,
        dialogue=dialogue,
        hair_subject=hair_subject,
        hair_outline=hair_outline,
        portrait_appearance_only=portrait_appearance_only,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("segments", help="Segment JSON file, or - to read JSON from stdin")
    args = parser.parse_args()
    try:
        segments = (
            json.load(sys.stdin) if args.segments == "-"
            else json.loads(Path(args.segments).read_text(encoding="utf-8-sig"))
        )
        if not isinstance(segments, dict) or not segments:
            raise ValueError("expected a nonempty object keyed by segment ID")
        prompts = {}
        for segment, spec in segments.items():
            try:
                prompts[segment] = build_prompt(spec)
            except ValueError as error:
                raise ValueError(f"{segment}: {error}") from error
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(prompts, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
