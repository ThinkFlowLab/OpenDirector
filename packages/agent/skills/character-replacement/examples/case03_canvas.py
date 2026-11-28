"""Prepare the Case03 draft and a separate group.publishRun command."""

import argparse
import json
from pathlib import Path
import sys
from uuid import UUID, uuid4


HERE = Path(__file__).parent
FPS = 24
WIDTH, HEIGHT = 832, 480
SEED = 0
PORTRAIT_ROLES = ("Center performer", "Right foreground", "Left background", "Left foreground", "Right background")


def asset_ref(asset):
    return dict(assetId=asset["id"], revision=asset["revision"],
                fingerprint=asset["fingerprint"], kind=asset["kind"])


def version(kind, obj):
    return dict(objectType=kind, id=obj["id"], revision=obj["revision"])


def case03_inputs(snapshot, args, frame_plan):
    assets = {asset["id"]: asset for asset in snapshot["assets"]}

    def require_asset(identity, kind, label):
        asset = assets.get(str(identity))
        if asset is None or asset["kind"] != kind:
            raise ValueError(f"{label} needs a registered {kind} asset in this project.")
        return asset

    master = require_asset(args.master, "video", "Normalized source")
    source = {row["id"]: require_asset(getattr(args, f"source_{row['id'].lower()}"), "video", f"Input {row['id']}")
              for row in frame_plan["segments"]}
    portraits = [require_asset(identity, "image", f"Picture {index}") for index, identity in enumerate(args.portrait, 1)]
    soundtrack = require_asset(args.soundtrack, "audio", "Delivery soundtrack")
    duration = frame_plan["totalFrames"] / FPS
    if master["metadata"].get("frameRate") not in (None, FPS):
        raise ValueError("Normalize the complete source to 24 FPS before adding the group.")
    if (soundtrack["metadata"].get("durationSeconds") or 0) < duration:
        raise ValueError(f"The delivery soundtrack must cover {duration:g} seconds from the start.")
    return master, source, portraits, soundtrack


def build_commands(snapshot, args):
    project_id = snapshot["project"]["id"]
    frame_plan = json.loads((HERE / "case03-frame-plan.json").read_text(encoding="utf-8"))
    prompts = json.loads((HERE / "case03_prompts.json").read_text(encoding="utf-8"))
    rows = {row["id"]: row for row in frame_plan["segments"]}
    master, source, portraits, soundtrack = case03_inputs(snapshot, args, frame_plan)
    operations = []
    expected = {}

    def add(kind, **payload):
        operations.append(dict(type=kind, payload=payload))

    def expect(kind, obj):
        expected[(kind, obj["id"])] = version(kind, obj)

    def show(identity, kind, title, left, top, **fields):
        item = dict(id=str(identity), projectId=project_id, kind=kind,
                    title=title, position=dict(x=left, y=top), **fields)
        add("canvas.show", item=item)
        return {**item, "revision": 1}

    visible = [item for item in snapshot["canvasItems"] if item["visible"]]
    by_id = {item["id"]: item for item in visible}
    existing_material = {}
    for item in visible:
        if item["binding"]["role"] == "material":
            ref = item["binding"]["objectRef"]
            key = (ref["assetId"], ref["revision"], ref["fingerprint"])
            existing_material.setdefault(key, item)

    def material(asset, title, left, top, *, parent=None, width=260, height=146):
        key = (asset["id"], asset["revision"], asset["fingerprint"])
        item = existing_material.get(key)
        if item is None:
            item = show(uuid4(), asset["kind"], title, left, top, parentId=parent, width=width, height=height,
                        binding=dict(role="material", objectRef=asset_ref(asset)))
            existing_material[key] = item
        return item

    if args.existing_group:
        group = by_id.get(str(args.existing_group))
        if (group is None or group["kind"] != "group" or group["parentId"] is not None
                or group.get("assembly") is not None or group.get("runPlan") is not None):
            raise ValueError("Select the visible top-level Case03 draft group.")
        children = [item for item in visible if item["parentId"] == group["id"]]

        def child(kind, title_prefix):
            matching = [item for item in children if item["kind"] == kind and item["title"].startswith(title_prefix)]
            if len(matching) != 1:
                raise ValueError(f"The imported draft needs one {kind} titled {title_prefix!r}.")
            return matching[0]

        segment_items = {key: child("video", f"Segment {key} ·") for key in rows}
        timeline = child("timeline", "Case03 ·")
        preview = next((item for item in children if item["kind"] == "text"
                        and item["title"] == "Case03 · Draft plan"), None)
        if preview:
            expect("canvas_item", preview)
            add("canvas.hide", itemId=preview["id"])
        if group["title"] != "Case03 · H3 Agentic Continuation":
            expect("canvas_item", group)
            add("canvas.update", itemId=group["id"], title="Case03 · H3 Agentic Continuation")
            group = {**group, "revision": group["revision"] + 1}
        old_document = next(doc for doc in snapshot["editorDocuments"] if doc["id"] == timeline["binding"]["objectRef"]["id"])
        document_id = old_document["id"]
        specs = {spec["id"]: spec for spec in snapshot["generationSpecs"]}
        spec_ids = {key: segment_items[key]["binding"]["objectRef"]["id"] for key in rows}
        x, y = group["position"]["x"], group["position"]["y"]
        assets_parent = None
    else:
        right_edge = max((item["position"]["x"] + item["width"] for item in visible if item["parentId"] is None), default=-100)
        x, y = args.origin or (max(0, right_edge + 100), 0)
        assets_parent = show(uuid4(), "group", "Case03 · Inputs", x, y, width=1700, height=460)["id"]
        group = show(uuid4(), "group", "Case03 · H3 Agentic Continuation", x, y + 540, width=1700, height=820)
        spec_ids = {key: str(uuid4()) for key in rows}
        document_id = str(uuid4())

    def position(left, top):
        return (left, top) if assets_parent else (x + left, y - 500 + top)

    material(master, "Case03 · Normalized source 24 FPS", *position(24, 45), parent=assets_parent)
    source_items = {key: material(asset, f"Source {key} · Prepared input", *position(304 + index * 270, 45),
                                  parent=assets_parent, width=245, height=138)
                    for index, (key, asset) in enumerate(source.items())}
    portrait_items = [
        material(asset, f"Picture {index + 1} · {role}", *position(24 + index * 190, 244),
                 parent=assets_parent, width=160, height=150)
        for index, (asset, role) in enumerate(zip(portraits, PORTRAIT_ROLES))
    ]
    audio_item = material(soundtrack, "Case03 · Delivery soundtrack", *position(990, 244),
                          parent=assets_parent, width=310, height=120)

    current_refs = {}
    if args.existing_group:
        for ref in snapshot["references"]:
            if ref["active"]:
                current_refs.setdefault(ref["targetSpecId"], []).append(ref)
        # Pin exactly the existing source and portrait relations, preserving IDs and order.
        for key, row in rows.items():
            expected_sources = [source_items[key], *[portrait_items[i - 1] for i in row["portraits"]]]
            if row.get("guide"):
                expected_sources.append(segment_items[row["guide"]["segment"]])
            refs = current_refs.get(spec_ids[key], [])
            if len(refs) != len(expected_sources):
                raise ValueError(f"Segment {key} does not have its complete original Case03 references.")
            remaining = {ref["id"]: ref for ref in refs}
            ordered = []
            for item in expected_sources:
                match = [ref for ref in remaining.values() if (
                    (ref["binding"] == "follow_current" and ref["source"]["id"] == item["id"])
                    or (ref["binding"] == "pinned" and (ref.get("sourceVersion") or {}).get("id") == item["id"])
                )]
                if len(match) != 1:
                    raise ValueError(f"Segment {key} reference does not match {item['title']!r}.")
                ordered.append(remaining.pop(match[0]["id"]))
            current_refs[spec_ids[key]] = ordered

    guide_ids = {key: (current_refs[spec_ids[key]][-1]["id"] if args.existing_group else str(uuid4()))
                 for key, row in rows.items() if row.get("guide")}
    if not args.existing_group:
        segment_items = {}
    for index, (key, row) in enumerate(rows.items()):
        parameters = dict(videoMode="reference", durationSeconds=row["rawFrames"] / FPS, aspectRatio=args.aspect_ratio,
                          resolution=args.resolution, generateAudio=True, seed=SEED, h3Segment={})
        if key in guide_ids:
            parameters["h3Segment"] = dict(guideReferenceId=guide_ids[key], sourceFrames=row["guide"]["frames"])
        new_spec = dict(id=spec_ids[key], projectId=project_id, kind="video", purpose="generation",
                        modelConfigId=str(args.model), prompt=prompts[key], parameters=parameters)
        if args.existing_group:
            old = specs[spec_ids[key]]
            expect("generation_spec", old)
            add("generationSpec.update", spec={**old, **new_spec, "promptContent": None})
        else:
            add("generationSpec.create", spec=new_spec)
            segment_items[key] = show(uuid4(), "video", f"Segment {key} · {row['title']}", 24 + index % 3 * 465,
                                      44 + index // 3 * 302, width=429, height=248, parentId=group["id"],
                                      binding=dict(role="generation", objectRef=dict(id=spec_ids[key])))

    for key, row in rows.items():
        materials = [(source[key], source_items[key]), *[(portraits[i - 1], portrait_items[i - 1]) for i in row["portraits"]]]
        old_refs = current_refs.get(spec_ids[key], [])
        for order, (asset, item) in enumerate(materials):
            prior = old_refs[order] if old_refs else None
            identity = prior["id"] if prior else str(uuid4())
            ref = dict(id=identity, projectId=project_id, targetSpecId=spec_ids[key], order=order, role="reference",
                       binding="pinned", source=asset_ref(asset), sourceVersion=version("canvas_item", item))
            if prior:
                expect("reference", prior)
                add("reference.update", reference={**ref, "revision": prior["revision"]})
            else:
                add("reference.add", reference=ref)
        if row.get("guide") and not args.existing_group:
            add("reference.add", reference=dict(
                id=guide_ids[key], projectId=project_id, targetSpecId=spec_ids[key], order=len(materials),
                role="reference", binding="follow_current", source=dict(id=segment_items[row["guide"]["segment"]]["id"]),
            ))

    delivery_seconds = frame_plan["totalFrames"] / FPS
    audio = dict(asset=asset_ref(soundtrack), title="Delivery soundtrack",
                 durationSeconds=soundtrack["metadata"]["durationSeconds"])
    connection = dict(id=str(uuid4()), sourceId=audio_item["id"], slotId="soundtrack", asset=audio["asset"])
    data = dict(width=args.width, height=args.height, fps=FPS, importedAssets=[audio], tracks=[
        dict(id="visual", kind="visual", title="Replacement footage"),
        dict(id="audio", kind="audio", title="Delivery soundtrack", clips=[
            dict(id="soundtrack", resource=audio, start=0, inPoint=0, outPoint=delivery_seconds),
        ]),
    ])
    if args.existing_group:
        expect("editor_document", old_document)
        add("editor.save", document={**old_document, "inputConnections": [connection], "data": data})
    else:
        add("editor.create", document=dict(id=document_id, projectId=project_id, kind="timeline",
                                          inputConnections=[connection], data=data))
        timeline = show(uuid4(), "timeline", "Case03 · Assembly timeline", 954, 346, width=450, height=253,
                        parentId=group["id"], binding=dict(role="editor", objectRef=dict(id=document_id, kind="timeline")))

    entries, clips = [], []
    for entry in frame_plan["timeline"]:
        start, end = entry["source"]
        if entry["owner"] == "source":
            entries.append(dict(kind="source", sourceStart=start, sourceEnd=end))
            continue
        key = entry["segment"]
        row = rows[key]
        item_id = segment_items[key]["id"]
        guide = row.get("guide")
        step = (dict(kind="continuation", upstreamItemId=segment_items[guide["segment"]]["id"],
                     sourceFrames=guide["frames"]) if guide else dict(kind="anchor"))
        entries.append(dict(kind="generated", itemId=item_id, sourceStart=start, sourceEnd=end, shot="case03", step=step))
        start, end = entry["keep"]
        clip = dict(itemId=item_id, inFrame=start, outFrame=end)
        if "reverseLimit" in row:
            clip.update(reverse=True, frameLimit=row["reverseLimit"])
        clips.append(clip)
    diagram = (
        "```text\n"
        "Source order:  [0,80)    [80,180)   [180,308)  [308,444)  [444,648)\n"
        "Delivery:      A         B          C          D          E\n"
        "Model inputs:  A [0,84)r B [62,180)r C [158,308) D [286,444) E [422,648)\n"
        "Generation:    B (anchor, rev) --[guide 96,117]--> A (rev)\n"
        "               B --[guide 21,0]--> C --[guide 128,149]--> D --[guide 136,157]--> E\n"
        "```\n\n"
    )
    notes = diagram + (
        "B 从五人同框的一端倒放生成。B 先反向接 A，再正向接 C → D → E。"
        "A、B 倒放指定前缀后裁切。成片按 A → B → C → D → E 组装。"
        if args.plan_locale == "zh-CN" else
        "B generates in reverse, starting from the end that shows all five people. B guides A backward "
        "and C → D → E forward. Reverse the specified prefixes before trimming A and B, then assemble A → B → C → D → E."
    )
    envelope = dict(type="group.publishRun", expectedVersions=[version("canvas_item", group)], payload=dict(
        groupId=group["id"], planLocale=args.plan_locale, planNotes=notes,
        assembly=dict(timelineItemId=timeline["id"], outputItemId=str(uuid4()), clips=clips),
        plan=dict(source=asset_ref(master), fps=FPS, frameCount=frame_plan["totalFrames"], entries=entries),
    ))
    batch = dict(type="creation.batch", expectedVersions=list(expected.values()), payload=dict(operations=operations))
    return batch, envelope


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, help="JSON from opendirector project show (defaults to stdin).")
    parser.add_argument("--model", type=UUID, required=True, help="Guide-capable FastH3 model configuration ID.")
    parser.add_argument("--master", type=UUID, required=True, help="Complete 648-frame 24 FPS source video asset ID.")
    parser.add_argument("--existing-group", type=UUID, help="Prepare the already imported Case03 draft group.")
    parser.add_argument("--publish-file", type=Path, required=True, help="Write the separate group.publishRun command here.")
    parser.add_argument("--plan-locale", choices=("en-US", "zh-CN"), default="en-US")
    parser.add_argument("--resolution", choices=("480P", "768P"), default="480P")
    parser.add_argument("--aspect-ratio", default="16:9")
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    for segment in "abcde":
        parser.add_argument(f"--source-{segment}", type=UUID, required=True, help=f"Prepared source {segment.upper()} asset ID.")
    parser.add_argument("--portrait", type=UUID, action="append", required=True,
                        help="Registered portrait asset ID. Pass five in Case03 order.")
    parser.add_argument("--soundtrack", type=UUID, required=True, help="Dedicated delivery-audio asset ID.")
    parser.add_argument("--origin", type=int, nargs=2, metavar=("X", "Y"), help="Start position of a new Case03 layout.")
    args = parser.parse_args()
    if len(args.portrait) != 5 or len(set(args.portrait)) != 5:
        parser.error("Supply five distinct portrait assets in Case03 order.")
    if (args.width is None) != (args.height is None) or (args.aspect_ratio != "16:9" and args.width is None):
        parser.error("Supply both output dimensions when overriding the default 16:9 geometry.")
    if args.width is None:
        args.width, args.height = (WIDTH, HEIGHT) if args.resolution == "480P" else (1344, 768)
    if any(value <= 0 or value % 2 for value in (args.width, args.height)):
        parser.error("Output dimensions must be positive even numbers.")
    try:
        snapshot = json.loads(args.snapshot.read_text(encoding="utf-8")) if args.snapshot else json.load(sys.stdin)
        batch, envelope = build_commands(snapshot, args)
        args.publish_file.write_text(json.dumps(envelope, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(batch, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
