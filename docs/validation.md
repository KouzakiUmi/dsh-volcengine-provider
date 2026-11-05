# 验证记录

## 目标与范围

- 已核验宿主有两个：桌面 **DSH Core 0.2.1-rc.4**（`DSH NEXT` 的 Core / llm / llm-pi-ai / credentials / launch-environment / typert-protocol manifest，pi-ai `1.1.0`）与手机版 **the agent harness 0.2.2-rc.1**（Node 24.22.1，pi-ai `1.5.0`）。五个 Core 包的 Peer 声明为 `>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`，pi-ai 为 `>=1.1.0 <2.0.0`；范围内其他版本未逐一验证。并集范围使 npm 默认 semver 与宿主 `includePrerelease` 判定同时匹配两个已核验的预发行宿主。
- ArkCli **1.0.37** 的命令帮助、随包官方 Skills、raw action 注册及无网络预览。
- 单元业务测试使用假凭据、假 CLI 与外部网络替身；两段式登录未做真机验收，边界见 0.2.13 段。

## 0.2.13 无浏览器两段式登录

- 网页登录从「官方 ArkCli broker 同设备流程 + 私有 PATH 启动桥（Windows `rundll32.exe`）+ Playwright 独立 Chrome + 127.0.0.1 IPC」改为官方 CLI `arkcli auth login --no-browser --credential-store encrypted-file` 两段式：Phase 1 由 CLI 打印官方登录 URL，插件校验官方主机/路径白名单后把链接展示在设置页，用户在任意设备浏览器完成 SSO 并取得 base64 授权码；Phase 2 用户在设置页粘贴授权码，插件调用 `arkcli auth login --no-browser --code <授权码> --credential-store encrypted-file`，由官方 CLI 完成 PKCE 交换与凭据落盘。
- 插件不处理 token 端点、不读取网页或授权码内容（授权码只在内存传给 CLI 子进程 argv，不落盘、不进 UI 状态、不进日志）、不启动浏览器、不拦截系统 URL opener；不再打包 Windows 原生桥二进制、不再依赖 `playwright-core`。CI 不再产出 Windows 桥 artifact，归档校验不再要求桥文件。
- 安全边界改写为只放行官方 CLI 输出的白名单官方链接 + 两段式流程；不再限定「仅已核验的 Windows ArkCli 1.0.37」，也不再写「不回退 cross-device 授权码流程」。身份核验（whoami / auth status / 双套餐 profile）、账号隔离目录、原子绑定、取消/超时/写入保护、白名单身份摘要、OAuth 账号走 CLI raw action 查额度（不需要 AK/SK）全部保留。
- 实测范围：本机 Core smoke（隔离 Host 加载、RPC、双路由、目录、路由失败保留、dispose，HTTP 由本地替身响应）与离线单测（假 CLI、假凭据、外部网络替身）覆盖两段式的链接白名单校验、授权码只经 argv 传递、不落盘/不入日志、取消/超时/写入保护等非浏览器路径；具体测试数量见「当前结果」。
- 未验收边界：本机没有安装 ArkCli，`--no-browser` 两段式**未做真机验收**，不得表述为已通过真实登录。后续须用真实 CLI 复核 Phase 1 的 URL 输出格式、Phase 1 → Phase 2 的 session 接力，以及 Phase 2 授权码交换与凭据落盘（待复核）。真实额度、推理调用、生产安装与跨平台真实 CLI 行为仍未验收。

## 0.2.12 本机 Core 版本适配

- 现场取证：手机版 the agent harness 的内置运行时为 `r15-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5`（App 1.0.11 诊断快照），`/opt/dsh` 的 `@deepseek-ai/dsh`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-credentials`、`dsh-launch-environment`、`dsh-typert-protocol` manifest 均为 `0.2.2-rc.1`，`@earendil-works/pi-ai` 为 `1.5.0`，cordis `4.1.0`、schemastery `3.19.0`。本机 profile 的插件目录为指向工作区的链接，版本 `0.2.11`。
- 宿主兼容判定（`@deepseek-ai/dsh-app-boot`）用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 检查 `@deepseek-ai/dsh*` peer；该模式下 `>=0.2.1-rc.4 <0.3.0` 已匹配 `0.2.2-rc.1`。但 npm 默认 semver 不含预发行同元组例外，实测 `0.2.2-rc.1` 不匹配该范围，`pi-ai 1.1.0` 也不匹配本机 `1.5.0`；从 registry 安装时会成为依赖解析阻碍。
- 声明改为并集 `>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`（五个 Core 包）与 `>=1.1.0 <2.0.0`（pi-ai）。实测在 npm 默认 semver 与宿主 `includePrerelease` 两种判定下，`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.1`、`0.2.2-rc.1`、`0.2.2`、`0.2.9` 均匹配，`0.3.0` 不匹配；`1.1.0`、`1.5.0` 匹配 pi-ai 范围，`2.0.0` 不匹配。未设置 `engines.dsh`：宿主一旦读到该字段会改为只判定它、忽略 peer。未来新的 `0.2.x-rc.N` 预发行号仍需按 semver 同元组规则重新核对。
- 运行时代码未改。以 `DSH_TEST_HOST_ROOT=/opt/dsh` 加载本机真实 Core/SDK 复核：`scripts/host-smoke.mjs`（隔离 Host 加载、RPC、双路由、目录、路由失败保留、dispose）、`scripts/model-thinking-smoke.mjs`（两套餐 192 项真实 Core/SDK 请求断言）、`scripts/model-management-smoke.mjs`（状态迁移、开关、覆盖优先级、已准备请求隔离）与 `scripts/model-capabilities-smoke.mjs`（图片元数据、工具选择、隔离）全部通过；HTTP 全部由本地替身响应，未调用真实推理或额度接口。
- `scripts/host-smoke.mjs` 中 `deepseek-v4-1-flash-economy-261017` 的上下文断言由 `1049000` 同步为快照现值 `1024000`；该差异来自 0.2.10 快照刷新后的旧脚本硬编码，与本机 Core 无关。
- 新增 `test/manifest-compat.test.mjs`，锁定五个 Core peer、pi-ai 声明、版本号与两种 semver 判定下的匹配回归。

## 0.2.11 Core 版本声明修正

- 现场取证：桌面 `DSH NEXT` 的 `app.asar` 内 `@deepseek-ai/dsh-llm`、`dsh-llm-pi-ai`、`dsh-credentials`、`dsh-launch-environment`、`dsh-typert-protocol` 的 manifest 版本均为 `0.2.1-rc.4`，`@earendil-works/pi-ai` 为 `1.1.0`；PATH 上没有其他 `dsh` 安装，`~/.dsh` 下也没有第二份 Core。此前声明只写 `0.2.1-rc.5`，与本机宿主不一致。
- 声明改为 `>=0.2.1-rc.4 <0.3.0`（五个 Core 包），以实际核验的 rc.4 为下限，同系列后续版本仍在范围内；未逐一验证该范围内的其他版本。按 semver 默认规则，该范围匹配 `0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.1` 及后续 `0.2.x` 稳定版；其他预发行号（如 `0.2.2-rc.1`）不在默认匹配内，若宿主升级到此类版本需要重新核对声明。宿主 rc.4 中核到插件使用的 `resolveRetryPolicy`、`resolveImageAttachmentAccess`、`registerAdapter`、`providerRetryPolicy` 等符号存在（字符串级核对，非类型级验证）。
- `node scripts/check.mjs` 与 `node --test test/*.test.mjs` 全部通过（368 项），`lib/` 重建；本次只改声明与文档，未改运行时代码。

## 0.2.10 控制台路由可用性与上游参数刷新

- 使用已绑定的真实方舟账号（隔离 CLI home，`auth whoami` 返回 `logged_in=true`、身份为既有账号）执行 `arkcli plans model-list`：Agent 与 Coding 两套套餐各返回 16 条，集合与本地缓存一致，`selected_model_id` 为 `auto`。上游没有新增或移除模型。
- 真实调用探针（Anthropic Messages 路径）：`model=auto` 在 `/api/plan/v1/messages` 与 `/api/coding/v1/messages` 均返回 `404 UnsupportedModel`；同一路径下 `doubao-seed-2-1-pro-260915`（Agent）、`doubao-seed-2-1-pro`（Coding）与 `ark-code-latest`（两套）均返回 200，其中 `ark-code-latest` 的响应 `model` 为 `auto`。请求只发一条 `max_tokens=8` 的最小消息，未读取或输出凭据。
- 官方资料复核：[Coding Plan Pi](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md) 明确 Model Name 不支持配置为 `Auto`、需通过控制台切换；[Agent 套餐概览](https://www.volcengine.com/docs/82379/2366394)与[Coding 套餐概览](https://www.volcengine.com/docs/82379/1925114)（最近更新 2026-10-29）给出 Kimi K3.1 Pro 1024k 上下文/1024k 输出、Economy 1024k 上下文，并把 `minimax-m3`、`kimi-k2.7-code` 标注为即将下线。
- 本地实现按上述证据把清单里的 `auto` 归一为可用的 `ark-code-latest`，展示名称保留“Auto（智能调度）”；旧缓存与旧设置键只读继续生效。开关与参数保存以当前生效设置为基线，恢复默认同时清除历史键；显式最大输出高于新上下文时保留原设置、收敛有效调用并提示。`node --test test/*.test.mjs` 共 368 项全部通过，含归一、旧缓存、旧设置键读写与超界收敛用例；`lib/` 已按源码重建。
- 未覆盖：没有对每个模型重放真实推理，也没有重跑真实浏览器截图（模型卡片文案变化由离线 React 测试覆盖）；`test/test_verify_package.py` 本轮无法执行，原因是 `.dsh` 目录与解释器带 Low 完整性标签，而用户 TEMP 为默认 Medium，Low 进程无法向上写入（`icacls /L` 已取证），与本次改动无关。

## 0.2.9 Core 适配、设置页与消耗倍率

- 从桌面 `app.asar` 的产品与各包 manifest 核对实际 Core / llm / llm-pi-ai / credentials / launch-environment / typert-protocol 版本，其消费的 pi-ai 为 `1.1.0`；插件 peer 声明与该版本对齐，没有改写宿主安装。当前复核（2026-11-03）读到的宿主版本为 `0.2.1-rc.4`，本条原记的 `0.2.1-rc.5` 已无法在本机复现，版本口径以 0.2.11 段为准。
- 真实目标 Core 隔离 Host 加载通过，覆盖 Core Schema、RPC、双路由、模型目录、路由失败保留和 dispose；模型管理、逐模型思考与能力矩阵使用同一真实 Core/SDK 和假 HTTP，未调用真实推理。
- 设置页参考 Our Free Model 2.7.1 的卡片与标签信息层级，保留本插件原有账号、双套餐、额度、模型参数和异步保护。真实 React/Chrome 离线验证名称旁倍率、限时标记、能力标签、模型开关与参数、额度分组、登录路径、390px 窄屏和窄内容栏；HTTP(S) 全部阻断，RPC 为假数据。
- 深浅色 ×（宿主实色 secondary 令牌 / 缺失令牌）四组对比度审计均通过 WCAG AA。首次审计发现按钮/开关主题过渡中间色与折扣小字对比不足，已去除相关颜色过渡并修正文字透明度后复验通过。
- 倍率依据[官方 AFP 抵扣规则](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-afp-credits-billing-rules)与[共享折扣活动](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-model-discount)固化，逐模型来源和 Kimi K3 活动结束冲突见[能力参数](model-capabilities.md#消耗倍率)。测试覆盖两套套餐别名、活动开始前/截止/结束后、未知与动态路由无倍率，以及倍率元数据不进入 Core 配置；Coding 仅作相对消耗参考，未实测线上计费。

## 0.2.8 模型能力覆盖

- 对照两套 Plan 的 Pi 文档、套餐概览、官方插件目录及目标 Core/SDK 契约复核模型参数与输入模态；官方音视频能力与当前文本/图片传输边界、思考字段的资料冲突分别见[能力参数](model-capabilities.md)和[思考参数审计](model-thinking-audit.md)。未进行真实账号推理。
- 使用真实目标 Core 和 SDK、假凭据与离线 HTTP 替身验证两套餐的图片能力声明、工具调用选择及已准备请求隔离；服务端违规返回工具调用时的拦截由隔离测试验证。
- 尚未实测方舟服务端对工具禁用请求或图片输入的接受情况，也未以真实网络回放服务端违约工具事件。旧版回退结果依据源码分析，未进行端到端回退测试。
- 使用 React/Chrome 离线验证复选框勾选、分别恢复继承、未知默认的未定态以及 390px 窄屏与深浅色；RPC 为假数据。

## 0.2.7 设置页额度展示调整

- 使用真实 React/Chrome 与假 RPC 数据离线验证账号、模型操作、额度分组及实时倒计时；覆盖深浅色、390px 视口、768px 视口及宽窗口中的 390px 内容栏。
- 对比度检查覆盖深浅色与两种主题令牌配置；补充每套餐独立时钟、重置时间变化后清理旧时钟和到期状态测试。未在运行中的 DSH 页面或真实额度接口复验。

## 0.2.6 紧凑设置页与额度倒计时

- 账号管理默认收起，双套餐随可用宽度并列或堆叠；真实 React/Chrome 离线测试覆盖交互、深浅色、390px 和额度分组，使用假 RPC 数据。
- 倒计时使用接口返回的有效重置时间；缺失、无效和到期均有明确状态。隔离测试覆盖计时、卸载清理、分组及重置时间跨层传递，未验证真实账号的在线额度响应。

## 0.2.5 逐模型思考参数与请求适配

- 逐项来源、独立档位、默认及关闭规则见[模型思考审计](model-thinking-audit.md)。已公开能力与尚未公开的默认/关闭控制分别记录。
- 真实 Core 的公开 PiAiAdapter 与 SDK 请求钩子完成两套餐 **192 项离线请求矩阵检查**：逐模型声明默认、独立档、enabled/adaptive 模式、显式关闭、未强制和 Auto。全部 HTTP 使用假响应。
- 验证原始覆盖保留、旧预算继承兼容、常驻思考关闭限制、跨模型/并发隔离、旧 prepared call 与凭据绑定固定、取消和错误脱敏。
- 真实 React/Chrome 离线复验深浅色、390px、参数操作与状态分类；新版模型预览见[思考参数预览](client-model-thinking-preview.png)。

## 0.2.4 模型快照与界面重构

- 参数按[固化能力来源](model-capabilities.md)逐字段核对，优先对应 Plan Pi 明确整数；补齐当前 15 个固定模型族与账号选择路由配置，并保留冲突/思考控制的证据边界，不把其他 Provider 原厂上限直接覆盖 Plan。
- 显式别名覆盖控制面 ID、Plan 调用 ID 与文档名称；未知版本不去日期猜测。真实已有目录样本只读回放：Agent 原有 8 个、Coding 原有 7 个 32K 回退项均缩减为仅 `auto`，各 15 个固定模型采用固化默认值；原始状态文件逐字节未变。
- 回归覆盖旧缓存内存合并、友好显示名、原 ID 操作键、用户覆盖优先、默认输出不超过有效上下文、别名进入 Core 前剥离；旧 GLM medium 默认保留原值、有提示地降为不强制，真实 Core resolve/prepare 均通过。实际 Core 隔离 Host 再次通过，验证 16 配置/套餐及 Economy 的 `1049000`/`393216`；模型管理和请求优先级脚本通过，全部 HTTP 使用替身。
- 设置页保留全部原 RPC/并发保护，参考 Antigravity ACP 0.1.29 与 OpenDesign CoRouter 0.1.4 的公开客户端：编号分区、DSW 令牌、卡片/控件、技术信息折叠、紧凑成功状态、主次按钮。没有复制对方业务逻辑。
- 真实 Core 的 listModels 返回友好名称；真实 React 模型目录验证“豆包 Seed 2.1 Pro”“Kimi K3.1 Pro”“DeepSeek V4.1 Flash”及折叠调用 ID，见[模型名称预览](client-model-names-preview.png)。
- 新增布局、样式所有权、重叠实例卸载和紧凑状态回归；保留旧 Host 安全授权链接、登录确认/取消、未知启动保护、身份/额度迟到隔离等既有覆盖。真实 React/Chrome 离线复验深浅色、390px、模型参数、原生折叠及控件实际尺寸。
- 能力边界来自对应来源资料；真实服务端容量上限和 Plan 思考控制效果尚需单独的推理验证。

## 已执行

### 语法、单元测试与构建

```sh
node scripts/check.mjs
node scripts/build.mjs
node --test test/*.test.mjs
```

- JavaScript 语法、manifest 基本字段和前后端依赖边界检查。
- 账号、双订阅隔离、revision 冲突、目录字段/能力、缓存、签名向量、额度错误/单位、OAuth 生命周期、设置页交互及授权 URL 白名单。
- HMAC 签名测试使用独立 OpenSSL 推导的固定向量，不只比较实现自身的两次输出。
- 构建生成 Host 模块与返回导出对象的惰性 Client 工厂；不新增安装构建依赖。

当前结果：**356 项 JavaScript 测试、8 项 Python 归档测试通过**，43 个 JavaScript 源文件语法/边界检查通过，构建包含 15 个模块/Client 产物，归档不再包含浏览器桥文件。模型管理测试覆盖旧状态迁移、套餐/模型开关、逐模型参数、请求默认值及适配器生命周期；发布测试覆盖 OIDC 身份、版本与渠道、归档校验（含 `catalog-snapshot.json` 与 `consumption-rates.json` 必需项）、registry 错误分类及发布后完整性检查。

### 实际 Core 隔离加载

[Host 验证脚本](../scripts/host-smoke.mjs) 通过：

- 真实 Core 导入、Config Schema、Typert RPC 注册。
- 先加载既有原生 llm-pi-ai，再加载本插件，验证共存。
- 独立账号凭据服务桥接、两个路由各 16 个固化模型配置；缺凭据时不显示为可用模型。
- 模型上下文和输出规格解析；单独停用 Coding 路由不影响 Agent。
- dispose 后清除本插件服务与两个适配器，既有 Core 不被修改。

通过公开 PiAiAdapter 和模型级 Provider 钩子复用 Core 传输；路由代际先构造校验，再经稳定代理和公开 registration handle 原子替换。凭据解析固定到该代际的账号及绑定，通用 pi-ai 设置与模型发现仍由宿主实例负责。真实 Core 已验证损坏缓存时保留旧路由及恢复路径，已准备调用继续使用原配置与凭据上下文。

### 实际 Core 模型管理与假 HTTP 请求

[模型管理验证脚本](../scripts/model-management-smoke.mjs) 通过：

- 版本 1 状态只在内存中迁移，首次有效修改才写入版本 2。
- 套餐关闭保留账号；逐模型开关影响实际 Core 模型目录。
- 未知模型不再被默认 low 阻断，可抵达假 HTTP 传输层。
- 上下文、输出 token、温度与思考配置实际进入请求；显式参数优先于保存默认值。
- 原生 effort、预算模式以及两种模式的默认 off 均核对实际请求字段。
- 设置变更后，已准备请求继续使用旧默认值与凭据上下文；流结束后释放旧适配器。

上述 HTTP 响应全部由测试替身提供，未执行真实模型调用。

### 真实 React 与 Chrome 离线交互

[浏览器验证脚本](../scripts/browser-smoke.cjs) 通过：

- 使用目标宿主随包 React/ReactDOM 与已安装 Chrome，在独立非持久浏览器上下文中渲染实际构建产物。
- 只提取宿主静态 React 模块，主动停止宿主应用启动；不访问运行中的 DSH 页面、接口或登录态。
- HTTP(S) 请求被拦截；全部 RPC 为假数据，不打开真实 OAuth 页面。
- 验证双卡片、套餐及模型开关、参数保存/恢复默认、额度剩余/AFP 分组、网页登录确认前不发起登录、确认后调用与卸载。
- 已检查重构后的[桌面浅色预览](client-settings-preview.png)、[桌面深色预览](client-settings-preview-dark.png)、[390px 深色窄屏预览](client-settings-preview-mobile-dark.png)与[空账号入口](client-settings-preview-empty.png)。主题使用受控 DSW 令牌；390px 无横向溢出、账号选择框高度小于 64px、卡片移动端 padding 为 12px、原生 details 可正常开合。不是生产 DSH 页面截图，账号和额度均为假数据。
- 模拟网页登录从等待到成功，验证官方用户名自动更新至账号区与套餐卡片、旧额度清空、重新查询归属新身份；进度条与文案统一表达剩余额度。

## 身份与交互修复验证（2026-10-26）

- 根因：旧实现只检查 `whoami.logged_in`，没有保存或返回官方身份，客户端只展示本地 label。现保存白名单身份摘要，保留本地备注，并兼容只读恢复旧绑定的身份。
- 隔离测试覆盖独立登录目录、失败登录保留旧绑定、旧请求仍读取旧目录、身份持久化不夹带完整响应、OAuth 未绑定套餐拒绝 profile 回退。
- 覆盖登录已提交而路由失败的独立状态、外部实例变更后的刷新与路由更新、独立 Store 冲突保护、强制额度刷新失败后不复用旧成功缓存、凭据服务异常不拖垮设置页。
- 实际 Core Host 与模型管理脚本再次通过；失败切换时已断言所选账号与实际生效账号不同，保留路由后可恢复。模型请求仍全部使用假 HTTP。
- Client 替身按 React 依赖语义执行 effect；真实 React/Chrome 离线测试覆盖登录结果刷新、套餐与模型操作、额度重查及窄屏布局。不是对所有异步交错或真实 OAuth 的穷尽验证。
- Context7 文档查询因额度限制不可用；身份契约以本机 `@volcengine/ark-cli 1.0.37` 随包官方 whoami 文档核验。

## 完整操作路径回归

- 空账号直接网页登录：确认前不写入；确认后自动创建账号并使用新 revision 启动 OAuth；取消确认不留下账号。
- 已有账号登录其他身份不覆盖原账号或套餐选择；登录后显式选择并启用指定套餐，不改变另一套餐。
- 启动冲突后同步 revision；启动响应丢失后读回正在运行的任务；启动及补读同时断网时保留结果未知保护态并退避同步，分别验证 Host 已启动和未启动两种恢复结果；进度查询短暂失败保留取消入口与写入保护，恢复后继续完成。
- 删除正在编辑的账号关闭旧表单；未绑定套餐和没有隔离 Profile 的操作禁用且说明原因；禁用控件有可见状态，空状态不再引导点击禁用按钮。
- 思考映射切回继承时读取目录默认而不是旧覆盖，并清除不兼容默认档位；路由失败不把保存值称为生效值；恢复停用模型明确会重新启用。
- 额度查询不锁住账号管理；切换账号后立即允许新查询，迟到响应不覆盖新账号数据。
- 真实 React/Chrome 离线模拟完成“空账号 → 确认 → 假 OAuth 成功 → 选择并启用 Agent 套餐 → 查询额度”。该离线 UI 测试不打开真实官方页面；真实同设备 OAuth 另按下节独立验收。
- 当前登录使用官方 CLI 的 `--no-browser` 两段式：Phase 1 生成官方登录链接，Phase 2 由用户粘贴授权码完成；不启动浏览器、不使用启动桥（见 0.2.13 段，未做真机验收）。

## 浏览器隔离修复验证（2026-10-27）

- 代码检查发现 CLI 子进程重写 HOME/USERPROFILE/XDG_CONFIG_HOME，并由它启动日常默认浏览器，存在隔离环境传播风险；没有直接编辑 Chrome Preferences 的插件代码。尚未用真实用户 Chrome 重现或证明“外部篡改”提示的唯一根因。
- 本机 ArkCli 1.0.37 隔离目录探针确认使用 USERPROFILE 下的 `.arkcli`；定向核验原生浏览器调用为 PATH 查找的 rundll32。CLI 版本和平台在启动登录前检查，仅开放已核验的 Windows 1.0.37。
- 真实原生 C# 桥进程已验证：精确官方 URL、每任务鉴权 token、仅 127.0.0.1 IPC、链接原样传递、一次链接幂等与异链拒绝；不存在修改系统 opener 或注册表的路径。POSIX opener 打包固定执行位并预检 X_OK，防止缺执行位时落到系统浏览器；其 CLI 行为未验收，当前不开放登录。
- Playwright Core 1.64.1 在净化环境的独立 Worker 中加载，启动可见、启用沙箱的临时 Chrome，仅 goto 原始方舟链接；不读取 DOM、密码、Cookie 或授权码。宿主 DEBUG/DEBUG_FILE/PWDEBUG、Node 预加载和 CLI 环境不传播，驱动输出捕获丢弃。取消、超时、失败和迟到启动均有回收测试。
- `node scripts/test-oauth-browser.mjs` 在宿主调试开关开启时通过真实 Chrome 离线验证：官方页面与 CLI callback 均由本地 fixture 拦截，模拟自动回调后关闭所属窗口，无真实登录或提码。
- **真实验收通过**：`node scripts/test-oauth-live.mjs --confirm-real-login` 使用正式构建产物、官方 CLI 和独立临时目录。用户在方舟同设备页面手动授权后，官方回调完成，CLI 登录成功，whoami 身份与 Agent/Coding 两类个人套餐 profile 核验通过，临时绑定原子持久化成功，随后窗口及全部临时身份/元数据清理完成。没有改变生产账号、安装插件或调用额度/推理。
- Context7 额度不可用，Playwright 启动契约对照 [官方 API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch)、安装版本类型与实现；Windows CLI 浏览器实现采用对应安装版本的定向只读核验，并以真实回调验收收口。

## 未执行

- 新用户首次购买/签约、创建或轮转 Key 的完整流程。
- 真实 raw 额度信封、实时模型目录与推理调用。
- 生产 Profile 安装、重启和会话模型迁移。
- 其他 Core / ArkCli 版本、企业席位及跨平台的真实 CLI / 宿主行为。

## 仍需验收的外部契约

1. 新用户首次消费场景选择、协议及 Key 操作必须由用户在官方流程完成；当前真实验收使用已有个人套餐账号。
2. raw GetAFPUsage/GetCodingPlanUsage 的 `{}` 请求与响应信封；本轮只验证真实身份/profile 摘要，不验证额度接口。
3. 沿用配置的 Anthropic 兼容路径、长上下文和思考档位；模型快照不是实时官方能力声明。
4. 实际 OAuth 页面与回调地址由官方 CLI 生成，随 CLI 版本而定。

具体命令依据见[接口文档](arkcli-contract.md)。

## 0.2.1 修复验证

- 单参数 factory(require) 加载实际构建产物，未提供虚假的 CommonJS 参数。
- 覆盖空模型行、非法/重复 ID 和保留名称；坏缓存返回 invalid-cache，正常套餐不受影响。
- 取消排队中的状态写入与登录绑定后，元数据未落盘、模型路由未更新，后续保存仍可执行。
- 临时写入接受 AbortSignal，并在原子替换前再次检查取消状态；已完成的原子提交不会因后续取消而回滚。
- 本机 DSH Desktop 0.2.1-rc.3 已在安装入口修复后实际启动到主界面。
