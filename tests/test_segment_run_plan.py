"""Deterministic compiler rules for complete and guided segment runs."""

from uuid import uuid4

import pytest

from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.segment_run import SegmentRunPlan


def continuation(upstream, frames=(0, 21)):
    return {'kind': 'continuation', 'upstreamItemId': upstream, 'sourceFrames': frames}


@pytest.fixture
def segment_run():
    source = dict(assetId=uuid4(), revision=1, fingerprint='sha256:' + 'a' * 64, kind='video')
    a, b, c, d = (uuid4() for _ in range(4))
    entries = [
        dict(kind='source', sourceStart=0, sourceEnd=6),
        dict(kind='generated', itemId=a, shot='first', step=continuation(b, (21, 0)), sourceStart=6, sourceEnd=144),
        dict(kind='generated', itemId=b, shot='first', step={'kind': 'anchor'}, sourceStart=144, sourceEnd=282),
        dict(kind='generated', itemId=c, shot='first', step=continuation(b), sourceStart=282, sourceEnd=420),
        dict(kind='generated', itemId=d, shot='second', step={'kind': 'anchor'}, sourceStart=420, sourceEnd=565),
        dict(kind='source', sourceStart=565, sourceEnd=566),
    ]
    pid, group_id, model_id = (uuid4() for _ in range(3))
    generated = entries[1:-1]
    clips = [
        dict(itemId=row['itemId'], inFrame=22, outFrame=22 + row['sourceEnd'] - row['sourceStart'],
             reverse=row['itemId'] == a)
        for row in generated
    ]
    items = [dict(id=group_id, projectId=pid, kind='group',
                  assembly=dict(timelineItemId=uuid4(), outputItemId=uuid4(), clips=clips))]
    specs, references = [], []
    for row in generated:
        spec_id = uuid4()
        params = {'videoMode': 'reference', 'durationSeconds': 8}
        if row['step']['kind'] == 'continuation':
            reference_id = uuid4()
            references.append(dict(id=reference_id, projectId=pid, targetSpecId=spec_id, role='reference',
                                   binding='follow_current', source={'id': row['step']['upstreamItemId']}))
            params['h3Segment'] = dict(guideReferenceId=reference_id, sourceFrames=row['step']['sourceFrames'])
        specs.append(dict(id=spec_id, projectId=pid, kind='video', purpose='generation',
                          modelConfigId=model_id, prompt='Change the actor', parameters=params))
        items.append(dict(id=row['itemId'], projectId=pid, parentId=group_id, kind='video',
                          binding={'role': 'generation', 'objectRef': {'id': spec_id}}))
    asset_id = source['assetId']
    snapshot = dict(
        project={'id': pid, 'name': 'Test segment run'}, canvasItems=items, generationSpecs=specs, references=references,
        assets=[dict(id=asset_id, projectId=pid, kind='video', fingerprint=source['fingerprint'],
                     name='Normalized project video', path=f'assets/{asset_id}',
                     metadata={'mimeType': 'video/mp4', 'size': 1024, 'frameRate': 24},
                     provenance={'source': 'upload'})],
    )
    return dict(source=source, fps=24, frameCount=566, entries=entries), snapshot


def test_segment_run_keeps_source_order_separate_from_reverse_generation(segment_run):
    payload, raw_snapshot = segment_run
    plan = SegmentRunPlan.model_validate(payload)
    snapshot = ProjectSnapshot.model_validate(raw_snapshot)
    plan.validate_for(snapshot, snapshot.canvasItems[0])
    a, b, c, d = plan.by_item()
    assert plan.execution_order() == (b, a, c, d)
    assert plan.entries[0].kind == plan.entries[-1].kind == 'source'
    assert snapshot.canvasItems[0].assembly.clips[0].reverse


@pytest.mark.parametrize('mistake', ['shortened', 'same_length_overlap', 'missing_start'])
def test_segment_run_rejects_incomplete_coverage(segment_run, mistake):
    payload, _ = segment_run
    entries = payload['entries']
    if mistake == 'shortened':
        entries.pop()
    elif mistake == 'same_length_overlap':
        # Still 566 total: source frame 6 is missing and source frame 144 is doubled.
        entries[1].update(sourceStart=7, sourceEnd=145)
    else:
        entries.pop(0)
    with pytest.raises(ValueError, match='source coverage has a gap'):
        SegmentRunPlan.model_validate(payload)


@pytest.mark.parametrize(('mistake', 'message'), [
    ('unguided', 'one anchor'),
    ('cycle', 'contain a cycle'),
    ('external', 'member of shot'),
    ('cross_shot', 'member of shot'),
    ('same_frame', 'distinct guide frames'),
])
def test_segment_run_rejects_invalid_continuations(segment_run, mistake, message):
    payload, _ = segment_run
    a, _, c, d = payload['entries'][1:-1]
    if mistake == 'unguided':
        a['step'] = {'kind': 'anchor'}
    elif mistake == 'cycle':
        a['step'] = continuation(c['itemId'])
        c['step'] = continuation(a['itemId'])
    elif mistake == 'external':
        a['step'] = continuation(uuid4())
    elif mistake == 'cross_shot':
        a['step'] = continuation(d['itemId'])
    else:
        a['step']['sourceFrames'] = [0, 0]
    with pytest.raises(ValueError, match=message):
        SegmentRunPlan.model_validate(payload)


@pytest.mark.parametrize(('mistake', 'message'), [
    ('source_version', 'different version'),
    ('fps', 'frame rate differs'),
    ('trim', 'keep length'),
    ('wrong_donor', 'requires live guides'),
    ('wrong_frames', 'requires live guides'),
    ('unconfigured', 'requires live guides'),
])
def test_segment_run_requires_frozen_source_and_matching_saved_assembly(segment_run, mistake, message):
    payload, raw_snapshot = segment_run
    if mistake == 'source_version':
        raw_snapshot['assets'][0]['revision'] = 2
    elif mistake == 'fps':
        raw_snapshot['assets'][0]['metadata']['frameRate'] = 25
    elif mistake == 'trim':
        raw_snapshot['canvasItems'][0]['assembly']['clips'][0]['outFrame'] -= 1
    elif mistake == 'wrong_donor':
        raw_snapshot['references'][0]['source']['id'] = payload['entries'][3]['itemId']
    elif mistake == 'wrong_frames':
        raw_snapshot['generationSpecs'][0]['parameters']['h3Segment']['sourceFrames'] = [10, 5]
    else:
        raw_snapshot['generationSpecs'][0]['parameters'].pop('h3Segment')
    plan = SegmentRunPlan.model_validate(payload)
    snapshot = ProjectSnapshot.model_validate(raw_snapshot)
    with pytest.raises(ValueError, match=message):
        plan.validate_for(snapshot, snapshot.canvasItems[0])
