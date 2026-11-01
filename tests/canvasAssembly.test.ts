import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCommand,
  createDocument,
  createNode,
  type CanvasNode,
} from "../src/canvas/model.ts";
import {
  connectedCreationKinds,
  referenceIssue,
} from "../src/canvas/connectionPolicy.ts";
import { parseDocument, serializeDocument } from "../src/canvas/storage.ts";
import { assembleNode, assemblyIssue } from "../src/canvas/editorAssembly.ts";
import { subjectWithResource } from "../src/canvas/subjectMedia.ts";
import { subjectError } from "../src/canvas/dataBoundary.ts";
import { copySelection, pasteFragment } from "../src/canvas/operations.ts";
import {
  createHistory,
  recordChange,
  undo,
  redo,
} from "../src/canvas/history.ts";
import {
  backendReferenceIssue,
  type ModelConfig,
} from "../src/backend/rules.ts";

function media(kind: "image" | "video" | "audio", seconds = 5) {
  return createNode(kind, undefined, {
    src: `data:${kind}/${crypto.randomUUID()}`,
    media: kind === "image" ? undefined : { durationSeconds: seconds },
  });
}
function connect(nodes: CanvasNode[], target: CanvasNode) {
  let doc = { ...createDocument(), nodes: [...nodes, target] };
  for (const source of nodes)
    doc = applyCommand(doc, {
      type: "add-edge",
      edge: { id: crypto.randomUUID(), source: source.id, target: target.id },
    });
  return doc;
}

test("image and video subjects expose different menus, ports and reference validation", () => {
  for (const kind of ["image", "video"] as const) {
    const source = media(kind),
      subject = createNode("subject");
    const doc = connect([source], subject);
    const subjectNow = doc.nodes.at(-1)!;
    assert.equal(subjectNow.data.subject!.main!.kind, kind);
    assert.equal(subjectNow.data.promptContent, undefined);
    const candidates = [
      "text",
      "image",
      "video",
      "audio",
      "timeline",
      "subject",
    ] as const;
    assert.deepEqual(
      connectedCreationKinds(doc, subject.id, "source", candidates),
      kind === "image" ? ["image", "video", "audio"] : ["video"],
    );
    for (const targetKind of candidates) {
      const target = createNode(targetKind);
      assert.equal(
        referenceIssue(
          { ...doc, nodes: [...doc.nodes, target] },
          subject.id,
          target.id,
        ) === null,
        (kind === "image" ? ["image", "video", "audio"] : ["video"]).includes(
          targetKind,
        ),
      );
    }
    const config = {
      inputRules: {
        allowedKinds: ["image", "video", "audio"],
        maxVideos: 1,
        maxAudios: 1,
        videoModes: ["reference"],
      },
    } as ModelConfig;
    const issue = backendReferenceIssue(
      subjectNow,
      { ...doc.settings, mode: "image" },
      config,
    );
    assert.equal(
      issue,
      kind === "video" ? "视频主体只能作为视频节点的参考" : null,
    );
  }
});

test("subject assembly fills main then three auxiliaries, rejects overflow and conflicting media atomically", () => {
  const images = Array.from({ length: 5 }, () => media("image"));
  const subject = createNode("subject");
  const doc = connect(images, subject);
  assert.equal(doc.edges.length, 4);
  const current = doc.nodes.at(-1)!;
  assert.equal(current.data.subject!.main!.nodeId, images[0]!.id);
  assert.deepEqual(
    current.data.subject!.auxiliaries.map((r) => r.nodeId),
    images.slice(1, 4).map((n) => n.id),
  );
  assert.equal(
    referenceIssue(doc, images[4]!.id, subject.id),
    "subject_capacity_exceeded",
  );
  const video = media("video"),
    audio = media("audio");
  const before = { ...doc, nodes: [...doc.nodes, video, audio] };
  for (const source of [video, audio])
    assert.equal(
      applyCommand(before, {
        type: "add-edge",
        edge: {
          id: crypto.randomUUID(),
          source: source.id,
          target: subject.id,
        },
      }),
      before,
    );
  const blank = createNode("subject"),
    long = media("video", 15.01),
    exact = media("video", 15);
  assert.equal(connect([long], blank).edges.length, 0);
  assert.equal(connect([exact], blank).edges.length, 1);
});

test("timeline assembly inserts visual and audio snapshots without creating generation references", () => {
  const sources = [media("image"), media("video", 3), media("audio", 4)];
  const timeline = createNode("timeline");
  const doc = connect(sources, timeline);
  assert.equal(doc.edges.length, 3);
  assert.ok(
    doc.edges.every((e) => e.intent === "assembly_input" && e.assemblySlotId),
  );
  const current = doc.nodes.at(-1)!;
  assert.equal(current.data.timeline!.tracks[0]!.clips.length, 2);
  assert.equal(
    current.data.timeline!.tracks.find((t) => t.kind === "audio")!.clips.length,
    1,
  );
  assert.equal(current.data.promptContent, undefined);
  assert.equal(
    referenceIssue(doc, timeline.id, sources[0]!.id),
    "source_type_unsupported",
  );
  assert.equal(
    referenceIssue(doc, sources[0]!.id, timeline.id),
    "duplicate_relation",
  );
  const disconnected = applyCommand(doc, {
    type: "remove-edges",
    ids: [doc.edges[1]!.id],
  });
  assert.equal(
    disconnected.nodes.at(-1)!.data.timeline!.tracks[0]!.clips.length,
    1,
  );
  const history = recordChange(createHistory(doc), disconnected);
  assert.deepEqual(undo(history).present, doc);
  assert.deepEqual(redo(undo(history)).present, disconnected);
  const serialized = serializeDocument(disconnected);
  assert.equal(serialized.ok, true);
  if (serialized.ok) {
    const restored = parseDocument(JSON.parse(serialized.value));
    assert.equal(restored.ok, true);
    if (restored.ok) assert.deepEqual(restored.value.edges, disconnected.edges);
  }
  const copy = pasteFragment(
    doc,
    copySelection(
      doc,
      doc.nodes.map((n) => n.id),
    ),
  );
  assert.equal(copy.document.edges.length, 6);
  const copiedTimeline = copy.document.nodes.at(-1)!;
  assert.ok(
    copy.document.edges
      .slice(3)
      .every((edge) =>
        copiedTimeline.data.timeline!.tracks.some((t) =>
          t.clips.some((c) => c.id === edge.assemblySlotId),
        ),
      ),
  );
});

test("editing an assembled subject removes obsolete links and disconnect removes bound slots", () => {
  const subject = createNode("subject"),
    images = [media("image"), media("image")];
  const doc = connect(images, subject);
  const disconnected = applyCommand(doc, {
    type: "remove-edges",
    ids: [doc.edges[0]!.id],
  });
  assert.equal(disconnected.nodes.at(-1)!.data.subject!.main, undefined);
  assert.equal(disconnected.edges.length, 0);
  const current = doc.nodes.at(-1)!;
  const edited = applyCommand(doc, {
    type: "update-node",
    id: subject.id,
    patch: {
      data: {
        subject: { ...current.data.subject!, auxiliaries: [] },
      },
    },
  });
  assert.equal(edited.edges.length, 1);
  const replaced = applyCommand(doc, {
    type: "update-node",
    id: subject.id,
    patch: {
      data: {
        subject: {
          ...current.data.subject!,
          main: {
            id: "replacement",
            kind: "image",
            title: "Replacement",
            src: "data:image/new",
          },
        },
      },
    },
  });
  assert.equal(replaced.edges.length, 1);
  assert.equal(replaced.edges[0]!.source, images[1]!.id);
  const renamed = applyCommand(doc, {
    type: "update-node",
    id: subject.id,
    patch: {
      data: {
        subject: {
          ...current.data.subject!,
          main: { ...current.data.subject!.main!, title: "Renamed" },
        },
      },
    },
  });
  assert.equal(renamed.edges.length, 2);
  const video = media("video");
  delete video.data.media;
  assert.equal(
    referenceIssue(
      { nodes: [video, subject], edges: [] },
      video.id,
      subject.id,
    ),
    "source_duration_missing",
  );
  subject.locked = true;
  assert.equal(
    referenceIssue(
      { nodes: [images[0]!, subject], edges: [] },
      images[0]!.id,
      subject.id,
    ),
    "locked",
  );
});

test("a subject node without subject data assembles instead of throwing", () => {
  const source = media("image"),
    subject = createNode("subject");
  delete (subject.data as { subject?: unknown }).subject;
  // Loading such a node is accepted, so assembly must not dereference it blindly.
  assert.equal(assemblyIssue(source, subject), null);
  const assembled = assembleNode(source, subject);
  const data = assembled.node.data.subject!;
  assert.equal(data.main?.nodeId, source.id);
  assert.deepEqual(data.auxiliaries, []);
});

test("subject media picks share the slot rules so an invalid subject is never built", () => {
  const audio = media("audio"),
    image = media("image"),
    video = media("video", 20);
  const resource = (node: CanvasNode) => ({
    id: node.id,
    kind: node.type as "image" | "video" | "audio",
    title: node.data.title,
    src: node.data.src!,
    ...node.data.media,
  });
  // Voice without a main image used to reach the document and block every save.
  assert.throws(() => subjectWithResource(undefined, resource(audio)), /主图片/);
  assert.throws(() => subjectWithResource(undefined, resource(video)), /15 秒/);
  const filled = subjectWithResource(undefined, resource(image));
  assert.equal(filled.main?.id, image.id);
  assert.equal(subjectError(filled), null);
});
