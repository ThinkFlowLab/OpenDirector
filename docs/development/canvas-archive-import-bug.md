# 画布导出后无法导入 —— 缺陷分析与修复

**日期**：2026-11-05
**版本**：main @ 0a5630ac
**现象**：画布「导出画布」生成的 `.canvas` 文件，再「导入画布」时失败；生成图片节点全部丢失。
**状态**：已修复（归档格式 v2 + `imported` provenance）。

---

## 0. 修复摘要

| 项 | 内容 |
|---|---|
| 归档格式 | `formatVersion: 1` → `2`，`manifest.assets[]` 新增 `provenance` |
| 后端 | 新增 `AssetProvenance.source = 'imported'` 与 `importedFrom` 字段 |
| 后端 | 新增受信任导入通道：`X-Canvas-Import: generated\|edited` 请求头 |
| 前端 | `registration` 携带来源；`cloneGeneration` 仅在归档带来源时成立 |
| 兼容 | v1 旧包仍可导入，生成节点降级为普通素材 |
| 安全 | 普通上传伪造生成节点**仍然被拒绝**（已实测） |

实测 A/B 对比（对运行中的服务）：

```
A. 归档来源的生成节点
   素材 provenance: imported / importedFrom=generated
   creation.batch: 200
   画布节点数: 1
     image 图片生成 | binding: generation

B. 对照组：普通上传冒充生成节点（应被拒绝）
   素材 provenance: upload
   creation.batch: 200（含 issues）
   <- invalid_input  Image overrides require recorded generation or edit provenance
```

---

## 1. 结论摘要

导入失败**不是**文件损坏或格式不兼容，而是**前端导入逻辑与后端领域校验的约定不一致**。

具体来说：`.canvas` 归档只保存画布文档和媒体字节，**不保存素材的来源凭据（provenance）**。导入时，前端的 `prepare()` 会为"生成类"图片节点构造一个 `materialOverride` 绑定，把素材指向刚上传的图片；但上传素材的来源是 `source='upload'`，而后端 `ProjectSnapshot` 校验要求 `materialOverride` 指向的素材必须是 `generated` 或 `edited`。校验直接拒绝整批操作，导入失败。

**触发条件（同时满足）**：画布中存在至少一个 `type=image` 且 `data.mediaRole === "generation"` 且有实际图片内容的节点。

---

## 2. 复现

### 2.1 实测复现

用真实工程数据在领域层直接复现：

```
=== 原工程里 role=generation 的图片节点 ===
  图片生成        override=无  provenance=None
  图片主体替代     override=无  provenance=None
  图片 3          override=无  provenance=None
  图片 1          override=无  provenance=None

导入后（上传素材 source=upload）:  校验失败 ->
  Value error, Image overrides require recorded generation or edit provenance
手工素材 source=manual:  校验失败 ->
  Value error, Image overrides require recorded generation or edit provenance
```

### 2.2 界面复现

在 GUI 中导入 `图像创作示例画布.canvas`，会新建一个同名的空工程 `…（2）`：

```
提交记录（导入过程）：
  <id>  project.create              nodes=0 assets=0
  <id>  asset.import                nodes=0 assets=2
  <id>  asset.import                nodes=0 assets=3
  <id>  asset.writeText             nodes=0 assets=4
  <id>  asset.import                nodes=0 assets=5
  <id>  asset.import                nodes=0 assets=6
  <id>  creation.batch              nodes=0 assets=6
          issues=[{"code": "invalid_input",
                   "message": "Value error, Image overrides require recorded
                               generation or edit provenance"}]
  <id>  asset.import                nodes=0 assets=7
  <id>  asset.import                nodes=0 assets=8
```

**工程被创建了、素材被导入了，但画布节点一个都没写进去。** 用户看到的是一个只有素材库、画布空空的新工程。

---

## 3. 根因分析

### 3.1 导出侧：归档不携带 provenance

`src/canvas/canvasArchive.ts` 的 `buildCanvasArchive()`：

```ts
export const MEDIA_FIELDS = new Set(["src", "sourceImageUri", "output"]);
```

导出只做一件事——把 `src` / `sourceImageUri` / `output` 里的 data URL 抽取成 `assets/` 下的独立文件，并把字段改写成相对路径。节点数据（`mediaRole`、`generationEvidence`、`backendAssetId` 等）原样保留，这没问题。

问题在于 **`.canvas` 的格式里根本没有"素材来源"这个概念**。`manifest.json` 只记录：

```json
{
  "magic": "opendirector-canvas",
  "formatVersion": 1,
  "name": "...",
  "exportedAt": "...",
  "document": "canvas.json",
  "assets": [{ "path": "...", "mimeType": "...", "byteSize": 123, "sha256": "..." }]
}
```

`assets[]` 里只有路径、MIME、大小和哈希，**没有 `provenance`**。归档天然无法表达"这张图是某次生成任务的产物"。

这本身是合理的设计取舍（导出的是画布，不是工程历史），但导入侧没有相应地处理这个信息缺失。

### 3.2 导入侧：把生成节点当成了"生成节点 + 上传素材"

导入流程 `importWorkspaceDocument()` → `populateWorkspaceProject()` → `saveWorkspaceDocument()` → `CanvasProjection.save()` → `prepare()`。

`prepare()` 里 `src/backend/creationProjection.ts:1219-1254`：

```ts
const cloneGeneration =
  !item &&                                    // 新节点（导入时必然成立）
  binding?.role === "material" &&             // 素材已上传
  node.data.mediaRole === "generation";       // 画布节点自认为是"生成节点"

if (binding?.role !== "material" || configureText || cloneGeneration) {
  const spec = { ...this.specInput(node, current),
                 ...(cloneGeneration ? { purpose: "generation" as const } : {}) };
  ...
  if (cloneGeneration && binding?.role === "material")
    binding = {                                    // ← 危险赋值
      role: "generation",
      objectRef: { objectType: "generation_spec", id: spec.id },
      materialOverride: binding.objectRef,          // 指向刚上传的素材
    };
}
```

`cloneGeneration` 为真时，代码把节点升级成"生成节点"，并给它挂一个 `materialOverride`，指向**刚通过 `/uploads/{handle}` 上传的那张图**。

这个分支的本意是处理"从别的画布复制一个生成节点过来"的场景——此时源素材在其原工程里确实有 `generated` 来源。但导入 `.canvas` 时，素材是**新上传的**，来源根本不是 `generated`。

### 3.3 后端：校验正确地拒绝了

`packages/core/src/opendirector/domain/creation/project.py:95-98`：

```python
# Retained images are verified generation outputs or published edits.
if item.kind == 'image' and item.binding.materialOverride:
    output = assets[item.binding.materialOverride.assetId]
    if output.provenance.source not in {'generated', 'edited'} or \
       (output.provenance.source == 'edited' and not output.provenance.sources):
        raise ValueError('Image overrides require recorded generation or edit provenance')
```

上传素材的来源在 `creation_assets.py:113` 被固定为：

```python
provenance=provenance or AssetProvenance(source='upload')
```

`'upload' ∉ {'generated', 'edited'}`，于是抛出 `ValueError`。

**这条校验是好设计**：`materialOverride` 的语义是"这是该生成节点的保留产物"，如果随便指向一张上传图，就等于伪造了生成结果，会破坏候选版本、追溯、审计等一整套语义。校验拦得对。

**错在前端**：它构造了一个自己无法满足前置条件的绑定。

### 3.4 完整因果链

```
用户导出画布
  → buildCanvasArchive() 抽出媒体字节，只留相对路径
  → manifest.assets[] 不含 provenance（格式本身不表达来源）
        ↓
用户导入画布
  → readCanvasArchive() 把字节内联回 data URI，文档结构完整还原
  → importWorkspaceDocument() 新建工程
  → prepare() 遍历节点：
       node.type=image && data.mediaRole="generation"
       且 mediaChanged 为真（src 是新 data URI，old 为空）
       → 走 else 分支，binding = { role:"material", objectRef: 上传素材 }
       → cloneGeneration = true
       → binding = { role:"generation", materialOverride: 上传素材 }   ← ★
  → client.batch([...])
        ↓
后端 ProjectSnapshot 校验
  → assets[materialOverride.assetId].provenance.source == 'upload'
  → 'upload' ∉ {'generated','edited'}
  → ValueError: Image overrides require recorded generation or edit provenance
        ↓
整批 creation.batch 被拒 → 画布 0 节点
```

**★ 处就是缺陷点。**

---

## 4. 为什么测试没发现

`tests/canvasArchive.test.ts:313` 的往返测试：

```ts
test("an exported archive imports back with its media, settings and edges", async () => {
  const image = createNode("image", { x: 0, y: 0 }, {
    src: "data:image/jpeg;base64,aGVsbG8=",
    mimeType: "image/jpeg",
    title: "女王1.jpg",
  });
  const video = createNode("video", { x: 400, y: 0 }, {
    src: "data:video/mp4;base64,dmlkZW8=",
    mimeType: "video/mp4",
    title: "原版.mp4",
  });
  ...
  assert.deepEqual(contents.document, document);   // 只比对文档，未过后端
});
```

两个缺口：

1. **没有 `mediaRole: "generation"` 的图片节点** —— 只用普通素材节点，`cloneGeneration` 恒为 false，碰不到问题分支。
2. **只测到文档层，没测到持久化层** —— 断言是 `contents.document` 与原文档相等，验证的是"解压+内联"这一步；完全没有经过 `prepare()` 生成操作，也没有经过 `ProjectSnapshot` 校验。而缺陷恰恰发生在这两步之间。

也就是说：**导出的"打包/解包"是对的，坏在"文档 → 工程"的翻译环节**，而这一段没有针对归档导入的测试。

---

## 5. 影响范围

| 场景 | 是否受影响 |
|---|---|
| 画布含生成类图片节点（`mediaRole=generation`）且有图 | **失败**，导入得到空画布 |
| 画布只有普通素材节点（上传图、视频、音频、文本） | 正常 |
| 画布含生成节点但尚未出图（`src` 为空） | 正常（不走 `materialChanged`） |
| 文本类生成节点（`type=text`） | 正常（`cloneGeneration` 只对 `binding.role==="material"` 生效，文本走 `canvas.configure`） |
| **隐藏的生成类图片节点（`hiddenNodes`）** | **同样失败** |

### 5.0 隐藏节点也参与导入

`prepare()` 的可写集合包含隐藏节点（`creationProjection.ts:1113-1116`）：

```ts
const writableNodes = [
  ...document.nodes,
  ...(document.hiddenNodes ?? []).filter((node) => !items.has(node.id)),
];
```

而两个实际归档里都有隐藏的生成类节点：

| 归档 | 可见节点 | 隐藏节点 | 其中 `mediaRole=generation` 的隐藏节点 | 导入结果 |
|---|---|---|---|---|
| `图像创作示例画布.canvas` | 12 | 9 | `图片 1`、`图片 2`（image） | **失败** |
| `视频创作示例画布.canvas` | 17 | 12 | `视频 1`（video） | 成功 |

注意后端校验只针对 `item.kind == 'image'`（`project.py:95`），所以隐藏的**视频**生成节点不会触发失败，隐藏的**图片**生成节点会。

这意味着**即使可见节点里没有生成图片，只要隐藏节点里有，导入依然会失败**。用户肉眼看不到这些节点，排查时极难定位——这是本缺陷最隐蔽的一面。

实测对照：

- `图像创作示例画布.canvas` —— 含 3 个生成图片节点（`图片生成`、`图片主体替代`、`图片 3`） → **导入失败**，工程被创建、8 个素材入库，但画布 **0 节点**
- `视频创作示例画布.canvas` —— 以视频 / 图片 / 文本节点为主，无生成图片节点 → **导入成功**，17 个节点全部落地

这说明失败与画布内容强相关，而非文件损坏。

### 5.1 另一个独立问题：重复导入产生同名分组

对同一画布反复导入到同一工程时，分组不会复用，而是每次新建一个同名分组：

```
id=5a341594  rev=7  '三、主体替换：引用原片与新主体，换掉角色'   成员 0
id=7fba0467  rev=5  '三、主体替换：引用原片与新主体，换掉角色'   成员 0
id=ababbf48  rev=2  '三、主体替换：引用原片 + 新主体图，换掉画面里的角色'  成员 3
```

10 个分组里只有 5 个是唯一的。包内 17 个节点都成功落地，且都挂在**新**分组下（成员 2/3/3/3），旧分组变成空壳留在画布上。

这不影响数据完整性（没有 `parentId` 指向不存在的分组），但会让画布出现成堆的空同名分组。属于需要单独修复的导入幂等性问题，与本报告的主缺陷独立。

---

## 6. 实施的修复

目标是**完整的导入导出**：生成节点往返之后仍然是生成节点，图片、视频、文本、分组、隐藏节点、时间线、引用关系全部保留。

### 6.1 归档格式 v2：携带来源

`manifest.assets[]` 新增 `provenance` 字段：

```json
{
  "path": "assets/图片生成.png",
  "mimeType": "image/png",
  "byteSize": 2451,
  "sha256": "…",
  "provenance": { "source": "generated", "jobId": "…", "inputFingerprint": "…" }
}
```

导出侧（`canvasArchive.ts`）：`visit()` 从节点的 `data.generationProvenance` 取来源，随 `register()` 写入归档；子节点继承父级来源。

投影侧（`creationProjection.ts`）：`toDocument` 把素材的 `provenance` 写进 `node.data.generationProvenance`，让导出有据可依。

### 6.2 后端：诚实的 `imported` 来源

**没有**放宽原有校验，而是新增一个明确的语义：

```python
source: Literal[..., 'imported'] = Field(...)
importedFrom: Literal['generated', 'edited'] | None = Field(default=None, ...)

# 互斥约束：imported 必须带来源，其他来源不得带
if self.source == 'imported' and self.importedFrom is None:
    raise ValueError('Imported assets record the source they were exported from')
if self.source != 'imported' and self.importedFrom is not None:
    raise ValueError('Only imported assets carry an archive source')
```

`project.py` 的保留产物校验相应接纳 `imported`：

```python
retained = output.provenance.source in {'generated', 'edited', 'imported'}
```

**为什么是 `imported` 而不是伪造 `generated`**：`generated` 要求真实的 `jobId` 与 `inputFingerprint`，而导出包里没有任务记录。伪造会污染审计链。`imported` 如实表达"这张图是从归档带进来的生成产物"，语义准确且可追溯。

### 6.3 受信任的导入通道

沿用现有 `artifact.publish` / `job.checkpoint` 的防护思路：来源由**入口**决定，不由载荷决定。

```python
@router.post('/projects/{project_id}/commands')
async def execute(..., x_canvas_import: str | None = Header(default=None)):
    if x_canvas_import is not None and value.type != 'asset.import':
        raise ProjectError('归档来源只能随素材导入声明。', 400)
    imported_from = x_canvas_import if x_canvas_import in {'generated', 'edited'} else None
    if x_canvas_import is not None and imported_from is None:
        raise ProjectError('归档来源必须是 generated 或 edited。', 400)
```

三道防线：

1. 只有 `asset.import` 接受该头，其他命令一律 400
2. 取值仅限 `generated` / `edited`
3. 应用层同样拦截（`creation_assets.py`、`creation_projects.py` 各一道）

### 6.4 导入侧：不再伪造绑定

```ts
const cloneGeneration =
  !item &&
  binding?.role === "material" &&
  node.data.mediaRole === "generation" &&
  // Only an archive that recorded where the picture came from may
  // rebuild the generation binding; a bare upload cannot be one.
  !!this.archiveSource(node);
```

`archiveSource()` 把 `generated → "generated"`、`edited`/`rendered → "edited"`，其余返回 `undefined`。素材上传时该来源随 `importBlob` → `registerUpload` → 命令头一路传递。

**旧包（v1）兼容**：没有 `provenance` 时 `archiveSource()` 返回 `undefined`，`cloneGeneration` 为假，节点降级为普通素材——图片正常显示，只是不再关联生成配置。不会报错，也不会伪造来源。

### 6.5 修复过程中的二次回归：`素材节点不能直接改为生成节点`

第一版修复让 `cloneGeneration` 成立后，导入仍然失败，前端提示「素材节点不支持导入」。根因是**操作序列不完整**：

`cloneGeneration` 分支只修改了前端的本地 `binding` 变量，把它改成 `generation`，但**没有发出任何让后端升级绑定的操作**。后端收到的只有 `canvas.materialize`（素材绑定），随后 `canvas.configure` 尝试把素材节点转成生成节点，被 `creation_canvas.py` 拒绝：

```python
# creation_canvas.py:528
if binding['role'] == 'material' and not (item['kind'] == 'text' and payload.preserveMaterial):
    raise ContractError('role_restricted', '素材节点不能直接改为生成节点。', payload.itemId)
```

这条限制是合理的：素材节点转生成节点是语义跃迁，只对文本开放了 `preserveMaterial` 例外。**图片素材节点没有合法的事后升级路径。**

正确做法是**一开始就以生成绑定创建节点**，而不是先建素材再升级：

```ts
// canvas.show 对新节点直接采用传入的 binding，不做升级限制
binding = {
  role: "generation",
  objectRef: { objectType: "generation_spec", id: spec.id },
  materialOverride: binding.objectRef,
};
```

由于 `generationSpec.create` 先于 `canvas.show` 入队，spec 在节点落地时已存在，`ProjectSnapshot` 的一致性校验也能通过。

**附带修复的回归**：给 `importResource` 的缓存 key 加 `importedFrom` 时，最初把它插在中间，破坏了 `editorData` 预置缓存使用的 `::<kind>:<src>` 格式，导致 mask 字节被重复下载。改为**仅当有来源时追加后缀**，无来源时 key 与原来逐字节一致。

### 6.6 真实数据暴露的两个根因

前面两轮修复都只是在单元测试层面对，**拿真实工程导出再导入仍然得到 0 节点**。用两个工程的真实归档逐层追踪后，才找到真正的两处断点。

**根因一：`parseNodeData` 把 `generationProvenance` 静默丢弃。**

`src/canvas/dataBoundary.ts` 是节点数据的白名单解析器，`mediaRole` 在白名单里、`generationProvenance` 不在。于是：

```
导出：17 个节点带 generationProvenance    ✓
读取：provenance 映射 8 条                 ✓
节点：带 generationProvenance 的 0 个      ✗  ← 白名单丢弃
```

`archiveSource()` 因此永远返回 `undefined`，`cloneGeneration` 永远为假，导入的生成节点全部退化成普通素材。这个字段是我上一轮新加的，加的时候漏了读取侧的白名单——**写入通、读取断**，测试又只覆盖了写入，所以两轮都没抓到。

修复：把 `generationProvenance` 加入白名单，并配套 `isGenerationProvenance()` 校验（来源必须是已知集合、可选字段类型正确）。校验不是可有可无的：归档是不可信输入，一个伪造的 `source` 会直接被当作来源证据交给后端。

**根因二：分组晚于成员创建，整批被 `missing_object` 拒绝。**

修好根因一后，`creation.batch` 终于发出了 52 个操作，但被整批拒绝：

```
missing_object 业务对象不存在。 objectId=15cf263e (分组「图片生成」)
```

原因是 `prepare()` 按 `document.nodes` 的**视觉顺序**遍历，而分组在视觉上排在成员之后（分组框先画、成员后补是常见操作顺序）：

```
#1  canvas.show  图像生成   parentId -> 分组 15cf263e
#4  canvas.show  图片生成   parentId -> 分组 15cf263e
#5  canvas.show  分组 图片生成            ← 分组到这里才创建
```

批量操作按序执行，#1 引用的父组尚不存在，整批回滚。6 个分组共 11 个成员全部踩中。

修复：新增 `parentsFirst()`，按 `parentId` 做拓扑排序后再遍历。存在环时回退到原始顺序，而不是丢节点——环本该由后端拒绝，前端不该替它做决定。

### 6.7 端到端验证（真实工程）

用 `图像创作示例画布` 真实导出再导入，逐项比对：

| 指标 | 原工程 | 导入后 |
| --- | --- | --- |
| 节点 | 21 | 21 |
| 生成节点（带 materialOverride） | 6 | 6 |
| 生成规格 | 8 | 8 |
| 分组 | 6 | 6 |
| 悬空 `parentId` | 0 | 0 |
| 素材 `importedFrom=generated` | — | 3 |

素材来源分布 `{manual: 3, imported: 3, upload: 2}`：只有真正来自生成的 3 张图拿到 `imported` 来源，上传的参考图仍是 `upload`，没有伪造。

### 6.8 待办：重复导入的同名分组

`prepare()` 按节点 `id` 匹配，分组因 `baseline` 无同 id 元素而全部新建，反复导入会累积同名空分组（实测 10 个分组只有 5 个唯一）。

这**不影响数据完整性**（无悬空 `parentId`），但影响观感。建议后续在导入时按标题复用已有分组，或改为"总是新建工程"。本次未改动此行为，因为它与主缺陷相互独立。

---

## 7. 回归测试

```ts
test("an archive with generation nodes imports without fabricating provenance", async () => {
  const document = createDocument("生成节点往返");
  document.nodes = [createNode("image", { x: 0, y: 0 }, {
    src: "data:image/png;base64,aGVsbG8=",
    mimeType: "image/png",
    title: "图片生成.png",
    mediaRole: "generation",            // ← 关键
  })];
  const archive = await buildCanvasArchive(document, { read: ... });
  const contents = await readCanvasArchive(archive.blob);

  // 必须真的走一遍 prepare + ProjectSnapshot 校验
  const { operations } = await projection.prepare(contents.document);
  const item = operations
    .filter((op) => op.type === "canvas.show")
    .map((op) => op.payload.item)
    .find((i) => i.kind === "image")!;

  assert.equal(item.binding.role, "material");       // 不得是 generation
  assert.equal(item.binding.materialOverride, undefined);
});
```

关键点：**断言必须落在 `prepare()` 产出的操作上**，而不只是文档内容。当前测试正是止步于文档，才漏掉了这个缺陷。

---

## 8. 附：相关代码位置

| 位置 | 作用 |
|---|---|
| `src/canvas/canvasArchive.ts` | 打包/解包，v2 携带 `provenance` |
| `src/canvas/model.ts` | `CanvasNode.data.generationProvenance` |
| `src/canvas/CanvasWorkspace.tsx:2533-2551` | `importDocument()`，UI 入口 |
| `src/backend/workspace.ts:136-152` | `importWorkspaceDocument()`，新建工程 |
| `src/backend/creationProjection.ts` `toDocument` | 投影时写入 `generationProvenance` |
| `src/backend/creationProjection.ts` `archiveSource` | **本次修复的新增判定** |
| `src/backend/creationProjection.ts` `cloneGeneration` | 仅在归档带来源时升级为生成节点 |
| `src/backend/creationClient.ts` `prepareCommand` | 发送 `X-Canvas-Import` 头 |
| `apps/api/.../creation.py` `execute` | 受信任入口，校验导入头 |
| `packages/core/.../domain/creation/assets.py` | `imported` 来源与互斥约束 |
| `packages/core/.../domain/creation/project.py` | 保留产物校验，接纳 `imported` |
| `packages/core/.../application/creation_assets.py` | 构造 `imported` provenance 并拦截越权 |
| `tests/canvasArchive.test.ts` | 含生成节点往返 + v1 兼容两组新增用例 |
| `tests/fixtures/creation-project.json` | 契约 fixture，已同步 `importedFrom` |

### 验证记录

```
tests/canvasArchive.test.ts                10 passed, 0 failed
tests/archiveGenerationImport.test.ts      2 passed, 0 failed（新增：导入操作序列）
全量前端测试                              563 passed, 0 failed
tests/test_creation_*.py (assets/contracts/api)  122 passed, 1 failed*
tsc --noEmit                               无错误
vite build                                 ✓ built in 5.14s
```

\* 失败项为 `test_symlinked_content_and_asset_paths_are_rejected_without_external_writes`，原因是当前 Windows 账户缺少创建符号链接的权限（`WinError 1314`）。**已确认该用例在未改动的基线上同样失败**，与本次改动无关。

---

## 9. 第二轮：`视频创作示例画布.canvas` 暴露的两个阻塞点

issue #256 报告的是同一层缺陷的另一次表现。用真实归档跑完整导入链路（真实 API 进程 + 真实 `readCanvasArchive` / `importWorkspaceDocument`）后，共发现两个阻塞点，前一个掩盖了后一个。

### 9.1 阻塞点一：毫秒取整让每个非整毫秒片段都越界

| 环节 | 值 |
|---|---|
| 素材实际时长（ffprobe） | `5.041667`（121 帧 ÷ 24 fps） |
| 生成结果 API 上报 | `durationMs = round(5.041667 × 1000)` = `5042` |
| 前端 `tools.ts` 反算 | `5042 / 1000` = **`5.042`** |
| 时间线 `outPoint`（直接取自该值） | **`5.042`** |
| 导入时重新探测 | `5.041667` |
| 溢出 | **`+0.000333` 秒 = 原容差 `1e-6` 的 333 倍** |

取整最多引入半毫秒误差，容差却只有 `1e-6` 秒，因此**任何帧数不能被 1000 整除的素材在导入时都必然失败**，与用户数据无关。

修复：`TIMELINE_DURATION_EPSILON = 0.0005`（半毫秒，即取整能引入的最大误差），由 `rule_facts.py` 经 `facts_payload()` 导出到 `src/contracts/ruleFacts.generated.ts`。服务端三处（`project.py`、`creation_timeline.py`、`creation_timeline_packages.py`）与客户端 `dataBoundary.ts` 共用该常量。

同时把「时长未知」的语义统一：**未知时长无法证明越界**，三处服务端与客户端一律跳过比较。此前 `project.py` 放过、另两处拒绝，同一份文档会在不同关卡得到相反结论。

### 9.2 阻塞点二：归档里存在过期的装配链接

时长校验放行后，导入推进到装配校验并报「装配素材与来源节点当前内容不一致，请重新读取。」（`creation_canvas.py`）。

根因不是文件损坏，而是**归档忠实记录了编辑过程中形成的不一致**：

| 对象 | 素材 |
|---|---|
| 源节点 `97c7546b`「主体替换结果」当前素材 | `主体替换结果.mp4` |
| 隐藏时间线 clip `e810ff2f`（来源标为 `97c7546b`） | `把画面中的主体替换为…mp4` |

用户装配之后重新生成过该节点，片段保留了装配当时的那份素材。这在**实时工程里是被容忍的**——服务端对值未变的既有连接直接跳过校验（`previous_inputs`），而导入时连接全是新的、没有「既有值」，于是按全新装配严格校验并拒绝。

修复落在翻译层（`creationProjection.editorInput`）：**新连接必须指向源节点当前素材；已登记的连接原样保留。**

- 已登记（`current.inputConnections` 中存在同 id 且资产引用相同）→ 保留，服务端照旧跳过，实时工程行为不变。
- 未登记且 `clip.resource.src !== 源节点.data.src` → 判定为过期链接，只丢弃链接、**保留片段本身**（片段的素材是用户的编辑内容）。

媒体经 `readCanvasArchive` 还原为 data URL，内容相同的素材串相同，因此 `src` 比较等价于字节比较。

### 9.3 真实归档验证

导入 `视频创作示例画布.canvas`（26,128,975 字节，17 可见 + 12 隐藏节点）后：

| 指标 | 结果 |
|---|---|
| 导入结果 | 成功，新建工程 |
| 素材 | 18 |
| 画布节点 | 29 |
| 时间线文档 | 2（可见 2 片段 / 隐藏 4 片段） |
| 可见时间线装配连接 | 2（全部保留） |
| 隐藏时间线装配连接 | 3（原有 4，丢弃过期 1 条） |
| 过期片段的素材 | 保留，片段仍在时间线内 |
| 全部片段 `outPoint` 相对实测偏差 | `+0.000333` 秒，均被容忍 |

### 9.4 本次新增回归测试

| 测试 | 锁定内容 |
|---|---|
| `test_creation_timeline_render.py::test_timeline_accepts_a_clip_rounded_to_the_nearest_millisecond` | 毫秒取整偏差不再被判越界；`1e-6` 下失败、`0.0005` 下通过 |
| `test_creation_timeline_render.py::test_timeline_skips_the_duration_check_when_the_asset_was_never_measured` | 未知时长与客户端一致跳过 |
| `test_creation_timeline_render.py::test_timeline_rejects_clip_beyond_actual_duration_even_when_client_claims_longer` | 真正越界仍被拒绝（原有） |
| `archiveGenerationImport.test.ts::a clip still carrying the media it was assembled with keeps its link` | 正常装配链接不被误删 |
| `archiveGenerationImport.test.ts::an archive whose clip outlived a regenerated source imports without the stale link` | 过期链接被丢弃、片段保留 |

### 9.5 教训：测试替身掩盖了真实校验

既有导入测试（`backendWorkspace.test.ts` / `archiveGenerationImport.test.ts`）把 `client.batch` 与 `fetch` 全部替换为桩，因此**从未执行服务端校验**，两个阻塞点都能顺利通过。本次改为启动真实 API 进程、用真实 `readCanvasArchive` 读取真实归档来驱动导入，才复现出用户看到的报错。

凡涉及「文档 → 工程」翻译层的缺陷，验证必须经过真实服务端校验。
