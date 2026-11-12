# Editing session reloads / 编辑会话刷新

## English

The browser stores an editing owner and its last issued generation in
`sessionStorage`. Only a reload resumes that owner. Ordinary navigation creates
a new owner, including a popup that inherited a copy of its opener's storage.
This preserves the existing single-window project lease rule.

Each explicit `POST /api/creation/projects/{id}/open` or `/open-canvas` issues a
larger `X-OpenDirector-Session-Generation` before sending the request. Accepted
acquisitions supply the generation for heartbeats. Page exit releases the last
issued generation, including an open whose acknowledgment has not arrived.
A BFCache restoration explicitly reacquires a new generation.

The runtime catalog records a generation fence for each versioned owner.
Acquisition can supersede that same owner's older lease, even when unload
cleanup was lost. A release also fences a pending acquisition; older releases
are harmless. Heartbeats only renew an existing lease for the same project and
generation. They cannot resurrect a released lease or advance its generation.
Another owner's live lease always blocks acquisition. An absent lease after a
server restart permits explicit reacquisition; `session_stale` never does.

Fence records remain in the runtime catalog so delayed requests remain fenced.
They are coordination metadata, outside project commits and export formats.
Unversioned API callers retain generation zero and must explicitly open before
renewing, including after a release. A versioned owner cannot be downgraded by
omitting the header. If tab storage is unavailable or corrupt, the browser uses
a fresh owner; a lost old release can then require waiting for lease expiry.
This mechanism does not replace authorization or cancel accepted creative jobs.

Run `python -m pytest -q tests/test_session_handoff.py` and
`node --test tests/sessionIdentity.test.ts tests/sessionClose.test.ts` for the
transaction and lifecycle regressions. With the isolated creation API and web
fixtures running (see [validation](validation.md)), run
`node tests/browser/session_reload.mjs`. It checks both languages, drops unload
cleanup, reloads three times, replays the previous page's lifecycle packets after
handoff, verifies independent popup rejection, and commits an actual audio node.
Providers are mocked; catalog storage and browser interaction are real.

## 中文

浏览器将编辑会话的所有者和最后发出的代次存入 `sessionStorage`，仅在刷新时
接续该所有者。普通导航会创建新所有者，包括复制了原窗口存储的新弹出窗口，
因此不会绕过工程已有的单窗口租约限制。

每次显式调用 `POST /api/creation/projects/{id}/open` 或 `/open-canvas`，都会在
发送前递增 `X-OpenDirector-Session-Generation`。心跳使用已确认打开的代次；
退出页面则释放最后发出的代次，覆盖尚未收到确认的打开请求。BFCache 恢复时
通过新的代次重新获取租约。

运行时目录为每个使用代次的所有者记录屏障。即使卸载释放丢失，同一所有者的
新代次仍可接续旧租约。释放也能阻止尚未到达的打开请求；旧代次释放不会影响
新租约。心跳只能续期同一工程、同一代次的现存租约，不能重新打开已关闭会话，
也不能推进代次。不同所有者的有效租约始终阻止抢占。服务重启后租约缺失可显式
重新打开；`session_stale` 不触发自动重新打开。

屏障保留在运行时目录中，以持续拒绝迟到请求；它不属于工程提交或导出格式。
未携带代次的 API 调用保持代次零，但释放后必须先显式打开才能发送心跳。
省略请求头不能将已有代次的所有者降级。标签页存储不可用或损坏时使用新所有者；
此时若旧释放丢失，仍可能需要等待租约到期。本机制不替代授权，也不取消已接收
的创作任务。

上述 Python 和 Node 命令验证事务及页面生命周期。在隔离的工程 API 和网页
fixture 启动后，运行 `node tests/browser/session_reload.mjs`：覆盖中英文，
丢弃退出释放、连续刷新三次、在交接后补发旧生命周期请求、拦截独立弹出窗口，
并验证新增音频节点实际保存。模型服务使用模拟，目录存储和浏览器交互真实执行。
