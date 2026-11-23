# 桌面应用

[English](desktop.md)

进程职责、工程存储和退出行为见[桌面架构](../architecture/desktop.zh-CN.md)。

## 构建与检查

在目标系统和架构上构建，需要 `.nvmrc` 指定的 Node.js、npm、uv 和独立 FFmpeg/ffprobe 二进制。最终用户无需准备这些开发工具。

```bash
npm ci --prefix apps/desktop
npm test --prefix apps/desktop
OPENDIRECTOR_FFMPEG_DIR=/absolute/path/to/standalone-media npm run prepare:runtime --prefix apps/desktop
npm run pack --prefix apps/desktop
node apps/desktop/scripts/smoke.mjs /absolute/path/to/packaged/OpenDirector
```

运行时准备复用现有构建后端生成 Python wheel，包含前端、技能和实际 OpenCode 可执行文件；将 wheel 和依赖安装到私有独立 Python，验证 CLI 帮助及两个媒体程序，并将平台写入 `runtime/manifest.json`。不会修改系统 Python。提供对应平台可分发的媒体程序及许可证；依赖包管理器外部动态库的系统二进制不能直接作为便携运行时。

冒烟检查使用临时数据目录启动实际打包程序，进入画布，拖入本地 MP4、PNG 和 WAV 文件并确认重启后素材和节点仍在，检查鉴权健康接口和工程查询，验证渲染隔离及中英文切换，隐藏窗口并确认 Host 保留，退出后重开同一工程，不调用模型服务。该检查不代表已完成 Agent 辅助创作、导出质量、签名或未测试平台的验收。

## 终端命令

通过应用菜单的“管理终端命令”在 `~/.local/bin` 安装启动器，必要时将该目录加入 PATH。应用会保留已有入口。如需卸载或修复旧安装，请检查应用显示的路径，确认入口属于 OpenDirector 后手动移除。修复时再点一次安装。`opendirector desktop` 打开此安装的桌面应用；`opendirector serve` 运行独立 API。业务命令沿用 `--url`、工程、会话和版本规则，目前不支持外部 CLI 自动连接桌面私有 Host。

## 交付边界

本模块对应 #363 的共用应用。平台安装、签名和分发由 #364–#366 负责，自动更新由 #367 负责。浏览器导出仍需应用进程参与，退出应用后不能在后台完成；首版壳未开放麦克风权限。

发布前须按 #363 在各声明平台完成干净环境验收：Agent 辅助创作与工具调用、编辑、导出、重开、故障恢复、重复启动和工程锁。冒烟通过不能替代完整验收；操作系统、架构和签名状态随平台验收证据记录。

## 发布安装包

桌面发布工作流构建 Apple Silicon DMG 和未签名的 Windows x64 NSIS 安装包。DMG 内的 App 使用 ad-hoc 签名。每个平台通过原生验证后，将安装包和 SHA-256 校验文件上传到同一个草稿 Release。macOS 任务在冒烟测试前后校验已安装 App 的签名。
