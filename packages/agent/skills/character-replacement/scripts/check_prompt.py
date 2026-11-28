"""Check H3 character replacement prompt structure or exact wording against an approved baseline."""

import argparse
import json
import re
from itertools import zip_longest
from pathlib import Path


SHOT = re.compile(r"\[(?:Shot\s+|镜头\s*)(\d+)\]", re.IGNORECASE)
LINK = r"<Subject \d+>\s*->\s*<Picture \d+>"
MAPPING = re.compile(rf"(?:{LINK})(?:\s*,\s*{LINK})*\.?")
TIMECODE = re.compile(r"(?<!\d)(?:\d{1,2}:)?\d{1,2}:[0-5]\d(?:[.,]\d+)?(?!\d)")


HEADERS = (
    "subject_definitions:", "summary:", "retention_analysis:",
    "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
)
SUBJECT_PREFIX = re.compile(r"<Subject ([1-9][0-9]*)>: (\S.*)")
VIDEO_PREFIX = re.compile(r"<Video 1>: (\S.*)")


def structure_errors(prompt: str):
    lines = [line for line in prompt.splitlines() if line.strip()]
    positions = [i for i, line in enumerate(lines) if line.strip() in HEADERS]
    if tuple(lines[i] for i in positions) != HEADERS or positions[0] != 0:
        yield "keep the six exact section headers in order"
        return

    sections = {lines[start]: lines[start + 1:end]
                for start, end in zip(positions, positions[1:] + [len(lines)])}
    for header, body in sections.items():
        if not body:
            yield f"{header} needs content"

    subject_counts = []
    for header in ("subject_definitions:", "retention_analysis:"):
        body = sections[header]
        if not body:
            continue
        rows = [SUBJECT_PREFIX.fullmatch(line) for line in body[:-1]]
        if (not rows or any(not row or int(row[1]) != i for i, row in enumerate(rows, 1))
                or not VIDEO_PREFIX.fullmatch(body[-1])):
            yield f"{header} requires consecutive <Subject N>: rows followed by exactly one <Video 1>: row"
        subject_counts.append(len(rows))
    if len(subject_counts) == 2 and len(set(subject_counts)) != 1:
        yield "use the same subject rows in subject_definitions: and retention_analysis:"


def errors(prompt: str):
    yield from structure_errors(prompt)
    expected_shot = 1
    for number, line in enumerate(prompt.splitlines(), 1):
        if TIMECODE.search(line):
            yield f"line {number}: move timecodes to the segment plan"
        markers = list(SHOT.finditer(line))
        if not markers:
            continue
        marker = markers[0]
        body = line[marker.end():].strip()
        unassigned = "No assigned person is visible."
        if (len(markers) != 1 or line[:marker.start()].strip()
                or (body != unassigned and not MAPPING.fullmatch(body))):
            yield f"line {number}: use a track-to-picture mapping or the fixed unassigned-shot sentence"
        elif int(marker.group(1)) != expected_shot:
            yield f"line {number}: expected [Shot {expected_shot}], found {marker.group(0)}"
        expected_shot += 1


def read_prompts(path: Path) -> dict[str, str]:
    content = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() != ".json":
        return {"prompt": content}
    prompts = json.loads(content)
    if not isinstance(prompts, dict) or not prompts or not all(isinstance(p, str) for p in prompts.values()):
        raise ValueError(f"{path}: expected a nonempty object of segment IDs and prompt strings")
    return prompts


def baseline_errors(actual: dict[str, str], expected: dict[str, str]):
    for segment in sorted(expected.keys() - actual.keys()):
        yield f"{segment}: missing segment"
    for segment in sorted(actual.keys() - expected.keys()):
        yield f"{segment}: unexpected segment"
    for segment in sorted(actual.keys() & expected.keys()):
        actual_lines = actual[segment].split("\n")
        expected_lines = expected[segment].split("\n")
        for number, (found, approved) in enumerate(zip_longest(actual_lines, expected_lines), 1):
            if found != approved:
                yield f"{segment}: line {number} differs\n  expected {approved!r}\n  found    {found!r}"
                break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompts", type=Path, help="A prompt text file or a .json map of segment IDs to prompt strings")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--template-only", action="store_true", help="Check the fixed headers and subject rows only")
    mode.add_argument("--expected", type=Path, help="Require exact wording from an independently approved text or JSON baseline")
    args = parser.parse_args()
    try:
        prompts = read_prompts(args.prompts)
        if args.expected:
            problems = list(baseline_errors(prompts, read_prompts(args.expected)))
        else:
            check = structure_errors if args.template_only else errors
            problems = [f"{segment}: {issue}" for segment, prompt in prompts.items() for issue in check(prompt)]
    except (OSError, ValueError) as error:
        parser.error(str(error))
    if problems:
        parser.exit(1, "\n".join(problems) + "\n")
    print(f"PASS: {len(prompts)} prompt(s)")


if __name__ == "__main__":
    main()
