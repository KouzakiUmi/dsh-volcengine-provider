<div align="center">

# 火山方舟 Provider

**在 DeepSeek Harness 中接入火山方舟 Agent Plan 与 Coding Plan。**

在一个设置页面管理账号、模型和套餐额度，也可在会话中用 Seedream 生成透明图片、拆分图层和识别图层文字。

[![npm](https://img.shields.io/npm/v/dsh-volcengine-provider?color=3b82f6)](https://www.npmjs.com/package/dsh-volcengine-provider)
[![CI](https://github.com/KouzakiUmi/dsh-volcengine-provider/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/KouzakiUmi/dsh-volcengine-provider/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-64748b)](LICENSE)

[快速开始](#快速开始) · [功能介绍](#功能介绍) · [使用说明](docs/usage.md) · [更新记录](docs/changelog.md) · [GitHub Releases](https://github.com/KouzakiUmi/dsh-volcengine-provider/releases)

</div>

## 快速开始

安装最新版本：

```console
dsh plugin --profile web add dsh-volcengine-provider
```

`web` 是示例 Profile，请替换为实际目标；Desktop 使用桌面壳集成的 DSH CLI。也可从 [GitHub Actions](https://github.com/KouzakiUmi/dsh-volcengine-provider/actions/workflows/ci.yml) 或 [Releases](https://github.com/KouzakiUmi/dsh-volcengine-provider/releases) 下载插件包安装。

1. 打开 **设置 → 火山方舟 Provider**。没有账号时直接点击 **生成官方登录链接**；已有账号时展开 **管理账号**，再点击 **登录其他账号**。
2. 确认后设置页展示官方 CLI 输出的登录链接；在任意设备浏览器打开链接完成官方 SSO，复制页面给出的 base64 授权码，回到设置页粘贴提交，由官方 CLI 完成登录。凭据引用接入则使用 **新增账号**。
3. 在账号卡片点击 **用于 Agent套餐 / 用于 编程套餐**，或在套餐卡片分别选择账号与启停。查看模型列表，按需拉取官方目录；额度与模型目录由 Host 后台采集，打开设置即显示中间层快照，需要立刻重拉时点 **刷新额度**，需要立即更新模型时点 **拉取模型**。
4. 在 DSH 模型选择器中选择对应路由，开始使用。

两段式登录需安装支持 `arkcli auth login volc-sso --no-browser` 的官方 [ArkCli](https://github.com/volcengine/ark-cli)（Windows 1.0.37 已实测）。详细配置见[使用说明](docs/usage.md)。

## 功能介绍

设置页按功能分为「额度」「模型」「图片生成」「账号与登录」四个分区，每个分区内按套餐分可折叠面板（摘要直接给出剩余额度、已启用模型数或套餐状态），同一功能下两个套餐可直接对比。套餐启用开关与账号选择集中在「账号与登录」；模型列表里已启用的排在前面。切换分区只隐藏不卸载：模型参数草稿、账号表单和登录进度都会保留；空账号时自动进入账号与登录。

<img src="docs/client-settings-preview.png" width="1000" alt="火山方舟 Provider 的套餐额度与账号管理">

<sub>真实组件离线预览，使用受控 DSW 主题令牌，账号与额度均为示例数据。另见<a href="docs/client-settings-preview-dark.png">深色预览</a>与<a href="docs/client-settings-preview-mobile-dark.png">390px 窄屏预览</a>。</sub>

### 两套套餐，分别接入

Agent Plan 与 Coding Plan 各有独立的启用开关、账号选择、模型目录和额度状态，可以同时使用。关闭套餐会保留所选账号和模型配置，重新开启即可恢复。

| 套餐 | DSH 模型路由 | 额度窗口 |
|---|---|---|
| Agent Plan | `volcengine-agent-plan` | 5 小时、周、月、日，按能力范围分组 |
| Coding Plan | `volcengine-coding-plan` | 5 小时、周、月 |

### 账号管理与两段式登录

支持新增、编辑、删除账号，并为两套套餐分别选择账号。登录复用官方 ArkCli OAuth 的 `--no-browser` 两段式：设置页生成并校验官方登录链接、粘贴授权码，页面提供登录进度、取消和结果提示；授权码只在内存传给 CLI 子进程，不落盘、不进日志。每个账号使用独立的 CLI 身份目录。

已有 API Key 的用户可沿用 DSH 凭据服务或启动环境中的引用名。OAuth 与凭据引用两种方式的配置见[账号与凭据](docs/usage.md#两种接入方式)。

### 拉取套餐模型

从官方套餐目录同步可用模型清单，按账号和套餐分别保存。能力参数依据官方 Plan Pi 文档和官方目录固化，显式匹配别名与版本，旧缓存默认值随快照更新，手动覆盖保留；来源与冲突见[能力参数](docs/model-capabilities.md)。每个模型可独立启停，目录刷新不清空设置；Auto/未知模型保守标记。

设置页和模型选择器使用友好名称，原始调用 ID 可在模型技术详情中查看。会话模型选择器在模型名旁显示消耗倍率徽标（常规 `x4.50`，活动期为高亮色并附剩余天数），设置页模型卡片展示同一倍率并汇总视觉、思考、上下文和输出能力；倍率来源与 Coding Plan 的参考语义见[能力参数](docs/model-capabilities.md#消耗倍率)。查看[模型卡片预览](docs/client-settings-preview-models.png)与[模型与思考配置预览](docs/client-model-thinking-preview.png)。

### 调整模型参数

按账号、套餐和模型管理图片输入、工具调用、上下文长度、默认输出 token、温度及思考档位，支持恢复目录默认值。图片覆盖只影响本地能力声明；工具调用关闭时保留历史记录，但不再允许新的工具调用。当前通道不支持直接传入音频或视频。思考方式与官方资料中的差异见[思考参数核对表](docs/model-thinking-audit.md)。

单次请求显式填写的参数优先。温度在启用思考时可能被传输层忽略，最终 token 数还受思考预算与上下文约束。详见[模型管理](docs/model-management.md)。

### 生成并查看图片

在设置页打开「启用图片生成」后，可使用 Seedream 生成、编辑图片和拆分图层。5.5 支持文生和图生透明 PNG，以及最多 99 个图层和规整文字图层的富文本 OCR。会话卡片可逐层预览、查看坐标和 OCR、下载原始文件。默认模型可在 5.0 Pro、5.5、5.0 Flash 之间切换。查看[图片卡片预览](docs/client-media-preview.png)、[图片设置预览](docs/client-media-settings-preview.png)与[调用示例](docs/media-generation.md)。

### 查看额度与重置时间

Coding Plan 展示剩余百分比；Agent Plan 同时展示 AFP 已用量、上限和剩余比例。不同能力的额度分组呈现；接口提供重置时间时显示倒计时，未提供时不猜测。支持手动刷新，读取失败时显示具体状态。

## 使用条件

- **DSH Core**：`>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`（已核验宿主：桌面 `0.2.1-rc.4`、手机版 `0.2.2-rc.1`）；`@earendil-works/pi-ai`：`>=1.1.0 <2.0.0`（已核验 `1.1.0` 与 `1.5.0`）。
- **Node.js**：`>=22.19.0`。
- **ArkCli**：两段式登录需支持 `arkcli auth login volc-sso --no-browser`；Phase 1 输出、session 接力与 Phase 2 解析已用真实 1.0.37（Windows）核验，真实授权码端到端登录未验收。
- 当前支持国内个人 Agent Plan / Coding Plan。

Seedream 5.5 的透明文生图、图层拆分和富文本 OCR 已通过真实 Agent Plan 请求验证。其他模型、登录与宿主的实测范围见[验证记录](docs/validation.md)。

账号删除仅移除插件元数据，已保存的官方 CLI 身份目录会保留。反馈问题时请提供版本、套餐类型和脱敏错误，凭据、授权码及授权链接请勿提交。

## 文档与反馈

[使用与常见问题](docs/usage.md) · [开发与发布](docs/development.md) · [接口说明](docs/arkcli-contract.md) · [提交 Issue](https://github.com/KouzakiUmi/dsh-volcengine-provider/issues)

## 许可

[MIT](LICENSE)。第三方版权声明见 [NOTICE](NOTICE)。
