# 图片生成与渲染

[返回主页](../README.md)

插件向 DSH 会话注册 `volc_imagine`，经火山方舟 Agent Plan 数据面（`https://ark.cn-beijing.volces.com/api/plan/v3`）调用 Seedream 图片模型。计费走官方 Agent Plan 额度并消耗套餐 AFP，受每日与每月额度约束。

## 启用方式

设置页「图片生成」分区通过**启用图片生成**单个开关控制：开启时同时确认按用量计费并启用 `volc_imagine`，关闭即停用工具；已生成的附件保留。未开启时默认模型选择器保持禁用。

默认图片模型选择器提供三个 Agent Plan 调用别名：

| 显示名称 | 调用 ID |
|---|---|
| Doubao Seedream 5.0 Pro | `doubao-seedream-5-0-pro` |
| Doubao Seedream 5.5 | `doubao-seedream-5.5` |
| Doubao Seedream 5.0 Flash | `doubao-seedream-5.0-flash` |

选择保存在 `state.media.imageModel`，工具未显式传 `model` 时使用该值；单次工具调用仍可在上述三个别名中另行指定。默认沿用 5.0 Pro。

图片工具使用 Agent Plan 所选账号的推理凭据：OAuth 账号取其绑定 profile 的 Key，凭据引用账号解析 `apiKeyRefs['agent-plan']`。未选择 Agent Plan 账号、未绑定套餐 profile 或凭据解析失败时工具明确报错，不产生请求。

## `volc_imagine`

同步图片生成与编辑，单次 300 秒超时。

| 参数 | 说明 |
|---|---|
| `prompt` | 必填，≤8000 字符 |
| `model` | 上表三个别名；省略时使用设置页默认模型 |
| `image` / `images` | 可选参考图（本地路径、`attachment=` 规格、https URL 或 data URI）；省略为文生图，传入为图生图/多图融合，合计最多 10 张 |
| `size` | `1K` / `1.5K` / `2K` 档位或 `宽x高` 像素；默认 `2K` |
| `output_format` | `png` / `jpeg`；默认 `png` |
| `watermark` | 默认 true |

参考图格式为 jpeg/png/webp/bmp/tiff/gif，单文件 <30 MB；本地上传编码为 data URI 随请求发送。生成图片经白名单域名下载，远程签名 URL 不进入任务状态、工具返回值或日志。

## 原始文件与会话预览

每次生成保存两类附件：

- **原始文件附件**：`attachments.saveFile` 逐字节保存方舟返回的 PNG/JPEG，格式、文件名和字节内容不被图片规范化改变。
- **会话图片附件**：`attachments.saveImage` 保存供模型后续视觉输入使用的图片。当前宿主可能对图片降采样、去元数据并重编码；不透明图片可规范化为 JPEG，含透明通道的图片可规范化为 WebP。

工具按下载字节的文件头核对实际上游格式。实际格式与 `output_format` 不一致时明确失败，不保存格式不符的文件，也不按文件名猜格式。工具结果同时携带两类附件；`meta.originals` 记录原文件引用、真实媒体类型和预览尺寸。

官方参数依据：

- [图片生成教程](https://docs.volcengine.com/docs/ark/image-generation-tutorial?lang=zh)
- [Doubao Seedream 5.0 pro / flash 教程](https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh)
- [Doubao Seedream 5.5 教程](https://docs.volcengine.com/docs/ark/seedream-5-5?lang=zh)
- [Agent Plan 个人版功能发布公告](https://docs.volcengine.com/docs/ark/agent-plan-personal-feature-release?lang=zh&mode=pure)

## 会话内渲染

Client 在 `tool.call.toolview` 以 `volc_imagine` 注册专用卡片：

- 生成中显示参数接收/生成状态；失败显示工具错误；成功以图片画廊为主。
- 新结果优先从原始文件路由渲染和下载，支持大图、1–4 倍缩放、重置、Esc 关闭与复制提示词。
- 旧结果没有 `meta.originals` 时，回退到当前宿主 `owner.loadImage`，再回退到旧版 `sessions.readAttachment`；旧版 Blob URL 随组件卸载回收。
- 长提示词、模型、附件 ID 和原始工具文本位于折叠详情。

组件离线预览：[图片卡片](client-media-preview.png) · [图片设置](client-media-settings-preview.png)。

### 原始图片回源

`GET /plugins/dsh-volcengine-provider/image/file` 只接受回环来源、回环 Host 与同源/dsh-app Origin。请求携带工具结果已经公开的文件附件 ID、名称、字节数和真实媒体类型；路由校验参数后通过 `attachments.readFileStream` 回源，并再次核对流出长度。原始附件按内容寻址且不可变，成功响应使用 `private, max-age=3600` 与 `nosniff`；错误响应使用 `no-store`。`download=1` 时转为附件下载。路由随插件卸载注销，活动读取全部中断。

## 状态字段

`state.json` 的 `media` 为 `{ riskAcknowledged, imageTool, imageModel }`，经 `setMedia` 按 revision 校验写入。读取旧状态时丢弃 `videoTool`；`riskAcknowledged: false` 强制关闭图片工具。媒体状态不保存图片字节或远程签名 URL。
