# 桌面架构

[English](desktop.md)

桌面应用在同一台机器上运行共用的 Web UI 和 Python API。Electron 管理原生窗口并启动 Python Host。Host 运行[统一项目服务](unified-project.md)和 [Agent Runtime](agent-runtime.md)。

```mermaid
flowchart LR
    Renderer["Web 渲染进程"] -->|"opendirector://app"| Main["Electron 主进程"]
    Main -->|"带凭证的回环 HTTP 请求"| Host["Python Host"]
    Main -.->|"私有标准输入输出控制管道"| Host
    Host --> Store["工程存储"]
```

## Electron 管理到 Host 的连接

主进程启动随包提供的 Python，通过控制管道把本次启动的凭证交给 Host。Host 在 `127.0.0.1` 上绑定系统分配的端口，就绪后报告地址。主进程收到就绪消息后打开 Web UI。

渲染进程通过 `opendirector://app` 请求应用页面、媒体和 API 资源。主进程转发请求时附带启动凭证，Host 验证凭证后处理请求。渲染进程关闭 Node 集成并开启上下文隔离。预加载脚本提供有限的桌面接口，包括登记编辑会话、同步语言和导出状态。

渲染进程权限默认全部拒绝，只对 `opendirector://app` 开放一份显式清单（见 [`permissions.mjs`](../../apps/desktop/src/permissions.mjs)）：点击激活的 `navigator.clipboard.writeText` 申请的 `clipboard-sanitized-write`，以及 `requestFullscreen` 使用的两种全屏权限。读写剪贴板名称不授予：界面里的复制都由点击发起，渲染进程也从不读取系统剪贴板，授予它等于给页面一项没有调用方的能力。全屏若不授予，申请 Promise 会一直挂起，播放器的全屏按钮会静默失效。已安装包的冒烟检查会断言点击激活的复制确实写入系统剪贴板、无用户激活的写入被拒绝且不改变剪贴板内容，并断言全屏能够进入也能够退出。新增任何渲染进程权限都属于策略变更，不是界面细节。

## Host 管理工程状态

Host 与独立 API 共用工程存储、命令校验和编辑会话规则。桌面壳管理窗口，并通过原生对话框选择文件和保存下载。

安装包提供 Web UI、Python 运行时和内置工具。Host 将工程和配置写入 Electron 用户数据目录下的 `workspace/`。该用户数据目录也保存桌面日志和语言缓存。源码版和 pip 安装版已有的工作区保留在原位置。

## 关窗后 Host 继续运行

关闭主窗口会隐藏界面，正在进行的工作可以继续。退出应用时，主进程先检查本地 Agent 运行、生成任务、工具任务和渲染进程的导出状态，再停止 Host。中断正在进行的工作前，主进程会请用户确认。Host 在停止时释放由该桌面实例登记的编辑会话。父进程的控制管道断开后，Host 也会开始清理。

退出本机应用后，供应商可能继续执行已提交的任务并产生费用。浏览器导出需要渲染进程保持运行。

构建命令、CLI 注册和发布检查见[桌面应用开发指南](../development/desktop.zh-CN.md)。
