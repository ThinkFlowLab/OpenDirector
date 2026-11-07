# Issue #87：可编辑时间线文字验收记录

2026-11-06 在 Apple M4 Pro（14 核、24 GB）、macOS 26.7.1 上验证。源码基线为 `28f30454ffba68907903c6d08db6bb8ba3b8bee2`，结果对应该基线上的 Issue #87 工作区实现；不是对未修改基线的功能声明。Python 3.12.10、Node 25.4.0（x64）、Chrome for Testing 151.0.7922.34、FFmpeg/ffprobe 8.1、fontTools 4.68.0、Pydantic 2.14.3、Mediabunny 1.62.1。未使用用户工程、用户浏览器 profile 或真实付费模型。

English summary: editable text was exercised through real UI and shared editor commands, persisted project state, native UI↔CLI package exchange, service restart, historical publication queries, and actual decoded MP4 frames. Desktop landscape/portrait H.264 outputs and the 2,000-cue measurements below are from this Mac only. A later native macOS arm64 installation and seven-browser-suite acceptance run also passed; its separate environment, wheel and measurements are recorded below. These results do not establish Windows support, background rendering, or a general performance guarantee.

## 场景与业务事实

| 场景 | 证据与范围 |
| --- | --- |
| UI 与 Agent 接续 | `timeline_text_editing.mjs` 使用真实 UI 和共用 `editor.save`，核对同一 editor/overlay 身份，中文组合输入、正文来源副本、时间、样式、字体、单步手势撤销、并发草稿与锁；模型回复不参与该测试 |
| 持久化与重开 | 浏览器脚本停止并重新启动实际隔离 API，重用同一临时项目目录，再读取正式项目和打开文字属性；不是仅刷新浏览器缓存 |
| 字体与来源 | 默认字体登记为项目 file 资产；文本素材复制后保留不可变来源；缺字、坏字体、文件缺失、资产依赖和删除保护由真实字体字节及服务测试核对 |
| 时序、中文与层次 | `timeline_text_render.mjs` 核对真实字体排版、预览/解码帧差异、独占结束帧、重叠层次、纯文字黑底和媒体结束后的文字；640×360 的字形边框差异不超过 1 输出像素，检查真实混音音频与取消清理 |
| 桌面横竖输出 | `timeline_text_desktop.mjs` 使用独立可见 Chrome 窗口及新 profile，实际生成 1920×1080 和 1080×1920 H.264、24fps、60 帧、2.5 秒 MP4；ffprobe 核对尺寸/时长，解码帧 11/12、24、36、48、59 核对黑底、中文出现、覆盖层、片尾及颜色；另保留帧 60 预览以核对独占结束 |
| 跨工程可编辑包 | `timeline_text_archive.mjs` 从 UI A 导出，真实 CLI 导入 B、导出 B，UI 导入 C；字体和正文来源获得目标工程新资产 ID，SHA-256 不变；关闭来源视图、重启服务后只打开 C 继续编辑 |
| 两份成片 | C 中正文 A/B 分别合成和发布为不同资产；真实解码帧不同，精确编辑版本分别可由历史 `object.get` 查询，旧文件指纹和 provenance 不变；成片引用实际目标字体和正文来源 |
| 导入与格式拒绝 | 新建导入保留当前未保存草稿；显式替换重新绑定并可续编。未知能力包在中英文均明确拒绝，不增加文档。含文字的 FCPXML 显示可编辑包/MP4 建议；JSON 和全画布归档的版本门禁由格式测试覆盖 |
| 双语 | 实际文字 UI 的中文/英文切换、字体显示名、属性、组合输入、导出及拒绝提示均有浏览器检查；正文和业务身份不因语言改变。长英文底部操作在 1700×1100 窗口可见 |
| 旧无文字行为 | 旧格式与原指纹由固化夹具测试覆盖；无文字视觉剪辑/音频/MP4 的浏览器回归结果在执行清单中单独记录 |

## 可复现执行

浏览器环境准备见 [验证指南](validation.md)。这些脚本自建隔离服务，均支持仓库约定的 `PYTHON`、`PLAYWRIGHT_MODULE` 和 `CHROMIUM_PATH`；桌面脚本需要真实桌面会话。不要将测试指向用户项目。

```sh
node tests/browser/timeline_text_editing.mjs
node tests/browser/timeline_text_render.mjs
node tests/browser/timeline_text_archive.mjs
node tests/browser/timeline_text_desktop.mjs
node tests/browser/timeline_workflow.mjs
```

`timeline_text_archive.mjs` 的完整执行通过，包括 UI↔真实 CLI、真实 MP4、服务重启、双语拒绝和 2,000 条 UI 编辑。`timeline_text_desktop.mjs` 的桌面输出及 600 秒实际合成通过；后续独立 ffprobe 检查确认两个性能样例均为 H.264 640×360、14,400 帧、600 秒。`timeline_text_render.mjs` 同时运行 `mp4_export.mjs`，真实音频混音通过。无文字 `timeline_workflow.mjs` 最终通过实际服务重启、顺序/变速修改、1.5 秒真实 MP4 与混音、发布、取消、缺失来源拒绝及第二份可播放导出。该旧脚本原有中文定位器依赖主机语言，本次只为测试显式设置 `zh-CN`；产品默认语言不变。

交付机器本地可复查输出位于 `test-results/issue87/desktop` 和 `test-results/issue87/archive`，含 `report.json`、选定 PNG 和真实 MP4。它们是忽略的可再生成测试输出，不是其他开发者构建或理解此文档的必需依赖。完整日志及临时工程属于本机验收材料；仓库中保留脚本和本记录以复现。

## 2,000 条 / 10 分钟测量

同一台机器、一个内置字体、2,000 条相邻非重叠文字，每条约 0.3 秒，600 秒，24fps。实际 MP4 性能比较固定为 640×360；它与上面的桌面 1080p 正确性检查是不同实验。基线与文字样例使用相同的黑色图片、时长和帧率。每个样例仅测量一次，不包含下载后的文件写盘时间。

| 实际合成样例 | 耗时 | MP4 字节 | 合成进度回调采样的最大 JS 已用堆 |
| --- | ---: | ---: | ---: |
| 无文字基线 | 36.747 秒 | 648,112 | 27,520,262 |
| 2,000 条文字 | 38.763 秒 | 1,356,395 | 29,578,344 |

本次样例中文字合成耗时多 2.016 秒（约 5.5%），文件多 708,283 字节。该差异仅用于描述这次固定样例，不是一般吞吐承诺。采样 JS 堆不包含全部原生字体、GPU、编码器、浏览器进程或系统内存，也不保证捕捉真实峰值。

真实保存的 2,000 条文档还在完整 UI 中执行 10 次正文填入、失焦提交，并等待两次 `requestAnimationFrame`。报告值包括 Playwright/CDP 往返、React 更新和等待，不能当作纯输入到像素延迟。本次打开耗时 1.254 秒，10 次样本最小 482.5 毫秒、中位数 520.6 毫秒、最大 889.1 毫秒；CDP JS 已用堆在打开前为 45,151,700 字节，编辑后为 56,389,300 字节（不是峰值或整个进程内存）。精确样本及 CDP heap 在归档脚本的 `report.json` 中记录；无文字文档没有正文编辑控件，因此没有伪造对应的无文字打字对比。此负载能编辑，但不宣称即时响应。

### 最终源码的浏览器进程 RSS 采样

为补充 JS 堆之外的内存测量，最终源码在独立可见 Chrome 中又运行相同 600 秒样例，同时每 500 毫秒通过浏览器级 CDP `SystemInfo.getProcessInfo` 获取该隔离实例 PID，再用 `ps` 读取这些进程的 RSS。保留每次 PID、父 PID、时间和数值；两阶段各取得 77 次采样、零采样错误。未计入其他 Chrome、用户浏览器、Python API、Vite 或 Node 控制进程。

| 最终源码样例 | 实际合成时间 | MP4 字节 | 采样浏览器进程 RSS 总和峰值 |
| --- | ---: | ---: | ---: |
| 无文字基线 | 37.403 秒 | 648,112 | 904,144 KiB（约 883 MiB） |
| 2,000 条文字 | 37.238 秒 | 1,356,395 | 678,304 KiB（约 662 MiB） |

该 RSS 总和可能重复计算共享页，500 毫秒采样也可能错过瞬时峰值，不能作为独占内存或整个应用内存。两阶段依次运行于完成 1080p 检查后的同一浏览器实例，先基线、后文字；热身、垃圾回收和编码器内存释放影响峰值，因此不能从此顺序实验推断文字使内存减少或性能提升。该次没有同时运行其他本任务构建或浏览器检查。真实输出再次通过 600 秒/14,400 帧、H.264、640×360 检查；完整外部采样及输出可再生成于 `test-results/issue87/desktop-rss`。初次性能基线及重复诊断仍分别保留。

## 最终字体修复复验

真实浏览器复现了未保存草稿缺字时的系统字体回退；修复后 `timeline_text_coverage.mjs` 用内置 Noto 的 `😀` 和实际 Latin-only TTF 的 `中文` 验证中英文诊断、正文保留、同一会话恢复，以及不支持正文的零绘制像素、零排版测量。未失焦输入同样能触发诊断。字体检查与实际字节 SHA-256 绑定，由本地 API 的既有静态字体解析规则提供覆盖事实；视图中自带的伪覆盖数据不能绕过检查。共用检查的取消隔离及错误后重试亦通过。

最终字体修复后又运行了文字编辑、640×360 渲染/混音/取消及真实桌面横竖 1080p 检查。第二次桌面诊断的 600 秒样例为无文字 38.109 秒、文字 38.277 秒，文件字节仍分别为 648,112 和 1,356,395。该次部分时间与其他聚焦检查重叠，因此保留为重复运行诊断，不替换上面的初次性能基线，也不据此宣称性能提升。代表记录可再生成于 `test-results/issue87/desktop-repeat`。

## 字体、安装与边界

默认字体为 Noto Sans CJK SC Regular 2.004，16,437,364 字节，SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`，附 SIL OFL 1.1；来源及固定提交写在 `public/fonts/manifest.json`，运行期间不联网下载。fontTools 精确固定为 4.68.0。仅支持静态 TTF/OTF，单字体 32 MiB，实际使用字体合计 64 MiB；原生可编辑包上限为 512 MiB，包含文档保留的全部字体、剪辑、媒体库和正文来源资源，不仅是本次成片使用的资源。

MP4 合成仍在浏览器进行，不提供关闭浏览器后的后台成片。当前没有 SRT/ASS、自动转写、通用多视觉轨或 Windows 验证声明。包操作可在编辑器关闭时由 CLI/Agent 调用，不能将这等同于后台渲染。

已观察到自身发布新成片后，打开的编辑器可能显示保守的“工程已变化”提示；测试仍能继续编辑并以正确版本发布第二份成片，历史及文件保持正确。此提示不作为已修复问题描述。

完整 Python 运行并非全绿：当次结果为 940 passed、11 failed、3 skipped。10 个非原生失败已在未修改的 `28f30454` 归档基线复现；原生 OpenCode 集成的一次运行停滞并由测试负责人终止，属于环境/终止限制。没有用删除测试、修改无关生产代码或重复执行长原生套件将其描述为通过。最终字体修复后的相关检查通过：Node 621 项、相关 Python 269 项（含 Agent 元数据）；契约生成一致性、前端构建与双语检查通过（2,921 词条、零问题）。这些聚焦结果不替代上述非全绿的完整 Python 运行。字体修复前另一次较广的非原生回归为 986 passed、8 failed、3 skipped，仅排除 `tests/test_native_runtime.py`；8 个失败均在已确认基线名单内，两个存在时序不确定性的取消测试在该次通过。该次结果同样不表示完整套件全绿。实际 wheel 验证见下方补充。

## 实际 wheel 安装验收

初次 wheel 虽含字体文件，已安装服务却未挂载 `/fonts`；此真实 404 已修复并由生产路由测试和新的实际 wheel 复验覆盖。另一次增量构建发现 setuptools `build/lib` 残留旧哈希资源，该试验包未接受；将本次忽略构建目录完整移入临时保留目录后重新构建。最终 wheel 的 18 个静态资源文件名和全部字节均与当前 `dist` 一致，无多余旧哈希文件。

接受的 wheel 为 `opendirector-0.1.0-py3-none-macosx_15_0_x86_64.whl`，86,465,373 字节，SHA-256 `c5c5511a821be6f0e2f4ba37c41a8138bea9ee3fd54a7f9a5c0bdacfa2aa64ea`。在全新隔离虚拟环境安装后，28 个依赖兼容；内置 OpenCode 1.19.5、技能、CLI、服务启动、首页/静态资源及持久化工程验证通过。默认字体离线发现、版本/字节/指纹、4,301 字节 SIL OFL 许可证，以及服务实际返回的 manifest/字体/许可证逐字节校验通过，后台 PATH 不包含 Node。该机器的 Python/Node 为 x86_64/Rosetta 环境；此产物不证明原生 arm64 wheel、Windows 或其他平台通过。

`timeline_text_installed.mjs` 直接连接该已安装后端，无 Vite 或仓库 Python 导入，使用隔离工程实际执行“添加时间线→添加文字→可见预览→缺字诊断且保留正文→修正→保存→关闭实际 API 监听→重新启动→重开正文”。测试启动和回收自己拥有的进程组，并在服务重启前确认监听已停止，避免仅重启 CLI 父进程留下子服务。代表截图、报告、wheel 与安装日志保留于 `test-results/issue87/wheel`；它们是可再生成的本地证据，不是源码依赖。

构建及安装命令遵循 [Python 安装与发布](packaging.md)。保留的安装浏览器回归可通过下面的命令对任意已安装 wheel 的隔离环境复现（并设置验证指南中的 Playwright/Chrome 环境）：

```sh
PYTHON=/absolute/path/to/wheel-venv/bin/python node tests/browser/timeline_text_installed.mjs
```

## 对照 Issue 原文的二次核对（2026-11-06）

本轮重新读取了 [Issue #87 的当前正文](https://github.com/ThinkFlowLab/OpenDirector/issues/87)及其[实施计划评论](https://github.com/ThinkFlowLab/OpenDirector/issues/87#issuecomment-6680337540)，按正文五项验收逐条核对当前工作区代码与实际结果。评论明确将字幕格式解析、自动听写及后台渲染另行规划，因此未将它们算作本轮未完成项。

| Issue 验收项 | 核对结论 | 代码与验证依据 |
| --- | --- | --- |
| UI/Agent 编辑、保存重开、撤销重做 | 当前实现满足 | `TimelineTextOverlay/TimelineTextStyle` 保留正文、时间、位置和样式；两种入口复用 `editor.create/save` 与项目历史。重新运行真实 UI 的组合输入、拖动、撤销重做、Agent 共用命令写入、冲突/锁与实际服务重启。另用两种写入来源分别修改正文、时间、位置、字号、颜色、背景、描边和层次，再执行正式 undo→重建存储读取→redo→重建存储读取，完整数据均一致。 |
| 中文、层次、位置和显示时间与实际 MP4 一致 | 当前实现满足 | 预览与导出都调用 `drawTimelineText`，共用字体准备、排版及半开帧范围。本轮重新合成并解码真实 MP4，检查帧 23/24/47/48/71/72/95/96、中文、换行、叠放、纯文字及片尾；预览比较和音频混合均通过。既有最终源码横竖 1080p 文件亦重新经 ffprobe 核对尺寸、H.264 和 60 帧。 |
| 改字后新成片与旧编辑依据分别保留 | 当前实现满足 | `timeline.publishRender` 固定 `editorDocumentId/editorRevision/sources`，历史 `object.get` 查询精确版本。本轮发布服务测试通过；另重新核对实际 A/B 成片的不同资产 ID、版本 2/3、不同且与报告一致的文件指纹，旧文件未被覆盖。 |
| 字幕/字体依赖、删除保护及可编辑导出 | 当前实现满足 | `sourceAsset` 和 `fonts[].asset` 使用真实不可变 AssetRef，参与依赖遍历、查询、删除预检和实际删除保护；本轮字体、来源与包服务测试通过。既有 UI→CLI→UI 跨工程证据重新核对来源/目标资源 ID 不同、实际字节指纹相同。原生包保留结构和资源；JSON 明确为同工程结构，含文字的 FCPXML/旧 ZIP 明确拒绝并提示替代方式。 |
| 旧剪辑、混音及无字幕导出不回退 | 覆盖的代表场景满足 | 旧提交夹具重开与重放指纹测试通过。本轮重新运行 `timeline_workflow.mjs`，实际核对顺序、变速、1.5 秒 MP4、混音、发布、取消、来源缺失拒绝、服务重启及第二份可播放输出；文字渲染脚本中的既有 MP4/混音回归也通过。 |

本次重新执行 Node 全套 621 项、相关 Python 269 项，以及 `timeline_text_editing.mjs`、`timeline_text_render.mjs` 和 `timeline_workflow.mjs`，全部通过。渲染报告位于可再生成的 `test-results/issue87/requirements-recheck/render`；本机日志为 `/tmp/issue87-requirements-{node,python,editing,render,workflow}.log`。首次渲染复验因指定的证据目录未创建而中止，补建目录后重跑通过，属于测试输出路径准备问题；未因此修改产品代码。

结论限于当前工作区实现和上述验证范围：未发现遗漏的 Issue 功能要求。Agent 验证使用共用命令、CLI/网关和隔离调用者，不等同于真实付费模型对话测试。完整 Python 套件的既有失败及原生运行限制仍适用。该轮尚未验证 Windows/原生 arm64；后续原生 arm64 补验结果见下节。改动尚未提交、创建 PR 或合并，Issue 仍保持开放；本次核对没有修改 GitHub 内容。

## 原生 macOS arm64 安装与验收（2026-11-06）

用户随后授权安装环境并补做原生 arm64 验收。沿用同一台 M4 Pro / 24 GB / macOS 26.7.1，复用已安装的 arm64 Python 3.13.12、Chrome for Testing 151.0.7922.34、FFmpeg/ffprobe 8.1 和 uv。Homebrew 两次在 OpenSSL 依赖升级处报锁冲突，未继续调整依赖；改从 Node 官方发布目录安装 `node-v24.22.1-darwin-arm64.tar.gz`，官方 SHA-256 为 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7`。新开原生 zsh 验证 Node 24.22.1 / npm 11.19.1 与 Python 均为 arm64；内置 OpenCode 1.19.5 的实际二进制也经 `file` 确认为 arm64。

原有全局 Python 软件源连接超时后，仅在本次安装/构建进程中使用官方 PyPI/npm，未修改全局源配置。原生 Node 独立位于用户目录，zsh 配置经备份后增加仅对 arm64 终端生效的 PATH 设置。现有 x64 工具及原工作区依赖保留。

从原工作区 Git 跟踪及未忽略的未跟踪文件创建独立源码快照，包含全部当前功能改动，未复制 `.git`、既有虚拟环境、构建目录、工程或凭证。快照共 752 个文件，基线仍为 `28f30454`，快照 SHA-256 为 `cabc383602bf7d6f6f8d424741a7f1841d032b62c12792650c47942cc1e13a55`；安装及测试后重新校验，752 个源码文件均未改变。独立源码目录的本机位置为 `OpenDirector-arm64-issue87`；路径和逐文件指纹仅作为可再生成的验收证据记录，不是其他开发者的构建依赖。

| 项目 | 原生 arm64 结果 |
| --- | --- |
| 源码安装 | 全新原生虚拟环境通过 editable 安装、npm ci、TypeScript/Vite 构建、pip check、环境 helper 的 installed 检查及真实 serve 启动/健康检查 |
| 运行依赖 | Python 3.13.12、Node 24.22.1、fontTools 4.68.0、FastAPI 0.162.0、Pydantic 2.14.3、Pillow 13.0.0、Starlette 1.10.0；源码环境与安装包环境分别记录 |
| 单元与服务回归 | Node 621 项、相关 Python 269 项通过；契约生成一致性和双语检查通过，2,921 词条、零问题 |
| 编辑与协作 | `timeline_text_editing.mjs` 通过真实 UI、组合输入、草稿撤销重做、共用命令、并发/锁、字体导入和实际 API 重启 |
| 排版与覆盖 | `timeline_text_render.mjs`、`timeline_text_coverage.mjs` 通过真实 MP4/预览帧比较、混音、纯文字/片尾、缺字零绘制、诊断和有效输入恢复 |
| 可编辑包 | `timeline_text_archive.mjs` 通过 UI↔CLI 跨工程导入导出、重新登记资源、服务重启、目标续编、A/B 成片发布及精确版本依据；实际文件指纹再次核对 |
| 桌面输出 | `timeline_text_desktop.mjs` 通过可见 Chrome 的 1920×1080 与 1080×1920 H.264、60 帧/2.5 秒，解码帧核对中文和层次；另通过两个 600 秒/14,400 帧样例 |
| 无文字回归 | `timeline_workflow.mjs` 通过顺序、变速、真实 MP4、混音、发布、取消、缺失来源、服务重启及第二份输出 |
| 安装包界面 | `timeline_text_installed.mjs` 通过全新 wheel 安装后的实际 UI，无 Vite、无仓库 Python 导入、后台无 Node PATH；覆盖添加文字、可见预览、缺字诊断、正文保留/恢复、保存、实际监听停止/重启及重开 |

接受的原生 wheel 为 `opendirector-0.1.0-py3-none-macosx_11_0_arm64.whl`，**81,652,959 字节**，SHA-256 `771d848268ba3dc674d04e18b85a785e34bb74f21e41ef98898e4117fcbd0eac`。全新安装环境的 pip check、内置 OpenCode、技能、CLI、真实 serve、首页/资源和持久化工程检查均通过。包内 18 个前端资源的名称和字节与该次原生构建的 `dist` 完全一致。实际安装后的离线 default-font、HTTP manifest/字体/许可证字节、16,437,364 字节字体指纹和 4,301 字节许可证均核对通过；检查没有创建用户工程。wheel 平台标签不表示已经实测所有 macOS 版本，本轮实际系统为 26.7.1。

该轮 2,000 条/600 秒、640×360、24fps 实际合成：无文字 38.478 秒，文字 38.984 秒，文件分别为 648,112 和 1,356,395 字节。500 毫秒外部浏览器 RSS 总和采样分别为 79/80 次、零采样错误，采样峰值分别为 1,024,832 / 888,560 KiB。真实 UI 2,000 条文档打开为 1.162 秒，10 次编辑样例中位数 533.4 毫秒（含 CDP 往返及两次动画帧等待）。这些仍是单次顺序实验和采样值，受热身、GC、共享页及编码器释放影响；不是独占内存、瞬时峰值或性能承诺。与此前 x64 轮次的 Python、Node 和依赖版本不同，不据此作 Rosetta/原生性能因果比较。

本轮七个浏览器脚本均退出 0，实际监听关闭已检查。首个编辑脚本成功后的临时 bind-only 检查曾因 TCP TIME_WAIT 误报，随后通过 lsof 无监听和 ECONNREFUSED 确认清理完成，改用连接拒绝检查后继续；未修改产品代码或删减测试。日志、环境/架构、源码快照、原生 wheel、MP4、PNG 和报告位于可再生成的 `test-results/issue87/arm64`。原有 x64 证据保留。

本次补验没有运行真实付费模型或重跑已知停滞的长原生 Agent 集成，也不将既有完整 Python 失败改报为通过。当前已验证范围扩展为本机 macOS x64/Rosetta 与原生 arm64；Windows 仍未验收。应用未留作后台常驻服务，原工作区仍未暂存、提交或推送。
