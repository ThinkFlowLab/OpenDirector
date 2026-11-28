import hashlib
import json
from pathlib import Path
import subprocess
import sys
from uuid import UUID
import wave

import pytest


VALIDATOR = (Path(__file__).resolve().parents[1] / 'packages/agent/skills/character-replacement/scripts'
             / 'validate_frame_plan.py')
FPS = 24
SOURCE = {'assetId': str(UUID(int=1)), 'kind': 'video', 'revision': 1, 'fingerprint': 'sha256:' + '1' * 64}
FIRST = {'assetId': str(UUID(int=2)), 'kind': 'video', 'revision': 1, 'fingerprint': 'sha256:' + '2' * 64}
SECOND = {'assetId': str(UUID(int=3)), 'kind': 'video', 'revision': 1, 'fingerprint': 'sha256:' + '3' * 64}
SOUNDTRACK = {'assetId': str(UUID(int=4)), 'kind': 'audio', 'revision': 1, 'fingerprint': 'sha256:' + '4' * 64}
RUN_ID = str(UUID(int=10))
TIMELINE_ID = str(UUID(int=11))
EDITOR_ID = str(UUID(int=12))
FIRST_ID = str(UUID(int=13))
SECOND_ID = str(UUID(int=14))


@pytest.fixture
def mixed_plan() -> dict[str, object]:
    return {
        'totalFrames': 36,
        'sourceOnly': [[0, 6], [30, 36]],
        'delivery': {'fps': FPS, 'audio': {}},
        'segments': [
            {'id': 'first', 'source': [6, 18], 'rawFrames': 20, 'itemId': FIRST_ID},
            {'id': 'second', 'source': [18, 30], 'rawFrames': 20, 'itemId': SECOND_ID},
        ],
        'timeline': [
            {'source': [0, 6], 'owner': 'source', 'asset': SOURCE},
            {'source': [6, 18], 'owner': 'generated', 'segment': 'first', 'keep': [4, 16], 'asset': FIRST},
            {'source': [18, 30], 'owner': 'generated', 'segment': 'second', 'keep': [2, 14], 'asset': SECOND},
            {'source': [30, 36], 'owner': 'source', 'asset': SOURCE},
        ],
    }


def timeline_clip(name: str, asset: dict[str, object], start: int, end: int) -> dict[str, object]:
    return {
        'id': name,
        'resource': {'asset': dict(asset), 'title': name, 'durationSeconds': 2.0},
        'start': 0.0 if asset['kind'] == 'audio' else None,
        'inPoint': start / FPS,
        'outPoint': end / FPS,
        'speed': 1.0,
        'volume': 1.0,
        'muted': asset['kind'] != 'audio',
    }


def project_snapshot(visual_clips: list[dict[str, object]], *, soundtrack: dict[str, object] | None = None,
                     run_clips: list[dict[str, object]] | None = None,
                     soundtrack_frames: int = 36) -> dict[str, object]:
    tracks = [{'kind': 'visual', 'id': 'visual', 'title': 'Visual', 'muted': False, 'clips': visual_clips}]
    assets = [SOURCE, FIRST, SECOND]
    if soundtrack is not None:
        tracks.append({'kind': 'audio', 'id': 'audio', 'title': 'Audio', 'muted': False, 'clips': [
            timeline_clip('Original soundtrack', soundtrack, 0, soundtrack_frames),
        ]})
        assets.append(soundtrack)
    items = [{
        'id': TIMELINE_ID, 'kind': 'timeline', 'visible': True,
        'binding': {'role': 'editor', 'objectRef': {'id': EDITOR_ID, 'kind': 'timeline'}},
    }]
    if run_clips is not None:
        items.append({
            'id': RUN_ID, 'kind': 'group', 'title': 'Run', 'visible': True, 'binding': {'role': 'container'},
            'assembly': {'timelineItemId': TIMELINE_ID, 'outputItemId': str(UUID(int=15)),
                         'clips': run_clips, 'requireTimelineGuides': True, 'guideExemptItemId': FIRST_ID},
        })
        items.extend({
            'id': item_id, 'kind': 'video', 'parentId': RUN_ID, 'visible': True,
            'binding': {'role': 'generation', 'objectRef': {'id': str(UUID(int=number))}},
        } for item_id, number in ((FIRST_ID, 17), (SECOND_ID, 18)))
    return {
        'canvasItems': items,
        'editorDocuments': [{'id': EDITOR_ID, 'kind': 'timeline', 'revision': 1,
                             'data': {'fps': FPS, 'width': 32, 'height': 32, 'tracks': tracks}}],
        'assets': [{**asset, 'id': asset['assetId']} for asset in assets],
    }


def run_validator(tmp_path: Path, plan: dict[str, object], *arguments: str,
                  snapshot: dict[str, object] | None = None) -> subprocess.CompletedProcess[str]:
    plan_path = tmp_path / 'frame-plan.json'
    plan_path.write_text(json.dumps(plan), encoding='utf-8')
    command = [sys.executable, str(VALIDATOR), str(plan_path), *arguments]
    if snapshot is not None:
        snapshot_path = tmp_path / 'saved-project.json'
        snapshot_path.write_text(json.dumps(snapshot), encoding='utf-8')
        command.extend(['--project-snapshot', str(snapshot_path)])
    return subprocess.run(command, capture_output=True, text=True, check=False, timeout=30)


def test_legacy_frame_plan_without_delivery_is_still_accepted(tmp_path: Path, mixed_plan: dict[str, object]):
    del mixed_plan['delivery']
    for segment in mixed_plan['segments']:
        del segment['itemId']
    for entry in mixed_plan['timeline']:
        del entry['asset']
    result = run_validator(tmp_path, mixed_plan)
    assert result.returncode == 0, result.stderr
    assert '36 frames' in result.stdout


def test_run_preflight_reports_missing_source_ranges_and_wrong_audio(tmp_path: Path, mixed_plan: dict[str, object]):
    snapshot = project_snapshot([], soundtrack=SOUNDTRACK, soundtrack_frames=24, run_clips=[
        {'itemId': FIRST_ID, 'inFrame': 4, 'outFrame': 16, 'reverse': False},
        {'itemId': SECOND_ID, 'inFrame': 2, 'outFrame': 14, 'reverse': False},
    ])
    result = run_validator(tmp_path, mixed_plan, '--run-id', RUN_ID, snapshot=snapshot)
    assert result.returncode == 1
    assert '[0, 6)' in result.stderr and '[30, 36)' in result.stderr
    assert '24' in result.stderr and '36' in result.stderr
    assert 'Original soundtrack' in result.stderr


def test_mixed_preflight_reads_current_source_clips_before_generation(tmp_path: Path, mixed_plan: dict[str, object]):
    opening = timeline_clip('Opening', SOURCE, 0, 6)
    ending = timeline_clip('Ending', SOURCE, 30, 36)
    result = run_validator(tmp_path, mixed_plan, '--timeline-id', TIMELINE_ID, '--preflight',
                           snapshot=project_snapshot([opening, ending]))
    assert result.returncode == 0, result.stderr

    shortened = run_validator(tmp_path, mixed_plan, '--timeline-id', TIMELINE_ID, '--preflight',
                              snapshot=project_snapshot([opening]))
    assert shortened.returncode == 1
    assert '[30, 36)' in shortened.stderr


@pytest.mark.parametrize('tracks,required', [(['performer'], True), (['other performer'], False)])
def test_rewritten_plan_cannot_shift_an_inspected_required_cut(
    tmp_path: Path, mixed_plan: dict[str, object], tracks: list[str], required: bool,
):
    inspection = tmp_path / 'shot-inspection.json'
    inspection.write_text(json.dumps({'totalFrames': 36, 'shots': [
        {'source': [0, 6], 'selectedTracks': []},
        {'source': [6, 18], 'selectedTracks': ['performer']},
        {'source': [18, 30], 'selectedTracks': tracks, 'requiredTimelineCut': required},
        {'source': [30, 36], 'selectedTracks': []},
    ]}), encoding='utf-8')
    original = run_validator(tmp_path, mixed_plan, '--inspection', str(inspection))
    assert original.returncode == 0, original.stderr

    mixed_plan['segments'][1]['source'] = [16, 30]
    mixed_plan['timeline'][1].update(source=[6, 16], keep=[4, 14])
    mixed_plan['timeline'][2].update(source=[16, 30], keep=[2, 16])
    shifted = run_validator(tmp_path, mixed_plan, '--inspection', str(inspection))
    assert shifted.returncode == 1
    assert '18' in shifted.stderr and '16' in shifted.stderr and '-2 frames' in shifted.stderr


@pytest.mark.parametrize('fault', ['none', 'early cut', 'wrong version'])
def test_saved_timeline_checks_each_cut_and_frozen_asset(tmp_path: Path, mixed_plan: dict[str, object], fault: str):
    # The second generated asset has already been trimmed, unlike the first raw take.
    mixed_plan['timeline'][2]['assetInFrame'] = 0
    first_end, second_end = (14, 14) if fault == 'early cut' else (16, 12)
    second_asset = {**SECOND, 'revision': 2} if fault == 'wrong version' else SECOND
    snapshot = project_snapshot([
        timeline_clip('Opening', SOURCE, 0, 6),
        timeline_clip('First take', FIRST, 4, first_end),
        timeline_clip('Second take', second_asset, 0, second_end),
        timeline_clip('Ending', SOURCE, 30, 36),
    ])
    result = run_validator(tmp_path, mixed_plan, '--timeline-id', TIMELINE_ID, snapshot=snapshot)
    if fault == 'none':
        assert result.returncode == 0, result.stderr
    elif fault == 'early cut':
        assert result.returncode == 1
        assert 'starts at frame 16, expected 18 (-2 frames)' in result.stderr
    else:
        assert result.returncode == 1
        assert f"uses asset {SECOND['assetId']} revision 2, expected {SECOND['assetId']} revision 1" in result.stderr


@pytest.mark.parametrize('drift', [False, True])
def test_published_run_checks_source_and_generated_ranges(tmp_path: Path, mixed_plan: dict[str, object], drift: bool):
    mixed_plan['delivery']['audio'] = {'mode': 'track', 'asset': SOUNDTRACK}
    snapshot = project_snapshot([], soundtrack=SOUNDTRACK, run_clips=[
        {'itemId': FIRST_ID, 'inFrame': 4, 'outFrame': 16},
        {'itemId': SECOND_ID, 'inFrame': 2, 'outFrame': 14},
    ])
    cut = 7 if drift else 6
    snapshot['canvasItems'][1]['runPlan'] = {
        'fps': FPS, 'frameCount': 36, 'source': SOURCE, 'entries': [
            {'kind': 'source', 'sourceStart': 0, 'sourceEnd': cut},
            {'kind': 'generated', 'sourceStart': cut, 'sourceEnd': 18, 'itemId': FIRST_ID},
            {'kind': 'generated', 'sourceStart': 18, 'sourceEnd': 30, 'itemId': SECOND_ID},
            {'kind': 'source', 'sourceStart': 30, 'sourceEnd': 36},
        ],
    }
    result = run_validator(tmp_path, mixed_plan, '--run-id', RUN_ID, snapshot=snapshot)
    assert result.returncode == int(drift), result.stderr
    if drift:
        assert 'Published group ranges' in result.stderr


def test_run_verifies_planned_soundtrack_fingerprint(tmp_path: Path):
    path = tmp_path / 'dedicated.wav'
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(b'\x10\x10' * 48000)
    soundtrack = {**SOUNDTRACK, 'fingerprint': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
    plan = {
        'totalFrames': 24, 'sourceOnly': [],
        'delivery': {'fps': FPS, 'audio': {'asset': soundtrack}},
        'segments': [{'id': 'first', 'source': [0, 24], 'rawFrames': 24, 'itemId': FIRST_ID}],
        'timeline': [{'source': [0, 24], 'owner': 'generated', 'segment': 'first', 'keep': [0, 24]}],
    }
    snapshot = project_snapshot([], soundtrack=soundtrack, soundtrack_frames=24, run_clips=[
        {'itemId': FIRST_ID, 'inFrame': 0, 'outFrame': 24, 'reverse': False},
    ])
    result = run_validator(tmp_path, plan, '--run-id', RUN_ID, '--soundtrack', str(path), snapshot=snapshot)
    assert result.returncode == 0, result.stderr
    path.write_bytes(b'different content')
    mismatch = run_validator(tmp_path, plan, '--run-id', RUN_ID, '--soundtrack', str(path), snapshot=snapshot)
    assert mismatch.returncode == 1
    assert 'fingerprint' in mismatch.stderr.lower()


@pytest.mark.requires_ffmpeg
@pytest.mark.parametrize('with_audio', [False, True])
def test_render_check_reads_actual_export_audio(tmp_path: Path, mixed_plan: dict[str, object], with_audio: bool):
    export = tmp_path / 'delivery.mp4'
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=24']
    if with_audio:
        command.extend(['-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000'])
    command.extend(['-t', '1.5', '-c:v', 'mpeg4', str(export)])
    subprocess.run(command, check=True, capture_output=True, timeout=30)
    mixed_plan['delivery']['audio'] = {'asset': SOUNDTRACK}
    snapshot = project_snapshot([
        timeline_clip('Opening', SOURCE, 0, 6),
        timeline_clip('First take', FIRST, 4, 16),
        timeline_clip('Second take', SECOND, 2, 14),
        timeline_clip('Ending', SOURCE, 30, 36),
    ], soundtrack=SOUNDTRACK)
    result = run_validator(tmp_path, mixed_plan, '--timeline-id', TIMELINE_ID, '--output', str(export), snapshot=snapshot)
    assert result.returncode == int(not with_audio), result.stderr
    if not with_audio:
        assert 'audio stream' in result.stderr.lower()
