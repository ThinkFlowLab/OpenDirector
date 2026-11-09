import assert from "node:assert/strict";
import test from "node:test";
import { creationClient } from "../src/backend/creationClient.ts";
import {
  submitToolTask,
  waitForToolTask,
  toolTaskMessage,
  type ToolTask,
} from "../src/backend/tools.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

test("structured matting failures survive changed backend wording in both locales", () => {
  const task: ToolTask = {
    id: "task", tool: "video-matting", status: "failed", outputs: [],
    phase: null, error: "Backend wording has changed entirely.",
  };
  try {
    for (const locale of ["zh-CN", "en-US"] as const) {
      setActiveLocale(locale);
      for (const [code, expected] of [
        ["tool_concept_translation", locale === "zh-CN" ? "改用简短的英文描述" : "short English description"],
        ["tool_no_video_match", locale === "zh-CN" ? "视频中没有识别到" : "Could not find"],
      ]) {
        const message = toolTaskMessage({ ...task, errorDetails: { code, params: { label: "三花猫" } } })!;
        assert.ok(message.includes(expected));
        assert.ok(message.includes("三花猫"));
      }
    }
  } finally {
    setActiveLocale("zh-CN");
  }
});

test("tool cancellation messages distinguish stopping, remote acknowledgement and historical uncertainty", () => {
  const task: ToolTask = {
    id: "task",
    tool: "outpaint",
    status: "cancelled",
    outputs: [],
    phase: null,
    error: "已取消。",
  };
  assert.match(toolTaskMessage(task)!, /历史记录.*未提供.*确认/);
  const requested = {
    ...task,
    cancelRequested: true,
    localState: "stopping" as const,
  };
  assert.match(toolTaskMessage(requested)!, /停止处理中/);
  for (const [state, expected] of [
    ["requested", "等待远端确认"],
    ["confirmed", "远端已确认取消"],
    ["unknown", "远端取消结果未知"],
    ["unsupported", "远端不支持取消"],
    ["not_applicable", "尚未提交模型调用"],
    ["not_required", "已有结果与执行记录已保留"],
    ["not_requested", "尚未向远端发送取消请求"],
  ] as const)
    assert.ok(
      toolTaskMessage({
        ...requested,
        localState: "stopped",
        remoteCancellation: state,
      })!.includes(expected),
    );
});

test("interrupted tool jobs report the original remote execution without suggesting resubmission", () => {
  const task: ToolTask = {
    id: "task",
    tool: "outpaint",
    status: "interrupted",
    outputs: [],
    phase: null,
    error: null,
    modelCalls: [{ state: "running" }],
  };
  assert.match(toolTaskMessage(task)!, /远端任务仍在运行/);
  assert.match(
    toolTaskMessage({ ...task, modelCalls: [{ state: "unknown" }] })!,
    /结果未知.*核对原任务/,
  );
  assert.match(
    toolTaskMessage({ ...task, modelCalls: [{ state: "succeeded" }] })!,
    /已登记结果已保留/,
  );
});

test("tool submission forwards the selected model with its saved source and editor versions", async () => {
  const fetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const projectId = crypto.randomUUID();
  const modelId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const sourceNodeId = crypto.randomUUID();
  const editorId = crypto.randomUUID();
  creationClient(projectId).snapshot = {
    canvasItems: [
      {
        id: sourceNodeId,
        revision: 3,
        editors: [{ kind: "media_edit", id: editorId }],
      },
    ],
    editorDocuments: [
      {
        id: editorId,
        revision: 4,
        kind: "media_edit",
        data: { sources: [{ assetId: sourceId }] },
      },
    ],
  } as unknown as ProjectSnapshot;
  let submitted: Record<string, unknown> | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval: () => 1, addEventListener: () => {} },
  });
  globalThis.fetch = (async (url, options) => {
    const path = String(url);
    if (path.startsWith("data:")) return fetch(url, options);
    if (path.endsWith("/open")) return new Response(null, { status: 204 });
    if (path.endsWith("/assets")) return Response.json([]);
    if (path.includes("/assets/")) return Response.json({ id: sourceId });
    if (path.endsWith("/tool-tasks")) {
      submitted = JSON.parse(String(options?.body));
      return Response.json({ id: "selected-model-task" });
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof globalThis.fetch;
  try {
    await submitToolTask(
      {
        id: crypto.randomUUID(),
        canvas: { nodeId: sourceNodeId, sourceNodeIds: [sourceNodeId] },
        documentId: projectId,
        documentTitle: "改图测试",
        tool: "smart-edit",
        sources: [
          {
            kind: "image",
            title: "原图",
            src: "data:image/png;base64,aW1hZ2U=",
          },
        ],
        parameters: { prompt: "换成红色外套" },
        modelConfigIds: { "image.edit": modelId },
      },
      new AbortController().signal,
    );
    assert.deepEqual(submitted?.modelConfigIds, { "image.edit": modelId });
    assert.deepEqual(submitted?.sourceAssetIds, [sourceId]);
    assert.deepEqual(submitted?.draft, {
      itemId: sourceNodeId,
      itemRevision: 3,
      editorId,
      editorRevision: 4,
    });
  } finally {
    globalThis.fetch = fetch;
    if (windowDescriptor)
      Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a status read stalled in transit is abandoned and retried instead of hanging the follow loop", async () => {
  const fetch = globalThis.fetch;
  const seen: string[] = [];
  let reads = 0;
  globalThis.fetch = (async (
    url: string | URL | Request,
    options?: RequestInit,
  ) => {
    const path = String(url);
    seen.push(path);
    if (path.includes("/tool-tasks/") && ++reads === 1)
      // The first read never answers, like a request stuck in a tunnel.
      return new Promise((_, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(options!.signal!.reason),
        ),
      );
    if (path.includes("/tool-tasks/"))
      return Response.json({
        id: "task",
        tool: "outpaint",
        status: "succeeded",
        phase: null,
        error: null,
        outputs: [
          {
            id: "asset",
            kind: "image",
            name: "扩图.png",
            type: "image/png",
            title: "扩图",
          },
        ],
      });
    return new Response(new Blob(["png"], { type: "image/png" }));
  }) as typeof globalThis.fetch;
  try {
    const files = await waitForToolTask(
      "project",
      "task",
      new AbortController().signal,
      undefined,
      {
        status: 50,
        download: 1000,
      },
    );
    assert.equal(reads, 2);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.file.name, "扩图.png");
    assert.ok(
      seen.some((path) =>
        path.endsWith("/creation/projects/project/assets/asset/content"),
      ),
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("a rejected status read is reported, not retried", async () => {
  const fetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return Response.json(
      { detail: "工具任务不存在。", code: "not_found" },
      { status: 404 },
    );
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      waitForToolTask("project", "task", new AbortController().signal),
      /工具任务不存在/,
    );
    assert.equal(reads, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});
