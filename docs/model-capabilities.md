# 固化模型参数与来源

核验日期：2026-11-03（2026-10-27 首次核验，2026-10-28 按官方原文复核模态边界与来源冲突，本次按官方 Pi 接入与套餐概览当前版本刷新参数量，并以真实账号探针核对控制台路由的可用请求 ID）。此表是插件采用的配置快照，不是推理边界实测。模型清单仍从所选账号的 ArkCli Plan 查询；上下文、输出和当前传输可表达的输入模态从本文件列明的一手资料固化，不在拉取清单时逐模型查询详情。

## 来源优先级

1. [Agent Plan Pi 接入](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-pi.md)、[Coding Plan Pi 接入](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md)中的明确整数，分别按套餐采用。
2. 对应套餐的[Agent 概览](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)、[Coding 概览](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)。
3. 官方文档明确指向的 `dsh-volcengine-plugin@0.8.4` [Plan 目录](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)补缺失整数、别名。其官方来源链见 [DeepSeek Harness 接入文档](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-deepseek-harness.md#configure-via-plugin)。参考文件 SHA-256：`9d921b7a989af72c49ee69ad61d9ab4fc1863af6fc7c4f1c6c6b04968716a9ad`。
4. 目标 Core（Peer 声明 `>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`，已核验宿主 `0.2.1-rc.4` 与 `0.2.2-rc.1`）消费的 `@earendil-works/pi-ai@1.1.0` [发行元数据](https://registry.npmjs.org/@earendil-works/pi-ai/1.1.0)、[类型契约](https://unpkg.com/@earendil-works/pi-ai@1.1.0/dist/types.d.ts)与[模型源](https://github.com/earendil-works/pi/tree/main/packages/ai)。类型契约限定 `Model.input` 只含 `text`、`image`，并规定 `thinkingLevelMap` 的 `null` 表示该思考档位不受支持。本机手机版宿主消费的 `1.5.0` 已用真实 Core/SDK smoke 复核该模态与思考档位行为未变，但未逐字段比对类型定义；据此把声明放宽为 `>=1.1.0 <2.0.0`。其他 Provider 的原厂参数仅用于交叉核对，不覆盖更窄的 Plan 配置。旧 `@mariozechner/pi-ai` 不能冒充目标消费版本。

同一 Pi 示例同时使用 `256000`、`262144`、`393216`、`1024000` 和 `1048576`，因此不做统一的“K 乘 1000/1024”转换。

## 固化配置

表中名称为便于查阅的模型族；实际请求 ID 保留 ArkCli 返回的 `output_name`。精确控制面版本与调用别名的对应关系在快照 `aliases` 中逐条声明，不去日期、不替换标点猜测版本。

| 模型 | 上下文 | Agent 最大输出 | Coding 最大输出 | 输入 | 来源/说明 |
|---|---:|---:|---:|---|---|
| Doubao Seed Evolving | 1048576 | 256000 | 256000 | text、image | 两套 Plan Pi |
| Doubao Seed 2.1 Pro | 1048576 | 256000 | 256000 | text、image | 两套 Plan Pi |
| Doubao Seed 2.1 Lite | 1048576 | 256000 | 256000 | text、image | 两套 Plan Pi |
| Doubao Seed 2.0 Mini | 262144 | 128000 | 128000 | text、image | 两套 Plan Pi |
| Kimi K3.1 Pro | 1024000 | 1024000 | 1024000 | text、image | 两套 Plan Pi 当前版均为 1024k/1024k（原厂宣传不作依据） |
| DeepSeek V4.1 Flash | 1048576 | 393216 | 393216 | text、image | 两套 Plan Pi |
| DeepSeek V4.1 Flash Economy | 1024000 | 393216 | 393216 | text、image | 两套 Plan Pi 当前版为 1024k 上下文 |
| Kimi K2.8 Preview | 1048576 | 1048576 | 1048576 | text、image | 两套 Plan Pi；当前快照不沿用旧 131072 |
| GLM 5.3 Flash | 1048576 | 128000 | 128000 | text、image | 两套 Plan Pi |
| GLM 5.3 | 1048576 | 128000 | 128000 | text | 两套 Plan Pi |
| DeepSeek V4 Pro GA | 1048576 | 393216 | 393216 | text | 两套 Plan Pi，不从 V4.1 推导视觉能力 |
| DeepSeek V4 Flash GA | 1048576 | 393216 | 393216 | text | 两套 Plan Pi |
| Kimi K3 | 1048576 | 128000 | 65536 | text、image | 分别采用 Agent/Coding Pi；Coding 是保守示例配置 |
| Kimi K2.7 Code | 262144 | 32768 | 32768 | text、image | Pi 未列；官方 Plan 插件精确整数，两套套餐概览均记 256k/32k |
| MiniMax M3 | 1048576 | 131072 | 131072 | Agent: text；Coding: text、image | 官方 Plan 插件补容量；Coding 概览明确视觉，Agent 视觉未单独核实 |
| ark-code-latest（Auto） | 256000 | 32000 | 32000 | text | 官方插件的控制台路由配置，不代表固定模型的真实边界 |

### 控制台路由：清单记 `auto`，调用用 `ark-code-latest`

真实账号探针（2026-11-03）：两套套餐的 Anthropic Messages 入口把 `auto` 作为模型名调用时返回 `404 UnsupportedModel`（提示“该模型不支持 Agent/Coding Plan 功能”），而同一路径改用 `ark-code-latest` 返回 200，响应 `model` 字段为 `auto`。[Coding Plan Pi 文档](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md)也明确“Model Name 不支持配置为 `Auto`，如需使用请通过控制台切换”。因此：

- 上游 `plans model-list` 仍把该条目列为 `model_id`/`output_name` = `auto`，但目录归一阶段把它映射为可用请求 ID `ark-code-latest`；设置页沿用上游语义显示为“Auto（智能调度）”，技术标识显示真实请求 ID。
- 该条目仍是调度策略：目标模型由控制台选择（含 Auto 模式），能力随目标模型变化。容量沿用官方插件的配置值 256000/32000，并标记“能力未核实”——它是保守声明，不是目标模型的真实上限，也不代表所有目标都支持这个长度。
- 旧缓存与目录归一前保存在 `auto` 名下的逐模型设置按只读方式继续生效；新写入使用 `ark-code-latest`，不改写用户状态文件。
- 目录同时返回 `auto` 与 `ark-code-latest` 时按首次出现合并为一条；同一个原始名字重复出现仍判为坏目录。
- 真正未知的未来版本仍走 32K/8K 保守回退，不按日期或名称猜测版本。

官方概览把 `minimax-m3`、`kimi-k2.7-code` 标注为“即将下线”，快照保留其现有参数并在能力备注中说明；下线后清单不再返回，条目不会凭空保留。

### 模型层模态与当前传输边界

上表“输入”列是当前传输可表达的模态子集，不是模型能力的完整声明。官方模型页与 Plan 目录另有音频、视频输入声明：

| 模型 | 官方声明的额外输入模态 | 来源 |
|---|---|---|
| Doubao Seed 2.1 Lite、Doubao Seed 2.0 Mini | audio | 官方 Plan 目录 `input` |
| Doubao Seed Evolving、2.1 Pro、2.1 Lite、2.0 Mini | video | 官方 Plan 目录 `input` |
| DeepSeek V4.1 Flash、V4.1 Flash Economy | video | 官方 Plan 目录 `input`；V4.1 专页写方舟支持视频理解 |
| Kimi K3、Kimi K2.8 Preview、Kimi K2.7 Code | video | 官方 Plan 目录 `input`；Coding 概览写 K2.7 Code“支持文本、图片与视频输入” |
| Kimi K3.1 Pro | video | 方舟模型页写“支持文本、图片和视频输入”；该模型不在 0.8.4 版官方 Plan 目录中 |
| GLM 5.3 Flash | video | 官方 Plan 目录 `input` |
| GLM 5.3、DeepSeek V4 Pro GA、DeepSeek V4 Flash GA | 无额外声明，目录 `input` 仅 text | 官方 Plan 目录 |

当前传输无法表达这些模态：`@earendil-works/pi-ai@1.1.0`（并在本机 `1.5.0` 上以真实 Core/SDK 复核）的 `Model.input` 只允许 `text` 与 `image`，[Messages 接口](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)没有音频、视频内容块，[DSH 接入文档](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-deepseek-harness.md#configure-manually)也只让在模型上写 `input: [text, image]`。因此快照只声明 text/image 是传输边界下的子集，不代表模型不支持音频或视频；官方目录与模型页的 audio/video 声明单独记录，不据此改动快照声明。

### 明确保留的冲突

- Coding Kimi K3：Pi 明确为 `65536`；Coding 概览为 `128k`、官方插件为 `131072`。本次选择较保守且整数明确的 Pi 配置，不宣称已实测服务端硬上限。
- Economy 上下文：两套 Plan Pi 当前版为 `1024000`、概览写 `1024k`，均与 1M 标称值不同；官方插件目录仍为 `1048576`。按对应 Plan Pi 选值，不把 `1024000` 与 `1048576` 默认为相等。
- Kimi K3.1 Pro 输出：两套 Plan Pi 与概览当前版均为 `1024000`；旧版 Pi 曾写 `128000`，本次以当前版为准并同步更新快照。
- Kimi K2.8 输出：当前两套 Plan Pi 为 `1048576`，旧官方插件为 `131072`；采用当前套餐接入文档。
- Doubao 2.1/Evolving 输出：Pi 为 `256000`，官方插件为 `262144`；Mini 则是 `128000` 与 `131072`。逐字段按上述优先级保留，不统一二进制化。
- GLM 输出：Pi 为 `128000`，官方插件/原厂 pi-ai 为 `131072`；采用套餐 Pi。
- MiniMax M3 模态：Coding 概览写“支持多模态视觉理解”，官方 Plan 目录在 Agent 与 Coding 两段的 `input` 都只有 `text`。按来源优先级 Coding 采用 text/image、Agent 保持 text；两个官方来源的冲突保留，不把目录的 text 单独解释为模型无视觉能力。
- 官方 Plan 目录含两套套餐概览未列的条目（如 `doubao-seed-2.1-turbo`、`doubao-seed-2.0-lite`）。默认快照参考套餐概览与 Pi 文档，不因旧目录条目自动补入；实际清单以所选账号的 ArkCli 返回为准。目录另定义的 `deepseek-latest`、`minimax-latest`、`kimi-latest` 别名在 Coding Pi 的 Model Name 清单中亦未列出，未核实精确对应关系前不并入 `aliases`。

## 消耗倍率

核验日期：2026-10-30。设置页的倍率来自[套餐内 AFP 抵扣规则](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-afp-credits-billing-rules)与[Agent/Coding Plan 指定模型抵扣系数限时折扣活动](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-model-discount)。文本模型的输入与输出系数相同；AFP 公式为 `(输入 token × 输入系数 + 输出 token × 输出系数) / 10000`。本地快照只保存常规值和带起止时间的折扣，读取设置页时判断活动是否有效，不把限时值永久固化为常规值。

| 模型 | 常规倍率 | 限时倍率与结束时间（UTC+8） |
|---|---:|---|
| Doubao Seed 2.0 Mini | 0.25 | — |
| DeepSeek V4 Flash、Doubao Seed 2.1 Lite、GLM 5.3 Flash | 0.5 | — |
| DeepSeek V4.1 Flash Economy | 2 | 1，至 2026-12-30 23:59:59 |
| DeepSeek V4.1 Flash | 2.5 | 1.25，至 2026-12-30 23:59:59 |
| Doubao Seed Evolving、2.1 Pro、MiniMax M3 | 2.5 | — |
| Kimi K3.1 Pro | 7 | 3.5，至 2026-11-09 23:59:59 |
| Kimi K2.7 Code、GLM 5.3 | 4.5 | — |
| Kimi K2.8 Preview | 8 | 4.8，至 2026-12-14 23:59:59 |
| Kimi K3 | 10 | 5 折活动已于 2026-10-25 结束，当前展示常规值 |
| DeepSeek V4 Pro | 5.5 | — |

- Agent Plan 的标识直接表示上述 AFP 抵扣系数。Coding Plan 界面沿用上述模型系数作相对消耗参考，但额度接口只给百分比，不能用该标识推算固定调用次数或 AFP 绝对量。
- AFP 规则页与活动页的展示更新时间可能不同；Kimi K3 在活动页列明的 5 折窗口已经结束，本地快照不记录任何折扣起止时间，直接展示常规值 10，不继续沿用规则页残留的“限时 5”文案。
- `auto`、`ark-code-latest` 和未知版本没有固定目标模型，不显示倍率。精确 ID 与两套套餐的别名映射保存在 `src/consumption-rates.json`；该元数据只用于设置页，不进入 Core 模型描述或请求载荷。
- 官方概览另写 Auto 模式在活动期内的抵扣系数（Agent 0.5、Coding 1，至 2026-11-08 23:59:59）。该值按套餐不同、且目标模型由控制台切换，单一倍率字段无法如实表达，因此控制台路由仍不显示倍率，也不据活动值推算调用次数。

## 显示名称

固定模型在快照中声明可读标签，例如“豆包 Seed 2.1 Pro”“DeepSeek V4.1 Flash”“Kimi K3.1 Pro”。读取旧缓存或重新拉取时，ID、带日期的别名和代码式名称采用该标签，已有可读的服务端名称保留。动态路由显示为“Auto（智能调度）”，其容量仍按未知项处理。

名称只用于展示；模型匹配、请求参数、开关和覆盖配置继续使用原调用 ID。设置页将 ID 收入默认折叠的“模型技术标识”，模型选择器获得相同的可读名称。

## 思考档位与传输边界

Plan 使用 `anthropic-messages`，原生档位字段为 `output_config.effort`。[Messages 文档](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)明确将支持模型、默认与折叠规则链接到[深度思考表](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)。逐模型证据、来源层级、精确缺项及验证状态见[模型思考审计](<model-thinking-audit.md>)；已确认的能力与线上请求验证分别记录。

| 模型 | 独立思考强度 / 其他状态 | 插件继承默认 | 默认关闭入口 | Messages 原生模式 |
|---|---|---|---|---|
| Doubao Evolving、2.1 Pro、2.1 Lite | low/medium/high（官方另有 minimal 不思考、none→minimal；本地只开放三档） | high | 提供 | enabled + effort |
| Doubao 2.0 Mini 260428 | low/medium/high（官方另有 minimal 不思考、none→minimal；本地只开放三档） | medium | 提供 | enabled + effort |
| DeepSeek V4.1 Flash / Economy 261017 | low/high/max（官方 minimal→low；本地未开放 minimal） | high | 提供 | adaptive + effort |
| DeepSeek V4 Pro / Flash GA | low/high/max（官方 none/minimal→关闭；本地用关闭入口表达） | high | 提供 | enabled + effort |
| Kimi K3.1 Pro | low/high/max；常驻思考，只开放三档 | max | 不提供 | enabled + effort |
| Kimi K3 | low/high/max；常驻思考 | 服务端默认，官方未列档位默认 | 不提供 | enabled + effort |
| Kimi K2.8 Preview | low/high/max | 服务端默认，官方未列 | 不提供，关闭未单列 | enabled + effort |
| Kimi K2.7 Code | 思考已确认（Coding 概览；Agent 侧未确认），可调独立档未列 | 服务端默认 | 不提供，关闭未单列 | server-default |
| GLM 5.3 | low/high/max；常驻思考 | 服务端默认；原厂为 max，火山未单列 | 不提供 | enabled + effort |
| GLM 5.3 Flash | low/high/max；常驻思考 | max，依据 Platform 260828；Plan backend260901 未另列 | 不提供 | enabled + effort |
| MiniMax M3 | low/medium/high（官方目录 off→minimal；本地不开放 off） | medium，官方 Plan 目录 | 不提供；官方 off→minimal 不单独证明完全关闭 | enabled + effort |
| Auto / ark-code-latest | 动态目标，无固定统一档位 | 服务端默认 | 不提供统一保证 | server-default |

该列前半为项目实际开放的思考强度，括号内为官方折叠规则。官方折叠描述服务端如何处理收到的值，不增加本地开放的档位；逐档位的 wire 取值见[本地实际开放档位](<model-thinking-audit.md#本地实际开放档位与-wire-取值>)。

- 模型级请求载荷适配将 Core 档位选择与最终 `thinking.type` 分开：V4.1 两款采用专页要求的 adaptive，其余已知可调模型采用 enabled；二者均使用 `output_config.effort`，不附带 Claude 预算/显示字段。关闭请求使用 disabled；未指定且官方默认未列时不补 effort。server-default 不注入思考控制。
- [官方插件 0.8.4 transport](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)通用地把 adaptive 改为 enabled，与 [V4.1 专页](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md#reasoning-effort)“adaptive 才使 effort 生效”冲突；项目采用模型专页优先，不统一改写 V4.1。
- 兼容别名不增加独立强度；官方折叠规则描述服务端对传入值的处理，不是项目开放的档位集合。具体折叠与本地开放档位的对应按[逐模型规则](<model-thinking-audit.md#兼容别名折叠>)与[本地实际开放档位](<model-thinking-audit.md#本地实际开放档位与-wire-取值>)处理。
- 旧用户显式预算覆盖保留为兼容模式，与模型原生 effort 分开；Core 的 minimal=1024 预算仍开启思考，不等价于 Doubao 官方折叠里的 minimal 不思考。`reasoningEfforts:false` 仅表示不提供可调档，不表示模型无思考或强制关闭。

## 缓存与用户覆盖

- 旧目录中的通用 32768/8192 回退会在读取时与最新固化配置合并，更新内存中的能力默认值；不改写生产状态文件，不改变账号绑定、模型请求 ID 或启用状态。
- 旧目录把控制台路由记在 `auto` 名下时，读取阶段归一为 `ark-code-latest` 后仍走同一条固化配置；重名条目按首次出现去重，避免同一路由进入 Core 两次。
- `modelSettings` 仍是用户显式覆盖，优先于快照，恢复默认才清除覆盖。若目录更新移除了已保存的默认思考档位，原值保留，调用暂不强制失效档位；设置页提供提示和重新选择入口。显式自定义映射仍可定义自己的有效档位。
- 目录归一前可能把设置保存在 `auto` 名下；读取控制台路由时继续采用该设置，新保存写入 `ark-code-latest`，不改写旧键。
- 用户只缩小上下文而未显式指定输出时，继承输出被约束到有效上下文，避免更新默认值后出现输出大于上下文。
- 显式输出高于当前目录上下文（多由快照下调引起）时，原设置保留在 `modelSettings` 中，有效调用按上下文收敛并在设置页提示；这样单个模型不会让整条路由更新失败。
- `aliases` 和未核实标签只用于匹配/展示，进入 Core 模型描述前剥离，避免未知字段泄漏到第三方 schema。

## 维护与验收

更新时同时检查当前 Plan `model_id` / `output_name` 映射、对应套餐资料、冲突表和回归样本。`test/catalog-snapshot.test.mjs` 覆盖当前清单、整数值、显式别名、不同版本拒绝猜测、`auto`→`ark-code-latest` 归一、旧缓存与旧设置键升级、覆盖优先级和 Core 参数传播。测试只验证本地声明，不代替真实服务端边界测量；控制台路由的可用请求 ID 以真实调用探针为准，见[验证记录](validation.md)。
