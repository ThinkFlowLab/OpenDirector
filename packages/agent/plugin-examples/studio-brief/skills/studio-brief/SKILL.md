---
name: studio-brief
description: Create a project-aware creative brief and shot outline, then publish it as an editable OpenDirector text asset without generating media.
---

# Creative brief / 创作简报

Use the user's language for the brief and reply. Work in the current OpenDirector project and preserve existing content. This skill plans creative work; it does not authorize paid generation or publishing to external services.

1. Discover the `opendirector` CLI on PATH and read its help. Read `opendirector project show` and `opendirector model list` to identify actual project assets and configured capabilities. Do not invent available material or claim to have inspected images that you have not viewed.
2. Read `templates/brief.en.md` for an English request or `templates/brief.zh-CN.md` for a Chinese request. Fill the goal, available material, shot outline and open decisions using the user's requirements and queried facts. Clearly mark creative suggestions and unknown information. Keep actual asset IDs in the material notes when useful for later work.
3. Write the completed Markdown to a new file in the turn's execution directory. Read `opendirector asset import --help`, then register that file with `opendirector asset import ./brief.md --kind text --name "Creative brief.md"` (use a Chinese name ending in `.md` for a Chinese brief). Reuse the operation ID on retries and check the receipt before claiming it was saved.
4. If the user asks to show the brief on the canvas, read the current layout and `opendirector canvas add-material --help`, then add the returned asset at an unoccupied position. Otherwise the registered asset is sufficient; do not create extra displays for inspection.
5. Report the saved brief, how to find it in the project's assets, and any decisions still needed. Uninstalling the plugin must not be described as removing this project content.

使用用户提问的语言整理目标、已有素材、分镜和待确认事项。通过现有工程 CLI 保存为文本素材，并以实际回执确认结果；不要直接改写工程文件，也不要自行提交图片或视频生成任务。
