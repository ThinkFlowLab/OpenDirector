---
name: my-creative-tool
description: Prepare project-aware creative notes and save them as an editable text asset. 根据工程素材整理并保存可编辑的创作笔记。
---

# My creative tool / 我的创作工具

Use the user's language. Read `opendirector --help` and `opendirector project show`
to learn the current project and available operations. Read `templates/notes.md`,
then write `notes.md` in the execution directory using the user's requirements
and actual project facts. Label unknowns; do not invent assets or model results.

Read `opendirector asset import --help` and publish with
`opendirector asset import ./notes.md --kind text --name notes.md`.
Report success only after an applied receipt. Reuse the command ID for retries.
Do not write project storage directly or start generation without authorization.

使用用户提问的语言，通过工程查询获取真实素材，再填写笔记模板。用现有 CLI
将笔记发布为文本素材，以实际回执确认保存；保留原有素材和配置。
