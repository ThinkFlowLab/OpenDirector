# CI 失败模式

本文件记录 Release checks 与 nightly 中已知的环境或时序敏感失败模式，以及区分偶发失败与真实回归的判别方法。修复一个模式后应更新本文件；出现新模式时补入新条目。已知时序敏感用例的清单见 [`scripts/nightly/flaky-watchlist.txt`](../../scripts/nightly/flaky-watchlist.txt)，nightly 的 flake triage lane 会按它输出波动率。

## 判别偶发失败与真实回归

- 先确认失败是否可复现于同一 SHA：对比该 commit 在同一分支上的近期运行结果；一个失败随后在同 SHA 上转绿，属于偶发信号，不属于该 PR 的回归。
- Python 套件失败时查看 nightly flake triage 的分类：`flaky`（失败子集重跑通过）与 `fail`（重跑仍失败）含义不同；watchlist 用例的 3 次连跑结果给出波动率。
- Release checks 的各检查步骤相互独立运行：任何一步失败都不会掩盖其余步骤的结果，判别时逐个步骤读取结论，而不是只看 job 整体红绿。

## 已知时序敏感模式（2026-11 观测）

| 模式 | 涉及用例 | 现象 |
| --- | --- | --- |
| CLI 帮助文本受 ANSI 与终端宽度影响 | `test_cli.py::test_all_cli_business_commands_have_help`、`test_cli.py::test_parser_error_shows_specific_command_help` | 着色帮助输出导致断言不稳定 |
| worker 调度时序竞争 | `test_tool_lifecycle.py::test_another_live_worker_is_not_marked_interrupted`（`running` 与 `queued`）、`test_agent_gateway.py::test_batch_hide_is_atomic_and_replayable`（计数上限） | 并发 worker 状态翻转先于断言 |
| 字节校验缓存重写探测 | `test_creation_storage.py::test_byte_verified_cache_detects_rewrites_with_unchanged_file_signature[head]`、`[ancestor]` | 文件签名不变时缓存行为受探测顺序影响 |
| runtime readiness 探针状态 | `test_runtime_readiness.py::test_runtime_catalog_can_skip_probes_and_check_one_harness`（`not_installed` 与 `checking`） | 探针进行中状态被断言捕获 |
| 生成服务重启历史 | `test_creation_generation_service.py::test_hidden_source_generation_frozen_history_restart_and_idempotent_command` | 重启路径上偶发 IndexError |
| 视频参考验收规则 | `test_self_hosted.py::test_video_reference_acceptance_follows_model_rules` | 同一输入偶发不同判定 |

以上用例已于 2026-11-07 登记 watchlist，由 nightly 观测波动率；修复后从 watchlist 与本表移除。

## 历史注记

- 2026-11-07 前，Release checks 为单 job 顺序执行：Python 套件失败会静默跳过后续的契约检查、生产构建、wheel 验证与浏览器阶段（#158 之前，run 42224427798 印证）。现各步骤独立运行，失败不再互相掩盖。
- Release checks 现为可复用工作流 [`release-checks.yml`](../../.github/workflows/release-checks.yml)，由 [`ci.yml`](../../.github/workflows/ci.yml) 与 nightly 共用；修改检查内容时两处入口自动一致。
