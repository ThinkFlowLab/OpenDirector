import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommand,
  createDocument,
  createNode,
} from "../src/canvas/model.ts";
import {
  generationContent,
  generationContentPatch,
  nodeReferenceAsset,
} from "../src/canvas/generationReferenceContent.ts";
import { referenceContentCommand } from "../src/canvas/generationReferenceEdit.ts";
import {
  currentReferences,
  referencePart,
} from "../src/canvas/chatReferenceContent.ts";
import { referenceCandidates } from "../src/canvas/referenceCandidates.ts";
import { cutSelection, pasteFragment, ungroupSelection } from "../src/canvas/operations.ts";
import { parseDocument, serializeDocument } from "../src/canvas/storage.ts";
import {
  generationDefaults,
  generationReferenceIssue,
} from "../src/canvas/generationCatalog.ts";

const fixture = () => {
  const source = createNode("image", undefined, {
    title: "Image",
    src: "data:image/png;base64,AA==",
    mediaRole: "asset",
  });
  const target = createNode("image", undefined, {
    title: "Target",
    prompt: "Before after",
  });
  const doc = { ...createDocument(), nodes: [source, target] };
  return { source, target, doc };
};

test("cut detaches references and paste does not reconnect even an internal edge", () => {
  const { doc, source, target } = fixture();
  const linked = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, [
      { type: "text", text: "Keep this " },
      referencePart(nodeReferenceAsset(source)),
    ]),
  );
  const sourceOnly = cutSelection(linked, [source.id]);
  assert.equal(sourceOnly.document.edges.length, 0);
  assert.deepEqual(sourceOnly.document.nodes[0]?.data.promptContent, [
    { type: "text", text: "Keep this " },
  ]);
  const both = cutSelection(linked, [source.id, target.id]);
  assert.ok(both.fragment);
  const pasted = pasteFragment(both.document, both.fragment);
  assert.equal(pasted.document.edges.length, 0);
  assert.equal(pasted.ids.length, 2);
  assert.deepEqual(pasted.document.nodes.find((node) => node.type === "image" &&
    node.data.promptContent?.length)?.data.promptContent, [
    { type: "text", text: "Keep this " },
  ]);
});

test("ungroup retains hidden reference identities and their parent hierarchy", () => {
  const { doc, source, target } = fixture();
  const linked = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, [
      referencePart(nodeReferenceAsset(source)),
    ]),
  );
  const cut = applyCommand(linked, { type: "hide-nodes", ids: [source.id] });
  assert.equal(cut.hiddenNodes?.[0]?.id, source.id);
  assert.equal(cut.edges[0]?.source, source.id);
  assert.equal(
    cut.nodes.find((node) => node.id === target.id)?.data.promptContent?.[0]
      ?.type,
    "reference",
  );
  const group = createNode("group");
  const grouped = {
    ...cut,
    nodes: [group, ...cut.nodes],
    hiddenNodes: cut.hiddenNodes!.map((node) => ({
      ...node,
      parentId: group.id,
    })),
  };
  const ungrouped = ungroupSelection(grouped, [group.id]);
  assert.ok(ungrouped.hiddenNodes?.some((node) => node.id === group.id));
  const saved = serializeDocument(ungrouped);
  assert.equal(saved.ok, true);
});
test("inline insert/repeat/delete uses one relationship and preserves surrounding text", () => {
  const { source, target, doc } = fixture();
  const part = referencePart(nodeReferenceAsset(source, crypto.randomUUID()));
  let next = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, [
      { type: "text", text: "Before " },
      part,
      { type: "text", text: " after" },
    ]),
  );
  assert.equal(next.edges.length, 1);
  assert.equal(
    next.edges[0]!.id,
    part.type === "reference" && part.referenceId,
  );
  const repeat = [part, { type: "text" as const, text: " between " }, part];
  next = applyCommand(next, referenceContentCommand(next, target.id, repeat));
  assert.equal(next.edges.length, 1);
  next = applyCommand(next, referenceContentCommand(next, target.id, [part]));
  assert.equal(next.edges.length, 1);
  next = applyCommand(
    next,
    referenceContentCommand(next, target.id, [
      { type: "text", text: "Retained" },
    ]),
  );
  // Deleting a mention is a text edit. The connection stays until the reference
  // strip removes it, so the canvas never loses a source behind the user's back.
  assert.equal(next.edges.length, 1);
  assert.equal(next.nodes[1]!.data.prompt, "Retained");
  assert.deepEqual(next.nodes[1]!.data.promptMentions, []);
});
test("canvas connections stay out of the draft and text edits never drop them", () => {
  const { source, target, doc } = fixture();
  assert.deepEqual(
    generationContent(target, [source]).filter(
      (part) => part.type === "reference",
    ),
    [],
    "A connected source belongs in the reference strip, not in the draft",
  );
  const linked = applyCommand(doc, {
    type: "add-edge",
    edge: {
      id: "connection",
      source: source.id,
      target: target.id,
      intent: "generation_input",
    },
  });
  const typed = applyCommand(
    linked,
    referenceContentCommand(linked, target.id, [
      { type: "text", text: "只改文字" },
    ]),
  );
  assert.equal(typed.edges.length, 1);
  assert.equal(typed.nodes[1]!.data.prompt, "只改文字");
  assert.deepEqual(
    generationContent(typed.nodes[1]!, [source]).filter(
      (part) => part.type === "reference",
    ),
    [],
  );
  const unlinked = applyCommand(typed, {
    type: "remove-edges",
    ids: ["connection"],
  });
  assert.equal(unlinked.edges.length, 0);
  assert.equal(unlinked.nodes[1]!.data.prompt, "只改文字");
});
test("disconnect clears every occurrence while hide preserves references and survives storage", () => {
  const { source, target, doc } = fixture();
  const part = referencePart(nodeReferenceAsset(source, crypto.randomUUID()));
  const linked = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, [
      { type: "text", text: "Before " },
      part,
      part,
      { type: "text", text: " after" },
    ]),
  );
  const hidden = applyCommand(linked, { type: "hide-nodes", ids: [source.id] });
  assert.equal(hidden.nodes.length, 1);
  assert.equal(hidden.hiddenNodes?.[0]?.id, source.id);
  assert.equal(hidden.edges.length, 1);
  const saved = serializeDocument(hidden);
  assert.ok(saved.ok);
  if (!saved.ok) return;
  const reopened = parseDocument(saved.value);
  assert.ok(reopened.ok);
  if (!reopened.ok) return;
  assert.equal(
    generationContent(
      reopened.value.nodes[0]!,
      reopened.value.hiddenNodes ?? [],
    ).filter((p) => p.type === "reference").length,
    2,
  );
  const detached = applyCommand(linked, {
    type: "remove-edges",
    ids: [linked.edges[0]!.id],
  });
  assert.equal(detached.nodes[1]!.data.prompt, "Before  after");
  assert.deepEqual(detached.nodes[1]!.data.promptMentions, []);
});
test("following source replacement updates inline identity; fixed versions remain fixed", () => {
  const { source, target, doc } = fixture();
  const part = referencePart(nodeReferenceAsset(source, crypto.randomUUID()));
  const linked = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, [part]),
  );
  const updated = applyCommand(linked, {
    type: "update-node",
    id: source.id,
    patch: { data: { title: "Renamed", src: "data:image/png;base64,AQ==" } },
  });
  assert.equal(updated.nodes[1]!.data.prompt, "@Renamed");
  assert.equal(updated.edges[0]!.id, linked.edges[0]!.id);
  const old = {
    type: "reference" as const,
    assetId: "old",
    nodeId: source.id,
    binding: "asset" as const,
    name: "Frozen",
    fingerprint: "old",
  };
  assert.deepEqual(
    currentReferences([old], [nodeReferenceAsset(updated.nodes[0]!)]),
    [old],
  );
});
test("candidate inventory merges known ownership but never same-name independent sources", () => {
  const { source } = fixture();
  const other = createNode("image", undefined, {
    title: source.data.title,
    src: source.data.src,
  });
  const asset = {
    id: "asset",
    nodeId: source.id,
    kind: "image",
    name: "File",
    type: "image/png",
    size: 1,
    fingerprint: "same",
  };
  const choices = referenceCandidates(
    [source, other],
    [asset, { ...asset, id: "old", nodeId: undefined, available: false }],
  );
  assert.equal(choices.length, 2);
  assert.notEqual(choices[0]!.id, choices[1]!.id);
});
test("empty or over-capacity reference edits reject before publishing partial nodes or edges", () => {
  const { doc, target } = fixture();
  const empty = createNode("image");
  const part = referencePart(nodeReferenceAsset(empty, crypto.randomUUID()));
  assert.throws(
    () => referenceContentCommand(doc, target.id, [part], [empty]),
    /内容为空/,
  );
  assert.equal(doc.edges.length, 0);
  assert.equal(doc.hiddenNodes, undefined);
  const video = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
  };
  assert.match(
    generationReferenceIssue(
      createNode("video", undefined, { src: "video" }),
      video,
    )!,
    /首尾帧/,
  );
});
test("structured content round-trips independently of names and plain typed labels invent no references", () => {
  const { source, target, doc } = fixture();
  const part = referencePart(nodeReferenceAsset(source, crypto.randomUUID()));
  const patch = generationContentPatch([
    part,
    { type: "text", text: " @typed" },
  ]);
  const saved = serializeDocument({
    ...doc,
    nodes: [source, { ...target, data: { ...target.data, ...patch } }],
  });
  assert.ok(saved.ok);
  if (!saved.ok) return;
  const read = parseDocument(saved.value);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(
    read.value.nodes[1]!.data.promptContent,
    patch.promptContent,
  );
  assert.equal(patch.promptMentions?.length, 1);
});

test("copying targets preserves external sources and remaps internal and repeated fixed references", async () => {
  const { copySelection, pasteFragment } =
    await import("../src/canvas/operations.ts");
  const { source, target, doc } = fixture();
  const part = referencePart(nodeReferenceAsset(source, crypto.randomUUID()));
  const linked = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, [part, part]),
  );
  const external = pasteFragment(linked, copySelection(linked, [target.id]), {
    x: 10,
    y: 10,
  });
  const copied = external.document.nodes.at(-1)!;
  const edges = external.document.edges.filter(
    (edge) => edge.target === copied.id,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.source, source.id);
  assert.equal(copied.data.promptMentions?.[0]?.referenceId, edges[0]!.id);
  const internal = pasteFragment(
    linked,
    copySelection(linked, [source.id, target.id]),
    { x: 10, y: 10 },
  );
  const pair = internal.document.nodes.slice(-2);
  assert.equal(
    pair[1]!.data.promptContent?.find((p) => p.type === "reference")?.nodeId,
    pair[0]!.id,
  );
  const fixed = {
    type: "reference" as const,
    assetId: "asset",
    binding: "asset" as const,
    referenceId: crypto.randomUUID(),
    name: "Fixed",
    fingerprint: "frozen",
  };
  const pinned = {
    ...target,
    data: { ...target.data, ...generationContentPatch([fixed, fixed]) },
  };
  const pasted = pasteFragment(
    { ...doc, nodes: [source, pinned] },
    copySelection({ ...doc, nodes: [source, pinned] }, [target.id]),
    { x: 0, y: 0 },
  );
  const refs = pasted.document.nodes
    .at(-1)!
    .data.promptContent!.filter((p) => p.type === "reference");
  assert.equal(refs.length, 2);
  assert.equal(refs[0]!.referenceId, refs[1]!.referenceId);
  assert.notEqual(refs[0]!.referenceId, fixed.referenceId);
});

test("speech uses only authored text even when historical context remains in its document", async () => {
  const { generationPrompt } =
    await import("../src/canvas/generationReferenceContent.ts");
  const source = fixture().source;
  const content = [
    referencePart(nodeReferenceAsset(source)),
    { type: "text" as const, text: "\nRead this\nNext line" },
  ];
  const audio = createNode("audio", undefined, generationContentPatch(content));
  assert.equal(generationPrompt(audio), "Read this\nNext line");
  assert.equal(
    generationPrompt(
      createNode("audio", undefined, generationContentPatch([content[0]!])),
    ),
    "",
  );
});

test("provider inputs follow first inline occurrence rather than source placement order", async () => {
  const { incomingReferenceNodes } =
    await import("../src/canvas/generationReferenceContent.ts");
  const { doc, source, target } = fixture();
  const other = createNode("image", undefined, {
    title: "Image",
    src: "other",
  });
  const document = { ...doc, nodes: [source, other, target] };
  const content = [
    referencePart(nodeReferenceAsset(other, crypto.randomUUID())),
    referencePart(nodeReferenceAsset(source, crypto.randomUUID())),
  ];
  const linked = applyCommand(
    document,
    referenceContentCommand(document, target.id, content),
  );
  assert.deepEqual(
    incomingReferenceNodes(linked, target.id).map((node) => node.id),
    [other.id, source.id],
  );
  const withHiddenSource = {
    ...linked,
    nodes: linked.nodes.filter((node) => node.id !== other.id),
    hiddenNodes: [other],
  };
  assert.deepEqual(
    incomingReferenceNodes(withHiddenSource, target.id).map((node) => node.id),
    [source.id],
  );
  assert.deepEqual(
    incomingReferenceNodes(withHiddenSource, target.id, true).map((node) => node.id),
    [other.id, source.id],
  );
});

test("first/last frame editing fills explicit slots and rejects the third source atomically", () => {
  const images = [0, 1, 2].map((i) =>
    createNode("image", undefined, { title: `Frame ${i}`, src: `frame-${i}` }),
  );
  const target = createNode("video", undefined, {
    settings: { ...generationDefaults("video"), videoMode: "first-last" },
  });
  const doc = { ...createDocument(), nodes: [...images, target] };
  const parts = images.map((image) =>
    referencePart(nodeReferenceAsset(image, crypto.randomUUID())),
  );
  const linked = applyCommand(
    doc,
    referenceContentCommand(doc, target.id, parts.slice(0, 2)),
  );
  assert.equal(linked.edges.length, 2);
  assert.equal(
    linked.nodes.at(-1)!.data.settings?.firstFrameNodeId,
    images[0]!.id,
  );
  assert.equal(
    linked.nodes.at(-1)!.data.settings?.lastFrameNodeId,
    images[1]!.id,
  );
  assert.throws(
    () => referenceContentCommand(linked, target.id, parts),
    /最多连接 2/,
  );
  assert.equal(linked.edges.length, 2);
});

test("text context and subject resources use the same type rules as actual model inputs", async () => {
  const { generationActiveReferences } =
    await import("../src/canvas/generationCatalog.ts");
  const text = createNode("text", undefined, { text: "Instructions" });
  assert.equal(
    generationReferenceIssue(text, generationDefaults("image")),
    null,
  );
  const frame = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
  };
  assert.equal(generationReferenceIssue(text, frame), null);
  assert.equal(generationActiveReferences(frame, [text])[0]?.node.id, text.id);
  const subject = createNode("subject", undefined, {
    subject: {
      description: "",
      category: "person",
      main: { id: "main", title: "Main", kind: "video", src: "main.mp4" },
      auxiliaries: [
        { id: "aux", title: "Portrait", kind: "image", src: "portrait.png" },
      ],
    },
  });
  assert.equal(
    generationReferenceIssue(subject, generationDefaults("image")),
    null,
  );
  assert.notEqual(generationReferenceIssue(subject, frame), null);
});
