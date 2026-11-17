# Python CI layer assessment / Python CI 分层评估

This topic record explains the first evidence-based classification under #273. Commands and permanent validation rules belong to [the validation guide](validation.md#python-分层与迁移--python-layers-and-transition); the PR coverage floor belongs to [`tests/ci_ready_contract.json`](../../tests/ci_ready_contract.json).

本专题记录 #273 首批基于证据的分类。固定命令与验证规则维护在验证指南，PR 最低保护清单维护在 JSON 契约；本文件不另建一套执行规则。

## Measurement / 测量

Sample: [CI run 43175876148](https://github.com/ThinkFlowLab/OpenDirector/actions/runs/43175876148), 2026-11-12. PR head `05b9ebac`; tested merge SHA `2f9b88eebaa24e773ffe882e0ea5b728be6be593`. Ubuntu 22.04, Python 3.12.16, pytest 9.1.1. Source: `python-test-evidence-1`, containing separate JSON/Markdown/JUnit for the main suite and bundled OpenCode. All models are mocked; file/media validation is real where the tests require it.

样本来自上述运行，完整 Python 退出码为 0：1736 passed、100 skipped，收集 1836 个用例，pytest profile 墙钟时间 373.50 秒。独立 bundled OpenCode 为 5 passed、47.55 秒，不与主套件中的同名 skip 混算。profile 包含 setup/call/teardown，不含依赖安装；该 Python job 安装锁定依赖另用约 44 秒，不能靠移走测试省掉这部分。

The main suite completed successfully: 1736 passed, 100 skipped, 1836 collected, 373.50 profile wall seconds. The separate bundled OpenCode sample completed 5 cases in 47.55 wall seconds. Do not conflate those executions with skips in the main suite. Profile times include setup/call/teardown, excluding dependency installation (about 44 seconds in this job).

This first decision uses one per-test Linux sample, not a stable percentile or a promised speedup. Compare later successful samples with the same platform, phase, dependency versions and meaningful scenario coverage. It does not establish Windows-native, real-provider or GPU performance. A passing rerun also does not erase earlier failures: the prior voice lane failed waiting for save with open-canvas 409 responses, while this sample's voice lane passed without a voice-code change; the cause remains separate from Python layer classification.

首轮决策依据一个逐用例 Linux 样本，不足以建立稳定分位数或承诺提速，也不能推断 Windows 原生权限、真实服务或 GPU 表现。先前 voice lane 保存等待失败且 open-canvas 返回 409，本次未修改 voice 代码却通过；不能据此声称已修复，也不能通过改为 nightly 隐藏失败。

## Cost and decisions / 成本与分类

Module seconds are sums of observed test phases, not predicted workflow savings. Shared fixtures, installation, job scheduling and the browser critical path mean removing a measured second from ready does not guarantee a second less in PR wall time.

模块秒数是实测阶段耗时累计，不是 CI 墙钟提速预测；共享夹具、安装和浏览器关键路径会影响实际效果。

| Module / 模块 | Observed seconds / 实测秒 | Decision / 决策 |
| --- | ---: | --- |
| `test_native_runtime.py` | 129.68 | Already merge; keep the dedicated bundled CLI regression / 已属 merge，独立 bundled CLI 回归仍保留 |
| `test_tool_tasks.py` | 29.50 | Move two full reshoot/piecewise-media cases, keep validation/output/cancel representatives / 移动两个完整媒体流程，保留校验、输出与取消代表 |
| `test_creation_storage.py` | 13.26 | Move only the 199-revision cache scenario; preserve replay/recovery/concurrency / 仅移动 199 次修订缓存场景，保留幂等、恢复和并发 |
| `test_deepseek_runtime.py` | 11.53 | Move the three full ACP transcript/write modes; keep protocol/private-config checks / 移动三个完整 ACP 模式，保留协议和私有配置检查 |
| `test_creation_timeline_render.py` | 11.04 | Keep ready: publication, provenance, versions, locks and actual media bounds / 保留 ready，保护发布、来源、版本、锁与实际媒体边界 |
| `test_jiuwenswarm_runtime.py` | 9.87 | Move five complete write/trace modes; keep protocol and failure propagation / 移动五个完整写入模式，保留协议与失败传播 |
| `test_cli.py` | 8.66 | Keep ready; do not move the help/watchlist cases just to reduce time / 保留 ready，不以减耗时为由移走 help/watchlist |
| `test_creation_parameters.py` | 8.57 | Keep ready: shared input/type boundaries / 保留共享输入与类型边界 |
| `test_kling_video.py` | 7.51 | Keep ready: model/reference rules; module total alone is insufficient / 保留模型与参考规则，不仅按模块总耗时移动 |
| `test_timeline_packages.py` | 7.14 | Move one live gateway/CLI 5 MiB roundtrip; keep basic import and scope rejection / 移动一次大包完整往返，保留基本导入与范围拒绝 |

The first move covers 12 collected cases in five modules, accounting for 44.16 phase seconds in this sample:

首批为五个模块的 12 个用例，本样本累计 44.16 秒：

| Selector / 选择器 | Cases / 数量 | Seconds / 秒 | Why merge / 原因 |
| --- | ---: | ---: | --- |
| `test_creation_storage.py::test_long_history_is_validated_from_disk_only_once` | 1 | 10.16 | 199 real commits and full-chain cache proof / 199 次真实提交和完整历史缓存 |
| `test_deepseek_runtime.py::test_acp_shared_write_and_native_trace` | 3 | 11.11 | ACP subprocess, project write, trace, continuation / 子进程、写入、轨迹与续接 |
| `test_jiuwenswarm_runtime.py::test_project_write_and_trace` | 5 | 9.41 | Complete native protocol mode matrix / 完整原生协议模式矩阵 |
| `test_tool_tasks.py::test_partial_reshoot_redraws_only_its_window` | 1 | 2.42 | Real audio/video reconstruction of a selected window / 实际音视频窗口重构 |
| `test_tool_tasks.py::test_long_video_edit_runs_piecewise_and_subtitles_default_to_the_bottom_band` | 1 | 7.86 | Multi-part 20-second edit plus subtitle processing / 分片长视频与字幕处理 |
| `test_timeline_packages.py::test_live_agent_gateway_package_roundtrip_scopes_files_without_large_json` | 1 | 3.21 | Gateway, disk archive, subprocess CLI, scoped re-import / 网关、大包、CLI 与范围导入 |

No assertion, parameter case, execution environment gate or watchlist entry is removed. No new case is moved to nightly. Module marks are not used to sweep fast critical cases into merge.

不删除断言、参数用例、能力门禁或 watchlist 条目，不新增 nightly 分类，也不通过整个模块标记把快速关键用例一起移走。

## Coverage floor and conservation / 保护清单与覆盖守恒

The contract now covers 15 capability groups and 45 parameter-expanded Python cases, plus browser MP4 export. All 45 representatives passed in the baseline sample. Local full collection after adding audit regression tests contains 1851 cases: 1805 ready, 42 merge and 4 nightly; 1715 remain transitional/unmarked ready. Baseline function/parameter counts are preserved, with 15 new layer-audit cases; exactly 12 common IDs change from ready to merge, with no overlapping layers. Three raw parameter IDs differ between Linux and local Windows because they embed interpreter paths or generated PNG bytes. Those test sources are unchanged; exact raw-ID conservation must be checked against a subsequent same-platform sample rather than silently normalizing distinct cases.

清单覆盖 15 项能力、45 个展开后的 Python 用例及浏览器 MP4 导出；45 个代表在基线样本均通过。本地完整收集为 1851：ready 1805、merge 42、nightly 4，其中 1715 个未显式分类，仍属于 ready。基线各函数的参数用例数量保留，新增 15 个核对测试，12 个共同 ID 从 ready 改为 merge。Linux 与 Windows 有 3 个原始参数 ID 因解释器路径或动态 PNG 字节而不同，这两份测试源码未改；后续需用同平台样本核对原始 ID，不能静默归一化并声称完全一致。

The audit rejects missing/duplicate IDs, conflicting marks, filtered inventories, representatives outside ready and loss of the browser export gate. With `--require-executed`, skipped or unexecuted representatives are not treated as proof. This protects selection and minimum execution evidence; it does not certify every creative requirement or replace full media/output acceptance.

核对会拒绝漏收集、重复 ID、冲突标记、过滤后的清单、代表被移出 ready 或导出 gate 丢失；要求执行证据时，skip 和未执行不算通过。这是最低选择与执行保护，不代表完整创作质量或输出验收。

All live PR/main/nightly callers still select the full Python suite. These labels do not reduce the current release bar. Before switching PRs to ready, retain an independent full-collection audit and enable the complete merge-queue gate; measure the actual ready workflow before claiming end-to-end savings or tightening its timeout.

现有 PR/main/nightly 仍调用全量 Python，分类不会提前缩小发布门槛。切换 ready 前必须保留完整收集核对并接通合并队列完整门禁；真正运行 ready 工作流后，才评估端到端耗时和是否收紧超时。
