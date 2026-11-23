"""Verify H3 cinematography compilation/linting, shot inspection, skill snapshot, and timeline shot revision."""
from io import BytesIO
import json
from pathlib import Path
import subprocess
from uuid import uuid4

from capabilities import requires_ffmpeg

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest
from typer.testing import CliRunner

from opendirector import cli
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.skill_snapshot import prepare_skills
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_assets import CreationAssets
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.h3_cinematography import (
    compile_h3_prompt,
    format_camera_motion,
    format_dialogue,
    h3_frame_grid,
    h3_reference_ordinals,
    lint_h3_prompt,
    lint_shot_plan,
)
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.installation import builtin_skills
from opendirector.integrations.fasth3 import native_prompt
from opendirector.media import probe as media_probe
from opendirector.media import processing as media
from opendirector_api.main import create_app


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _stage_and_import(projects, project_id, session, name, kind, data):
    handle = uuid4()
    writer = CreationAssets(projects).uploads.begin(project_id, handle, session, name, expected_kind=kind)
    try:
        writer.write(data)
        writer.finish()
    finally:
        writer.abort()
    receipt = projects.execute(parse_command({
        "type": "asset.import",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {"uploadHandle": str(handle), "expectedKind": kind, "name": name},
    }), session=session)
    assert receipt.status == "applied", receipt
    asset_id = next(c.id for c in receipt.changed if c.objectType == "asset")
    return next(a for a in projects.snapshot(project_id).assets if a.id == asset_id)


def _png_bytes(color=(30, 90, 160), size=(320, 240)):
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def test_h3_reference_ordinals_match_fasth3_native_prompt_audio_offset():
    sources = [
        ({"id": "img-1", "name": "hero.png", "hasAudio": False}, "image"),
        ({"id": "vid-1", "name": "ref-dance.mp4", "hasAudio": True}, "video"),
        ({"id": "aud-1", "name": "voice.wav", "hasAudio": True}, "audio"),
        ({"id": "vid-2", "name": "silent-cam.mp4", "hasAudio": False}, "video"),
        ({"id": "img-2", "name": "prop.png", "hasAudio": False}, "image"),
        ({"id": "aud-2", "name": "bgm.mp3", "hasAudio": True}, "audio"),
    ]
    prompt_content = []
    for meta, _ in sources:
        prompt_content.append({"type": "reference", "assetId": meta["id"], "name": meta["name"]})
        prompt_content.append({"type": "text", "text": " "})
    rendered = native_prompt({"prompt": "", "promptContent": prompt_content}, sources).strip().split()

    ordinal_inputs = [{**meta, "kind": kind} for meta, kind in sources]
    ordinals = h3_reference_ordinals(ordinal_inputs)
    assert [entry["tag"] for entry in ordinals] == [
        "<Picture 1>",
        "<Video 1>",
        "<Audio 2>",
        "<Video 2>",
        "<Picture 2>",
        "<Audio 3>",
    ]
    assert " ".join(entry["tag"] for entry in ordinals) == " ".join(rendered)
    assert ordinals[1]["embeddedAudioTag"] == "<Audio 1>"
    assert ordinals[3]["embeddedAudioTag"] is None


@pytest.mark.parametrize("mode", ["t2va", "i2va", "fl2va", "l2va"])
def test_compile_and_lint_base_h3_modes_and_camera_dialogue_grammar(mode):
    grid = h3_frame_grid(7.0)
    assert grid["gridFrames"] == 175
    assert (grid["gridFrames"] - 5) % 17 == 0

    cam = format_camera_motion("Push In", amplitude="small", speed="slow", detail="toward the brass compass")
    assert cam == "The camera pushes in with small amplitude at slow speed toward the brass compass."

    vo = format_dialogue(
        "S1", "English", "We are almost out of time.",
        speaker_intro="The navigator", voiceover=True,
    )
    assert vo == (
        "The navigator (S1) says in an off-screen voiceover: "
        "<d>[English] We are almost out of time.</d> while their lips remain completely closed."
    )

    compiled = compile_h3_prompt({
        "mode": mode,
        "durationSeconds": 8.0,
        "style": "Live-action, cinematic",
        "shots": [
            {
                "shotSize": "medium-wide shot",
                "description": "The navigator stands beside <Picture 1> at the helm as spray crosses the deck",
                "cameraMotion": {"type": "Push In", "amplitude": "small", "speed": "slow", "detail": "toward the helm"},
                "dialogues": [
                    {
                        "speakerId": "S1",
                        "speakerIntro": "The weathered navigator",
                        "language": "Chinese",
                        "text": "稳住航向！",
                    }
                ],
            },
            {
                "atSeconds": 4.25,
                "shotSize": "close-up",
                "description": "The compass needle settles onto north, matching Picture 2 at the end",
                "cameraMotion": "Static Shot",
            },
        ],
        "overallSoundscape": "Ocean wind and timber creaks continue underneath crashing bow spray.",
        "nonDiegeticMusic": "Low brass notes at a slow tempo with a restrained percussive pulse.",
    })
    assert compiled["lint"]["valid"] is True, compiled["lint"]
    assert compiled["lint"]["detectedShots"] == 2
    if mode == "i2va":
        assert compiled["prompt"].startswith(
            "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
        )
    elif mode == "fl2va":
        assert compiled["prompt"].startswith(
            "How the reference pictures align with the target video — "
            "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; "
            "Picture 2 (from Shot 2) aligns with the 8.00-second mark of the target video.\n\n"
        )
    elif mode == "l2va":
        assert compiled["prompt"].startswith(
            "How the reference pictures align with the target video — "
            "<Picture 1> (from [Shot 2]) aligns with the 8.00-second mark of the target video.\n\n"
        )


def test_compile_and_lint_ref2va_catches_ordinal_and_retention_defects():
    sources = [
        {"id": "img-1", "name": "cafe.png", "kind": "image", "hasAudio": False},
        {"id": "vid-1", "name": "actor.mp4", "kind": "video", "hasAudio": True},
        {"id": "aud-1", "name": "timbre.wav", "kind": "audio", "hasAudio": True},
    ]
    valid_spec = {
        "mode": "ref2va",
        "durationSeconds": 6.0,
        "taskTypes": ["reference generation", "audio reference"],
        "subjectDefinitions": [
            "<Subject 1> is the sunlit cafe interior in <Picture 1> with dark walnut tables.",
            "<Subject 2> is the detective in <Video 1> wearing a charcoal trench coat.",
            "<Audio 2> is the voice-timbre reference for <Subject 2> (S1).",
        ],
        "summary": "The target video places <Subject 2> inside <Subject 1>, speaking with the vocal timbre of <Audio 2>.",
        "retentionAnalysis": [
            "<Subject 1> (appears in [Shot 1]): fully_preserved - walnut tables and window light are retained.",
            "<Subject 2> (appears in [Shot 1]): fully_preserved - facial features and charcoal coat are retained.",
            "<Audio 2>: reference - guides the measured vocal timbre without copying the source waveform.",
        ],
        "styleOpening": "The target video uses a live-action neo-noir style with warm practical lamps",
        "shots": [
            {
                "shotSize": "medium close-up",
                "description": "<Subject 2> sits in <Subject 1> and sets a brass key on the table",
                "cameraMotion": "Truck Right",
                "cameraAmplitude": "small",
                "cameraSpeed": "slow",
                "dialogues": [
                    {
                        "speakerId": "S1",
                        "speakerIntro": "<Subject 2>",
                        "language": "English",
                        "text": "You left this at the pier.",
                    }
                ],
            }
        ],
        "overallSoundscape": "Low cafe murmur and rain against glass continue softly.",
        "nonDiegeticMusic": "N/A",
        "referenceSources": sources,
    }
    compiled = compile_h3_prompt(valid_spec)
    assert compiled["lint"]["valid"] is True, compiled["lint"]

    broken = compiled["prompt"].replace("<Audio 2>", "<Audio 3>").replace(
        "fully_preserved - facial", "(S1) fully_preserved - <Subject 9> facial"
    )
    report = lint_h3_prompt(broken, mode="ref2va", duration_seconds=6.0, reference_sources=sources)
    assert report["valid"] is False
    joined = " | ".join(report["errors"])
    assert "<Audio 3>" in joined
    assert "speaker IDs" in joined
    assert "<Subject 9>" in joined


def test_lint_shot_plan_prevents_homogenization_and_enforces_duration_bounds():
    monotonous = [
        {"durationSeconds": 5, "shotSize": "medium shot", "cameraMotion": "Static Shot", "mode": "i2va"},
        {"durationSeconds": 5, "shotSize": "medium shot", "cameraMotion": "Static Shot", "mode": "i2va"},
        {"durationSeconds": 18, "shotSize": "medium shot", "cameraMotion": "Static Shot", "mode": "i2va"},
    ]
    bad = lint_shot_plan(monotonous)
    assert bad["valid"] is False
    assert any("consecutive shots" in err for err in bad["errors"])
    assert any("outside MiniMax-H3" in err for err in bad["errors"])

    diverse = [
        {"durationSeconds": 5, "shotSize": "wide shot", "cameraMotion": "Push In", "mode": "i2va"},
        {"durationSeconds": 6, "shotSize": "medium close-up", "cameraMotion": "Truck Right", "mode": "ref2va"},
        {"durationSeconds": 5, "shotSize": "close-up", "cameraMotion": "Static Shot", "mode": "fl2va"},
    ]
    good = lint_shot_plan(diverse)
    assert good["valid"] is True, good
    assert good["shotSizeDiversity"] == 1.0
    assert good["cameraMotionDiversity"] == 1.0


def test_cli_h3_workflow_inspect_shot_and_surgical_timeline_revise(tmp_path, monkeypatch):
    local = LocalProjects(tmp_path)
    projects = CreationProjects(local)
    models = ModelConfigs(tmp_path)
    model_id = models.save(
        "video", "http://127.0.0.1:19999/v1", "MiniMax-H3", "",
        connection_type="self_hosted", protocol="vllm_omni", auth_mode="none",
    )["id"]

    api = TestClient(create_app(local), headers={"X-OpenDirector-Request": "1"})
    original_client = httpx.Client
    monkeypatch.setattr(
        cli.httpx,
        "Client",
        lambda **kwargs: original_client(
            **kwargs,
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    *(lambda res: (res.status_code,))(
                        res := api.request(
                            req.method,
                            req.url.path + (f"?{req.url.query.decode()}" if req.url.query else ""),
                            headers=dict(req.headers),
                            content=req.read(),
                        )
                    ),
                    headers=res.headers,
                    content=res.content,
                )
            ),
        ),
    )

    project_id = uuid4()
    session = str(uuid4())
    projects.execute(parse_command({
        "type": "project.create",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {"name": "H3 Orchestration"},
    }))
    projects.open(project_id, session)

    ffprobe_payload = json.dumps({
        "format": {
            "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
            "duration": "5.1667",
            "size": "12345",
            "tags": {"major_brand": "isom"},
        },
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 832,
                "height": 480,
                "r_frame_rate": "24/1",
                "avg_frame_rate": "24/1",
                "nb_frames": "124",
            },
            {"codec_type": "audio", "codec_name": "aac"},
        ],
    }).encode("utf-8")
    monkeypatch.setattr(media_probe, "require_ffprobe", lambda: None)
    monkeypatch.setattr(
        media_probe.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout=ffprobe_payload, stderr=b""),
    )
    monkeypatch.setattr(media, "_run", lambda cmd, timeout=60: ffprobe_payload)
    monkeypatch.setattr(
        media,
        "frame_at",
        lambda path, seconds, out: _png_bytes((40, int(seconds * 30) % 255, 120), (832, 480)),
    )

    img_start = _stage_and_import(projects, project_id, session, "start.png", "image", _png_bytes((20, 40, 80)))
    img_end = _stage_and_import(projects, project_id, session, "end.png", "image", _png_bytes((180, 90, 40)))
    img_s1 = _stage_and_import(projects, project_id, session, "shot1.png", "image", _png_bytes((50, 120, 90)))
    img_s2_old = _stage_and_import(projects, project_id, session, "shot2_old.png", "image", _png_bytes((100, 100, 100)))
    img_s2_new = _stage_and_import(projects, project_id, session, "shot2_new.png", "image", _png_bytes((220, 160, 60)))
    img_s3 = _stage_and_import(projects, project_id, session, "shot3.png", "image", _png_bytes((70, 50, 140)))
    seed_video = _stage_and_import(projects, project_id, session, "seed.mp4", "video", b"mp4-fixture-bytes")

    start_item, end_item, s1_item, s2_new_item = uuid4(), uuid4(), uuid4(), uuid4()
    for item_id, asset_obj, x_pos in [
        (start_item, img_start, 0),
        (end_item, img_end, 0),
        (s1_item, img_s1, 360),
        (s2_new_item, img_s2_new, 720),
    ]:
        projects.execute(parse_command({
            "type": "canvas.show",
            "projectId": project_id,
            "commandId": uuid4(),
            "payload": {
                "item": {
                    "id": str(item_id),
                    "projectId": str(project_id),
                    "kind": asset_obj.kind,
                    "position": {"x": x_pos, "y": 0},
                    "binding": {
                        "role": "material",
                        "objectRef": {
                            "assetId": str(asset_obj.id),
                            "revision": asset_obj.revision,
                            "fingerprint": asset_obj.fingerprint,
                            "kind": asset_obj.kind,
                        },
                    },
                },
            },
        }), session=session)

    # Also create a populated video generation item on canvas to exercise --continue-from
    seed_video_spec, seed_video_item = uuid4(), uuid4()
    projects.execute(parse_command({
        "type": "canvas.createGeneration",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "spec": {
                "id": str(seed_video_spec),
                "projectId": str(project_id),
                "kind": "video",
                "purpose": "generation",
                "modelConfigId": model_id,
                "prompt": "Seed clip",
                "parameters": {"videoMode": "first_frame", "durationSeconds": 5},
            },
            "item": {
                "id": str(seed_video_item),
                "projectId": str(project_id),
                "kind": "video",
                "position": {"x": 1080, "y": 0},
                "binding": {
                    "role": "generation",
                    "objectRef": {"id": str(seed_video_spec)},
                    "materialOverride": {
                        "assetId": str(seed_video.id),
                        "revision": seed_video.revision,
                        "fingerprint": seed_video.fingerprint,
                        "kind": seed_video.kind,
                    },
                },
            },
            "references": [],
        },
    }), session=session)

    timeline_id = uuid4()

    def _img_clip(cid, asset_obj, dur=4.5):
        return {
            "id": cid,
            "resource": {
                "asset": {
                    "assetId": str(asset_obj.id),
                    "revision": asset_obj.revision,
                    "fingerprint": asset_obj.fingerprint,
                    "kind": asset_obj.kind,
                },
                "title": asset_obj.name,
                "durationSeconds": None,
            },
            "inPoint": 0.0,
            "outPoint": dur,
        }

    c1 = _img_clip("shot-1", img_s1, 5.0)
    c2 = _img_clip("shot-2", img_s2_old, 4.5)
    c3 = _img_clip("shot-3", img_s3, 6.0)
    tl_receipt = projects.execute(parse_command({
        "type": "editor.create",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "document": {
                "id": str(timeline_id),
                "projectId": str(project_id),
                "kind": "timeline",
                "inputConnections": [{
                    "id": str(uuid4()),
                    "sourceId": str(s1_item),
                    "slotId": "shot-1",
                    "asset": c1["resource"]["asset"],
                }],
                "data": {
                    "fps": 24,
                    "width": 320,
                    "height": 240,
                    "tracks": [
                        {"id": "visual-main", "kind": "visual", "title": "Main", "clips": [c1, c2, c3]},
                        {"id": "audio-bgm", "kind": "audio", "title": "BGM", "clips": []},
                    ],
                    "importedAssets": [c1["resource"], c2["resource"], c3["resource"]],
                },
            },
        },
    }), session=session)
    assert tl_receipt.status == "applied", tl_receipt
    local.release(session)

    runner = CliRunner()

    # 1. Inspect shot + contact sheet exclusive creation (deterministic media double when ffmpeg is absent)
    fake_mp4 = tmp_path / "shot1.mp4"
    fake_mp4.write_bytes(b"mp4-fixture-bytes")

    sheet_path = tmp_path / "qc" / "shot1-sheet.jpg"
    inspect_res = runner.invoke(cli.app, [
        "video", "inspect-shot", str(fake_mp4), "--contact-sheet", str(sheet_path), "--columns", "4", "--rows", "3",
    ])
    assert inspect_res.exit_code == 0, inspect_res.output
    inspected = json.loads(inspect_res.output)
    assert inspected["technical"]["matchesH3Grid"] is True
    assert inspected["technical"]["hasAudio"] is True
    assert inspected["contactSheet"]["tileCount"] == 12
    assert sheet_path.is_file() and sheet_path.stat().st_size > 1000

    # Exclusive creation refuses to overwrite an existing contact sheet
    dup_res = runner.invoke(cli.app, [
        "video", "inspect-shot", str(fake_mp4), "--contact-sheet", str(sheet_path),
    ])
    assert dup_res.exit_code == 1

    # 2. Lint shot plan via CLI
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({
        "shots": [
            {"durationSeconds": 5, "shotSize": "wide shot", "cameraMotion": "Push In", "mode": "i2va"},
            {"durationSeconds": 6, "shotSize": "close-up", "cameraMotion": "Static Shot", "mode": "fl2va"},
        ]
    }), encoding="utf-8")
    plan_res = runner.invoke(cli.app, ["video", "lint-shot-plan", "--file", str(plan_file)])
    assert plan_res.exit_code == 0, plan_res.output
    assert json.loads(plan_res.output)["valid"] is True

    # 3. Compile FL2VA prompt, create FL2VA node via CLI, and lint live spec
    spec_file = tmp_path / "fl2va-spec.json"
    spec_file.write_text(json.dumps({
        "mode": "fl2va",
        "durationSeconds": 6.0,
        "shots": [{
            "shotSize": "medium shot",
            "description": "The courier starts in the pose of Picture 1, turns under the awning, and settles into Picture 2",
            "cameraMotion": "Pull Out",
            "cameraAmplitude": "small",
            "cameraSpeed": "slow",
        }],
        "overallSoundscape": "Steady street rain and footsteps on wet stone.",
        "nonDiegeticMusic": "N/A",
    }), encoding="utf-8")
    compile_res = runner.invoke(cli.app, ["video", "compile-h3-prompt", "--file", str(spec_file)])
    assert compile_res.exit_code == 0, compile_res.output
    compiled_prompt = json.loads(compile_res.output)["prompt"]

    create_fl2va = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "create",
        "--model", model_id,
        "--prompt", compiled_prompt,
        "--duration", "6",
        "--x", "400", "--y", "320",
        "--first-frame", str(start_item),
        "--last-frame", str(end_item),
        "--title", "FL2VA Bridge Shot",
    ])
    assert create_fl2va.exit_code == 0, create_fl2va.output
    fl2va_receipt = json.loads(create_fl2va.output)
    lint_live = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "lint-h3-prompt", "--spec-id", fl2va_receipt["specId"],
    ])
    assert lint_live.exit_code == 0, lint_live.output
    lint_payload = json.loads(lint_live.output)
    assert lint_payload["lint"]["mode"] == "fl2va"
    assert lint_payload["lint"]["valid"] is True
    assert [r["tag"] for r in lint_payload["referenceOrdinals"]] == ["<Picture 1>", "<Picture 2>"]

    # 4. Continuation mode creation via --continue-from
    create_cont = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "create",
        "--model", model_id,
        "--prompt", "Continue camera movement down the corridor.",
        "--duration", "5",
        "--x", "800", "--y", "320",
        "--continue-from", str(seed_video_item),
    ])
    assert create_cont.exit_code == 0, create_cont.output
    cont_spec_id = json.loads(create_cont.output)["specId"]
    persisted_cont = next(s for s in projects.snapshot(project_id).generationSpecs if str(s.id) == cont_spec_id)
    assert persisted_cont.parameters.videoMode == "continuation"

    # 5. Surgical single-shot timeline revision (replaces shot-2 ONLY, preserves shot-1, shot-3, and connections)
    revise_res = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "revise-shot",
        "--timeline-editor", str(timeline_id),
        "--clip-id", "shot-2",
        "--asset", str(img_s2_new.id),
        "--source-item", str(s2_new_item),
    ])
    assert revise_res.exit_code == 0, revise_res.output
    revised_body = json.loads(revise_res.output)
    assert revised_body["status"] == "applied"
    assert revised_body["previousAssetId"] == str(img_s2_old.id)
    assert revised_body["newAssetId"] == str(img_s2_new.id)
    assert revised_body["outPoint"] == 4.5

    after_tl = next(d for d in projects.snapshot(project_id).editorDocuments if d.id == timeline_id)
    assert after_tl.revision == 2
    visual_clips = after_tl.data.tracks[0].clips
    assert [c.id for c in visual_clips] == ["shot-1", "shot-2", "shot-3"]
    assert visual_clips[0].resource.asset.assetId == img_s1.id
    assert visual_clips[1].resource.asset.assetId == img_s2_new.id
    assert visual_clips[2].resource.asset.assetId == img_s3.id
    conn_by_slot = {c.slotId: c for c in after_tl.inputConnections}
    assert conn_by_slot["shot-1"].sourceId == s1_item
    assert conn_by_slot["shot-2"].sourceId == s2_new_item

    # 6. Project-native asset.preview contact_sheet + measuredFacts via CLI & HTTP
    asset_sheet_path = tmp_path / "qc" / "asset-seed-sheet.jpg"
    inspect_asset_res = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "inspect-shot",
        "--asset", str(seed_video.id),
        "--contact-sheet", str(asset_sheet_path),
        "--columns", "3", "--rows", "2",
    ])
    assert inspect_asset_res.exit_code == 0, inspect_asset_res.output
    asset_qc = json.loads(inspect_asset_res.output)
    assert asset_qc["preview"]["scope"] == "contact_sheet"
    assert asset_qc["preview"]["columns"] == 3
    assert asset_qc["preview"]["rows"] == 2
    assert asset_qc["measuredFacts"]["source"] == "measured"
    assert asset_qc["measuredFacts"]["motion"]["sampledFrames"] == 6
    assert asset_qc["measuredFacts"]["motion"]["suspectedFrozen"] is False
    assert asset_qc["measuredFacts"]["motion"]["meanFrameDelta"] > 0
    assert asset_qc["measuredFacts"]["exposure"]["blackFrameIndices"] == []
    assert asset_sheet_path.is_file() and asset_sheet_path.stat().st_size > 800

    # Frozen + black-frame detection in measuredFacts
    monkeypatch.setattr(
        media,
        "frame_at",
        lambda path, seconds, out: _png_bytes((0, 0, 0), (320, 240)),
    )
    frozen_qc = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "inspect-shot",
        "--asset", str(seed_video.id),
        "--columns", "2", "--rows", "2",
    ])
    assert frozen_qc.exit_code == 0, frozen_qc.output
    frozen_facts = json.loads(frozen_qc.output)["measuredFacts"]
    assert frozen_facts["motion"]["suspectedFrozen"] is True
    assert frozen_facts["exposure"]["blackFrameIndices"] == [0, 1, 2, 3]
    assert frozen_facts["exposure"]["blackFrameRatio"] == 1.0

    # 7. Live project storyboard.audit catches unanchored T2VA island, unrendered upstream keyframe, and unlinked timeline clip
    img_model_id = models.save(
        "image", "http://127.0.0.1:19999/v1", "Flux-Dev", "",
        connection_type="self_hosted", protocol="openai", auth_mode="none",
    )["id"]
    blank_kf_spec, blank_kf_item = uuid4(), uuid4()
    projects.open(project_id, session)
    projects.execute(parse_command({
        "type": "canvas.createGeneration",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "spec": {
                "id": str(blank_kf_spec),
                "projectId": str(project_id),
                "kind": "image",
                "purpose": "generation",
                "modelConfigId": img_model_id,
                "prompt": "Unrendered keyframe",
                "parameters": {},
            },
            "item": {
                "id": str(blank_kf_item),
                "projectId": str(project_id),
                "kind": "image",
                "position": {"x": 0, "y": 640},
                "binding": {"role": "generation", "objectRef": {"id": str(blank_kf_spec)}},
            },
            "references": [],
        },
    }), session=session)
    local.release(session)

    # Create a bare T2VA shot (unanchored island) and a blocked I2VA shot pointing at unrendered keyframe
    bare_t2va = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "create",
        "--model", model_id,
        "--prompt", "A wide shot of a courier running in rain, Push In with a medium amplitude at a fast pace.\n\nOverall Soundscape: Rain.\n\nNon-Diegetic Music: N/A",
        "--duration", "5",
        "--x", "1200", "--y", "320",
    ])
    assert bare_t2va.exit_code == 0, bare_t2va.output
    bare_spec_id = json.loads(bare_t2va.output)["specId"]

    audit_canvas = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "audit-storyboard",
        "--spec-id", fl2va_receipt["specId"],
        "--spec-id", bare_spec_id,
    ])
    assert audit_canvas.exit_code == 0, audit_canvas.output
    audit_report = json.loads(audit_canvas.output)
    assert audit_report["gate"]["shotCount"] == 2
    assert any("bare T2VA" in w for w in audit_report["continuity"]["warnings"])

    audit_tl = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "audit-storyboard",
        "--timeline-editor", str(timeline_id),
    ])
    assert audit_tl.exit_code == 0, audit_tl.output
    tl_audit = json.loads(audit_tl.output)
    assert "shot-3" in tl_audit["continuity"]["unlinkedTimelineClipIds"]

    # 8. Lineage-aware revise-shot using ONLY --source-item (auto-resolves clipId 'shot-1' and asset from s1_item)
    projects.open(project_id, session)
    s1_latest = next(i for i in projects.snapshot(project_id).canvasItems if i.id == s1_item)
    mat_receipt = projects.execute(parse_command({
        "type": "canvas.materialize",
        "projectId": project_id,
        "commandId": uuid4(),
        "expectedVersions": [{"objectType": "canvas_item", "id": str(s1_item), "revision": s1_latest.revision}],
        "payload": {
            "itemId": str(s1_item),
            "asset": {
                "assetId": str(img_end.id),
                "revision": img_end.revision,
                "fingerprint": img_end.fingerprint,
                "kind": img_end.kind,
            },
        },
    }), session=session)
    assert mat_receipt.status == "applied", mat_receipt
    local.release(session)

    auto_revise = runner.invoke(cli.app, [
        "--project", str(project_id), "video", "revise-shot",
        "--timeline-editor", str(timeline_id),
        "--source-item", str(s1_item),
    ])
    assert auto_revise.exit_code == 0, auto_revise.output
    auto_body = json.loads(auto_revise.output)
    assert auto_body["clipId"] == "shot-1"
    assert auto_body["previousAssetId"] == str(img_s1.id)
    assert auto_body["newAssetId"] == str(img_end.id)
    final_clips = next(d for d in projects.snapshot(project_id).editorDocuments if d.id == timeline_id).data.tracks[0].clips
    assert final_clips[0].resource.asset.assetId == img_end.id
    assert final_clips[1].resource.asset.assetId == img_s2_new.id
    assert final_clips[2].resource.asset.assetId == img_s3.id


@requires_ffmpeg()
def test_real_ffmpeg_shot_inspection(tmp_path):
    from opendirector.media.shot_inspection import inspect_video_shot

    sample = tmp_path / "real.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=5.2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5.2",
        "-frames:v", "124", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(sample),
    ], check=True, timeout=30)
    sheet = tmp_path / "sheet.jpg"
    report = inspect_video_shot(sample, contact_sheet_path=sheet, columns=4, rows=3)
    assert report["technical"]["matchesH3Grid"] is True
    assert report["technical"]["hasAudio"] is True
    assert sheet.is_file()


@pytest.mark.anyio
async def test_h3_shot_director_skill_snapshot_and_gateway_read(tmp_path):
    skill_dir = builtin_skills() / "h3-shot-director"
    entry = skill_dir / "SKILL.md"
    assert entry.is_file()
    for name in ("SKILL.md", "h3-vocabulary.md", "shot-orchestration.md"):
        target = skill_dir / name
        assert target.is_file() and not target.is_symlink()
        assert target.stat().st_size <= 65536

    work = tmp_path / "agent-work"
    roots = prepare_skills(work, [{"name": "h3-shot-director", "filePath": str(entry)}])
    assert len(roots) == 1
    assert (roots[0] / "h3-vocabulary.md").is_file()
    assert (roots[0] / "shot-orchestration.md").is_file()

    projects = CreationProjects(LocalProjects(tmp_path))
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    run = RunContext(
        runtime="codex", project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        directory=work, config=None, messages=[], selected_skills=["h3-shot-director"],
    )
    gateway = ToolGateway(business, run)
    gateway.roots = roots
    try:
        for name in ("SKILL.md", "h3-vocabulary.md", "shot-orchestration.md"):
            outcome = await gateway.call(f"read-{name}", "read", {"path": str(roots[0] / name)})
            assert outcome.error is None
            assert "MiniMax-H3" in outcome.value or "lint-shot-plan" in outcome.value
    finally:
        await gateway.close()


@pytest.mark.anyio
async def test_tool_gateway_storyboard_audit_and_video_contact_sheet_preview(tmp_path, monkeypatch):
    ffprobe_payload = json.dumps({
        "format": {
            "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
            "duration": "5.1667",
            "size": "12345",
            "tags": {"major_brand": "isom"},
        },
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 640,
                "height": 360,
                "r_frame_rate": "24/1",
                "avg_frame_rate": "24/1",
                "nb_frames": "124",
            },
            {"codec_type": "audio", "codec_name": "aac"},
        ],
    }).encode("utf-8")
    monkeypatch.setattr(media_probe, "require_ffprobe", lambda: None)
    monkeypatch.setattr(
        media_probe.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout=ffprobe_payload, stderr=b""),
    )
    monkeypatch.setattr(media, "_run", lambda cmd, timeout=60: ffprobe_payload)
    monkeypatch.setattr(
        media,
        "frame_at",
        lambda path, seconds, out: _png_bytes((20 + int(seconds * 25) % 200, 80, 140), (640, 360)),
    )

    local = LocalProjects(tmp_path)
    projects = CreationProjects(local)
    configs = ModelConfigs(tmp_path)
    model_id = configs.save(
        "video", "http://127.0.0.1:19999/v1", "MiniMax-H3", "",
        connection_type="self_hosted", protocol="vllm_omni", auth_mode="none",
    )["id"]
    img_model_id = configs.save(
        "image", "http://127.0.0.1:19999/v1", "Flux-Dev", "",
        connection_type="self_hosted", protocol="openai", auth_mode="none",
    )["id"]

    project_id = uuid4()
    session = str(uuid4())
    projects.execute(parse_command({
        "type": "project.create",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {"name": "Gateway Quality"},
    }))
    projects.open(project_id, session)
    vid_asset = _stage_and_import(projects, project_id, session, "clip.mp4", "video", b"mp4-bytes")

    # Create an unrendered image generation node and wire a video generation spec to it via pinned/draft check
    kf_spec_id, kf_item_id = uuid4(), uuid4()
    projects.execute(parse_command({
        "type": "canvas.createGeneration",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "spec": {
                "id": str(kf_spec_id),
                "projectId": str(project_id),
                "kind": "image",
                "purpose": "generation",
                "modelConfigId": img_model_id,
                "prompt": "Anchor keyframe",
                "parameters": {},
            },
            "item": {
                "id": str(kf_item_id),
                "projectId": str(project_id),
                "kind": "image",
                "position": {"x": 0, "y": 0},
                "binding": {"role": "generation", "objectRef": {"id": str(kf_spec_id)}},
            },
            "references": [],
        },
    }), session=session)

    vid_spec_id, vid_item_id = uuid4(), uuid4()
    projects.execute(parse_command({
        "type": "canvas.createGeneration",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "spec": {
                "id": str(vid_spec_id),
                "projectId": str(project_id),
                "kind": "video",
                "purpose": "generation",
                "modelConfigId": model_id,
                "prompt": "A wide shot of a courier running, Push In slowly.\n\nOverall Soundscape: Rain.\n\nNon-Diegetic Music: N/A",
                "parameters": {"videoMode": "first_frame", "durationSeconds": 6},
            },
            "item": {
                "id": str(vid_item_id),
                "projectId": str(project_id),
                "kind": "video",
                "position": {"x": 320, "y": 0},
                "binding": {"role": "generation", "objectRef": {"id": str(vid_spec_id)}},
            },
            "references": [],
        },
    }), session=session)
    local.release(session)

    work = tmp_path / "turn-work"
    work.mkdir(parents=True, exist_ok=True)
    business = AgentTools(projects, None, configs)
    run = RunContext(
        runtime="codex", project_id=project_id, turn_id=uuid4(), session=session,
        directory=work, config=None, messages=[], selected_skills=[],
    )
    gateway = ToolGateway(business, run)
    gateway.execution_directory = work
    try:
        preview_call = await gateway.call(
            "preview-sheet",
            "query",
            {"type": "asset.preview", "objectId": str(vid_asset.id), "videoScope": "contact_sheet", "columns": 3, "rows": 2},
        )
        assert preview_call.error is None, preview_call
        sheet_file = Path(preview_call.value["preview"]["path"])
        assert sheet_file.is_file() and sheet_file.is_relative_to(work / "previews")
        assert "-sheet-3x2.jpg" in sheet_file.name
        assert preview_call.value["measuredFacts"]["motion"]["sampledFrames"] == 6

        audit_call = await gateway.call("audit-board", "query", {"type": "storyboard.audit"})
        assert audit_call.error is None, audit_call
        assert audit_call.value["gate"]["shotCount"] == 1
        assert audit_call.value["gate"]["estimatedPendingVideoSeconds"] == 6.0
        assert audit_call.value["gate"]["requiresUserApproval"] is True
    finally:
        await gateway.close()


def test_lint_contradictory_motions_pseudo_params_and_fractional_17k5():
    from opendirector.application.creation_storyboard import extract_prompt_shot_features

    # 1. Exact 17k+5 fractional frame duration (158 / 24 = 6.583333s) compiles cleanly and exposes vllmOmniFrames
    fractional_duration = round(158 / 24, 6)
    compiled = compile_h3_prompt({
        "mode": "i2va",
        "durationSeconds": fractional_duration,
        "shots": [{
            "shotSize": "medium close-up",
            "description": "<Picture 1> turns toward the window",
            "cameraMotion": "Pull Out",
            "cameraAmplitude": "small",
            "cameraSpeed": "slow",
            "dialogues": [{
                "speakerId": "S1",
                "speakerIntro": "The detective",
                "language": "English",
                "text": "Push in the latch and pull out the drawer --ar 16:9.",
            }],
        }],
        "overallSoundscape": "Quiet rain on window glass.",
        "nonDiegeticMusic": "N/A",
    })
    assert compiled["lint"]["valid"] is True, compiled["lint"]
    assert compiled["frameGrid"]["vllmOmniFrames"] == 158
    features = extract_prompt_shot_features(compiled["prompt"])
    assert features == {"shotSize": "medium close-up", "cameraMotion": "Pull Out"}

    # 2. Contradictory camera motions and pseudo-parameter flags outside dialogue are rejected
    contradictory = (
        "integrated_multimodal_description: [Shot 1] Live-action, a wide shot: The courier walks across the alley. "
        "The camera pushes in slowly and then pulls out with large amplitude --ar 16:9 cfg_scale=7.\n\n"
        "overall_soundscape: Distant traffic.\n\n"
        "non_diegetic_music: N/A"
    )
    bad_lint = lint_h3_prompt(contradictory, mode="t2va", duration_seconds=5.0)
    assert bad_lint["valid"] is False
    joined_errors = " | ".join(bad_lint["errors"])
    assert "contradictory camera motions (Push In vs Pull Out)" in joined_errors
    assert "pseudo-parameter tag(s)" in joined_errors

    static_plus_pan = (
        "integrated_multimodal_description: [Shot 1] Live-action, a close-up: The watch ticks. "
        "The camera holds a static shot while it pans left across the desk.\n\n"
        "overall_soundscape: Soft ticking.\n\n"
        "non_diegetic_music: N/A"
    )
    static_lint = lint_h3_prompt(static_plus_pan, mode="t2va", duration_seconds=5.0)
    assert static_lint["valid"] is False
    assert any("Static Shot" in err for err in static_lint["errors"])


def test_storyboard_audit_group_visibility_ordinal_policy_and_query_contract(tmp_path):
    from pydantic import TypeAdapter, ValidationError
    from opendirector.application.creation_storyboard import (
        audit_project_storyboard,
        prepare_timeline_shot_revision,
        resolve_h3_spec_reference_sources,
    )
    from opendirector.domain.creation.commands import Query

    query_adapter = TypeAdapter(Query)
    g_id, tl_id, s_id = uuid4(), uuid4(), uuid4()
    with pytest.raises(ValidationError):
        query_adapter.validate_python({
            "type": "storyboard.audit",
            "projectId": str(uuid4()),
            "queryId": str(uuid4()),
            "timelineEditorId": str(tl_id),
            "groupId": str(g_id),
        })
    with pytest.raises(ValidationError):
        query_adapter.validate_python({
            "type": "storyboard.audit",
            "projectId": str(uuid4()),
            "queryId": str(uuid4()),
            "specIds": [str(s_id), str(s_id)],
        })

    local = LocalProjects(tmp_path)
    projects = CreationProjects(local)
    models = ModelConfigs(tmp_path)
    model_id = models.save(
        "video", "http://127.0.0.1:19999/v1", "MiniMax-H3", "",
        connection_type="self_hosted", protocol="vllm_omni", auth_mode="none",
    )["id"]

    project_id = uuid4()
    session = str(uuid4())
    projects.execute(parse_command({
        "type": "project.create",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {"name": "Policy & Group Audit"},
    }))
    projects.open(project_id, session)

    img_a = _stage_and_import(projects, project_id, session, "a.png", "image", _png_bytes((10, 40, 90)))
    img_b = _stage_and_import(projects, project_id, session, "b.png", "image", _png_bytes((90, 40, 10)))

    # 1. Reference policy parity: in first_frame mode, a non-frame 'reference' image is context_only and excluded
    #    from H3 media ordinals, and duplicate asset references collapse to a single <Picture 1>.
    spec_ff, item_ff = uuid4(), uuid4()
    ref_frame_id, ref_extra_id = uuid4(), uuid4()
    projects.execute(parse_command({
        "type": "canvas.createGeneration",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "spec": {
                "id": str(spec_ff),
                "projectId": str(project_id),
                "kind": "video",
                "purpose": "generation",
                "modelConfigId": model_id,
                "prompt": compile_h3_prompt({
                    "mode": "i2va",
                    "durationSeconds": 5.0,
                    "shots": [{
                        "shotSize": "wide shot",
                        "description": "<Picture 1> opens the scene under warm streetlamps",
                        "cameraMotion": "Push In",
                    }],
                })["prompt"],
                "parameters": {"videoMode": "first_frame", "durationSeconds": 5},
            },
            "item": {
                "id": str(item_ff),
                "projectId": str(project_id),
                "kind": "video",
                "position": {"x": 0, "y": 0},
                "binding": {"role": "generation", "objectRef": {"id": str(spec_ff)}},
            },
            "references": [
                {
                    "id": str(ref_extra_id),
                    "projectId": str(project_id),
                    "targetSpecId": str(spec_ff),
                    "role": "reference",
                    "order": 0,
                    "binding": "pinned",
                    "source": {"assetId": str(img_b.id), "revision": img_b.revision, "fingerprint": img_b.fingerprint, "kind": "image"},
                },
                {
                    "id": str(ref_frame_id),
                    "projectId": str(project_id),
                    "targetSpecId": str(spec_ff),
                    "role": "first_frame",
                    "order": 1,
                    "binding": "pinned",
                    "source": {"assetId": str(img_a.id), "revision": img_a.revision, "fingerprint": img_a.fingerprint, "kind": "image"},
                },
            ],
        },
    }), session=session)

    snap = projects.snapshot(project_id)
    resolved_ff = resolve_h3_spec_reference_sources(snap, spec_ff)
    assert [r["id"] for r in resolved_ff["referenceSources"]] == [str(img_a.id)]
    assert [r["tag"] for r in h3_reference_ordinals(resolved_ff["referenceSources"])] == ["<Picture 1>"]

    # 2. Hidden parent group excludes child video items from default canvas storyboard.audit
    hidden_group_id, hidden_spec_id, hidden_item_id = uuid4(), uuid4(), uuid4()
    projects.execute(parse_command({
        "type": "canvas.show",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "item": {
                "id": str(hidden_group_id),
                "projectId": str(project_id),
                "kind": "group",
                "position": {"x": 400, "y": 0},
                "width": 400,
                "height": 300,
                "title": "Archived Shots",
            },
        },
    }), session=session)
    projects.execute(parse_command({
        "type": "canvas.createGeneration",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "spec": {
                "id": str(hidden_spec_id),
                "projectId": str(project_id),
                "kind": "video",
                "purpose": "generation",
                "modelConfigId": model_id,
                "prompt": "Broken hidden draft",
                "parameters": {"videoMode": "first_frame", "durationSeconds": 5},
            },
            "item": {
                "id": str(hidden_item_id),
                "projectId": str(project_id),
                "kind": "video",
                "parentId": str(hidden_group_id),
                "visible": True,
                "position": {"x": 420, "y": 40},
                "binding": {"role": "generation", "objectRef": {"id": str(hidden_spec_id)}},
            },
            "references": [],
        },
    }), session=session)
    projects.execute(parse_command({
        "type": "canvas.hide",
        "projectId": project_id,
        "commandId": uuid4(),
        "expectedVersions": [{"objectType": "canvas_item", "id": str(hidden_group_id), "revision": 1}],
        "payload": {"itemId": str(hidden_group_id)},
    }), session=session)

    audit = audit_project_storyboard(projects.snapshot(project_id))
    assert [shot["specId"] for shot in audit["shots"]] == [str(spec_ff)]
    assert audit["valid"] is True

    # 3. Repeated timeline shot revision on the same (slotId, sourceId) preserves existing connection ID
    src_img_item = uuid4()
    projects.execute(parse_command({
        "type": "canvas.show",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "item": {
                "id": str(src_img_item),
                "projectId": str(project_id),
                "kind": "image",
                "position": {"x": 0, "y": 320},
                "binding": {
                    "role": "material",
                    "objectRef": {"assetId": str(img_a.id), "revision": img_a.revision, "fingerprint": img_a.fingerprint, "kind": "image"},
                },
            },
        },
    }), session=session)
    conn_id = str(uuid4())
    tl_doc_id = uuid4()
    tl_create = projects.execute(parse_command({
        "type": "editor.create",
        "projectId": project_id,
        "commandId": uuid4(),
        "payload": {
            "document": {
                "id": str(tl_doc_id),
                "projectId": str(project_id),
                "kind": "timeline",
                "inputConnections": [{
                    "id": conn_id,
                    "sourceId": str(src_img_item),
                    "slotId": "slot-1",
                    "asset": {"assetId": str(img_a.id), "revision": img_a.revision, "fingerprint": img_a.fingerprint, "kind": "image"},
                }],
                "data": {
                    "fps": 24,
                    "width": 320,
                    "height": 240,
                    "tracks": [{
                        "id": "v1",
                        "kind": "visual",
                        "title": "Main",
                        "clips": [{
                            "id": "slot-1",
                            "resource": {
                                "asset": {"assetId": str(img_a.id), "revision": img_a.revision, "fingerprint": img_a.fingerprint, "kind": "image"},
                                "title": "a.png",
                                "durationSeconds": None,
                            },
                            "inPoint": 0.0,
                            "outPoint": 5.0,
                        }],
                    }],
                    "importedAssets": [{
                        "asset": {"assetId": str(img_a.id), "revision": img_a.revision, "fingerprint": img_a.fingerprint, "kind": "image"},
                        "title": "a.png",
                        "durationSeconds": None,
                    }],
                },
            },
        },
    }), session=session)
    assert tl_create.status == "applied", tl_create
    local.release(session)

    prepared = prepare_timeline_shot_revision(
        projects.snapshot(project_id).model_dump(mode="json"),
        timeline_editor_id=tl_doc_id,
        clip_id="slot-1",
        asset_id=img_b.id,
        source_item_id=src_img_item,
    )
    assert prepared["document"]["inputConnections"][0]["id"] == conn_id
