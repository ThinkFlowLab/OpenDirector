# Higgsfield Open MAGI-2 视频生成

[English](higgsfield-magi-2.md)

## 账户连接

打开**设置 → 模型接入 → 视频 → 添加服务**，选择 **Higgsfield Open**，保留地址 `https://api.higgsfield.ai`。按照 `KEY_ID:KEY_SECRET` 格式填写 Higgsfield Open 凭据，勾选 `sand/magi-2` 并保存，然后在生成面板中选择该模型。

模型列表与输出规格来自内置声明。加载和保存配置不会验证账户权限，也不会发起生成请求。生成需要账户具备模型权限和足够的 API 额度。

## 输入与输出

画布与 Agent 通过同一个连接支持以下输入：

| 输入 | 选择方式 |
| --- | --- |
| 文本 | 填写提示词，不连接媒体参考。 |
| 首尾帧 | 选择首尾帧模式，指定首帧图片，可选填尾帧图片。 |
| 参考素材 | 选择参考模式，连接图片、视频、音频或混合素材。普通图片参考保持参考用途；音频可以单独使用。 |

纯文本生成必须填写提示词，携带媒体时可以省略提示词。最终提示词包含所连接的文本内容，最多 15,000 个字符；超限会明确拒绝，不截断输入。

| 参考类型 | 格式 | 数量上限 | 单个文件大小 | 时长 |
| --- | --- | --- | --- | --- |
| 图片 | JPEG、PNG、WebP、GIF | 10 张 | 小于 30 MB | — |
| 视频 | MP4 | 5 段 | 不超过 200 MB | 每段 2–30 秒，视频总计不超过 30 秒 |
| 音频 | WAV | 5 段 | 不超过 15 MB | 每段 2–30 秒，音频总计不超过 30 秒 |

MOV 请先转换为 MP4，MP3 请先转换为 WAV，再添加参考。OpenDirector 通过 Higgsfield 上传服务发送已接受文件的原始内容。账户凭据仅发送给官方 API。

输出为 1080p，时长支持 4–30 秒的整数。新节点默认 5 秒、16:9，并开启生成音频。比例支持 21:9、16:9、4:3、1:1、3:4 和 9:16，首尾帧模式也可以选择比例。可以关闭生成音频，已保存且受支持的参数会继续保留。

## 任务与结果

任务接受后保存固定的输入和参数。完成的视频会被下载、检查，并登记为工程素材和结果候选。采用结果时执行现有版本与锁定检查，保留之后修改的内容。生成文件沿用现有 50 MB 下载与恢复缓存上限。

中断后恢复原任务，可以继续提交、查询、下载或保存。私有恢复缓存记录首次提交的完整请求、素材地址和固定的 `Idempotency-Key`。该标识表示一次明确的生成操作，重复发送相同请求会继续使用同一个远端任务。缓存损坏时停止恢复，不重新提交生成。

提交结果不明时，恢复提交需要原 API Key ID。更换该标识后，请恢复原连接再恢复任务；不同账户分别记录重复请求标识。

远端任务排队时可以申请取消。系统分别记录取消请求和远端取消确认。开始执行后 Higgsfield 会拒绝取消；停止本地工作不能停止远端执行，也不能确认退款。

## 官方接口资料

- [文字生成视频](https://open.higgsfield.ai/models/sand/magi-2/text-to-video/api-reference)
- [图片生成视频](https://open.higgsfield.ai/models/sand/magi-2/image-to-video/api-reference)
- [参考素材生成视频](https://open.higgsfield.ai/models/sand/magi-2/reference-to-video/api-reference)
- [文件上传](https://docs.higgsfield.ai/docs/concepts/file-uploads)
- [请求生命周期](https://docs.higgsfield.ai/docs/concepts/requests)
- [重复请求处理](https://docs.higgsfield.ai/docs/concepts/idempotency)
