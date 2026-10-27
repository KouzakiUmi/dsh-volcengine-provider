# 模型思考档位与 Messages 适配依据

核验日期：2026-10-28（2026-10-27 首次核验，本次按官方原文复核并区分官方折叠规则与本地开放档位）。本文记录火山方舟 Provider 的模型思考能力、默认参数与模型级 Messages 适配约定。上下文、输出整数及当前输入模态配置见[能力快照来源](<model-capabilities.md>)。

## 参数语义与来源层级

- **独立档位**是模型具有不同语义的状态；兼容别名折叠后不增加独立档。关闭与开启思考后的强度分别记录。
- **模型官方默认**与**渠道默认**分开：原厂默认不自动成为火山 Plan 默认。渠道未单列默认时，除表中明确采用的模型级规则外，插件省略 effort、继承服务端默认，不统一填 low。
- **Messages mode**是项目最终请求约定，不把所有通用字段枚举解释成每款模型的逐值保证。`enabled-effort` 使用 `thinking.type=enabled` 与 `output_config.effort`；`adaptive-effort` 使用 `adaptive` 与同一 effort 字段；`server-default` 不注入思考控制字段。
- 思考字段的证据优先级：**A** 为对应精确版本的火山模型专页/深度思考表；**B** 为火山对应 Plan 文档；**C** 为官方插件固定版本的目录与传输实现；**D** 为模型原厂资料。通用 Messages 文档提供字段契约，逐模型专页约束优先于通用适配。该顺序不替换[容量字段的来源优先级](<model-capabilities.md#来源优先级>)。
- **官方折叠规则**与**本地开放档位**是两件事：官方表描述服务端把收到的 effort 值折到哪一档；本项目只开放 `thinkingLevelMap` 显式映射的 Core 档位。`@earendil-works/pi-ai@1.1.0` 的类型契约写明 “Missing keys use provider defaults. null marks a level as unsupported”，映射为 `null` 的档位不发送 wire 值。因此官方折叠中的 `none`、`minimal`、`medium`、`xhigh` 等取值不构成项目开放的档位；两者对照见[本地实际开放档位](<model-thinking-audit.md#本地实际开放档位与-wire-取值>)。

## 逐模型参数表

两套餐共用下表的思考语义；请求 ID 仍使用各自目录的 `output_name`。`sourceURL` 列的编号链接到官方原文，不以模型族名称补齐未声明字段。“独立 effort 状态”列记录官方声明的状态，括号与附注区分本地实际开放档位，后者逐条列在[本地实际开放档位](<model-thinking-audit.md#本地实际开放档位与-wire-取值>)。

| 模型 / 能力对应版本 | 独立 effort 状态 | 模型官方默认 / 渠道说明 | 插件继承默认 | 能否关闭 / 默认关闭入口 | 项目 Messages mode | sourceURL / 层级 | 剩余精确缺项 |
|---|---|---|---|---|---|---|---|
| Doubao Seed Evolving / `latest-version` | `minimal`（不思考）、`low/medium/high` | 火山 `high`；默认开启 | `high` | 可以；提供关闭 | `enabled-effort` | [T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[E](https://ark.volcengine.com/models/doubao-seed-evolving.md)、[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)：A/C | 精确滚动版本的 Plan Messages 逐值行为未单列 |
| Doubao Seed 2.1 Pro / `260915` | `minimal`（不思考）、`low/medium/high` | 火山 `high`；默认开启 | `high` | 可以；提供关闭 | `enabled-effort`；Messages 有该精确 ID 示例 | [T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[M](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)、[DP](https://ark.volcengine.com/models/doubao-seed-2-1-pro.md)：A | 公共 Messages 示例与 Plan 别名的逐值对应未另列 |
| Doubao Seed 2.1 Lite / `260915` | `minimal`（不思考）、`low/medium/high` | 火山 `high`；默认开启 | `high` | 可以；提供关闭 | `enabled-effort` | [T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[DL](https://ark.volcengine.com/models/doubao-seed-2-1-lite.md)、[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)：A/C | 该精确 Plan backend 的 Messages 单独示例未列 |
| Doubao Seed 2.0 Mini / `260428` | `minimal`（不思考）、`low/medium/high` | 火山 `medium`；默认开启 | `medium` | 可以；提供关闭 | `enabled-effort` | [T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[DM](https://ark.volcengine.com/models/doubao-seed-2-0-mini.md)、[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)：A/C | 该精确 Plan backend 的 Messages 单独示例未列 |
| DeepSeek V4.1 Flash / `261017` | `low/high/max`；关闭另列 | 火山 `high`；默认开启 | `high` | 可以；提供关闭；`minimal` **不是关闭** | `adaptive-effort` | [DS](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md#reasoning-effort)、[T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)：A | 专页与官方通用 transport 的模式冲突见下文 |
| DeepSeek V4.1 Flash Economy / `261017` | `low/high/max`；关闭另列 | 火山 `high`；默认开启 | `high` | 可以；提供关闭；`minimal` 不是关闭 | `adaptive-effort` | [DE](https://ark.volcengine.com/models/deepseek-v4-1-flash-economy.md)、[DS](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md#reasoning-effort)、[T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)：A | 同标准版的 transport 冲突；Economy 有显式同参声明 |
| DeepSeek V4 Pro GA / `260813` | `low/high/max`；关闭另列 | 火山 `high`；默认开启 | `high` | 可以；提供关闭 | `enabled-effort` | [VP](https://ark.volcengine.com/models/deepseek-v4-pro-ga.md)、[T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：A/C | Plan 别名下 enabled/adaptive 逐值处理未单列 |
| DeepSeek V4 Flash GA / `260731` | `low/high/max`；关闭另列 | 火山 `high`；默认开启 | `high` | 可以；提供关闭 | `enabled-effort` | [VF](https://ark.volcengine.com/models/deepseek-v4-flash-ga.md)、[T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：A/C | backend `260801` 与请求版本 `260731` 的对应不由公开 sourceModelIds 单独证明 |
| Kimi K3.1 Pro / `261024` | `low/high/max`，只开放三档 | 火山 `max`；常驻思考 | `max` | 不可关闭；不提供关闭 | `enabled-effort` | [K1](https://ark.volcengine.com/models/kimi-k3-1-pro.md)、[T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)、[M](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)：A；[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：C | 深度思考表的 none/minimal 关闭与模型页的三档常驻互斥，见《Kimi K3.1 Pro 的官方原始冲突》；Plan 版本 `261024` 下 thinking.type 各值的处理未单列 |
| Kimi K3 / `260701` | `low/high/max` | 火山 Plan 默认开启；effort 默认未列 | 服务端默认 | 不可关闭；不提供关闭 | `enabled-effort`；省略未指定的 effort | [P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[AP](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)、[CP](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：B/C | 默认档位、三档之外的完整折叠规则未列 |
| Kimi K2.8 Preview / `260901` | `low/high/max` | 官方 Plan 目录未列 effort 默认 | 服务端默认 | 是否可关闭未列；不默认提供关闭 | `enabled-effort`；省略未指定的 effort | [P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[CP](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：B/C | 默认、关闭语义、三档之外折叠与逐模型模式声明未列 |
| Kimi K2.7 Code / `260601` | Coding 概览确认思考，Agent 侧未确认；可调独立 effort 未列 | effort 默认未列 | 服务端默认 | 关闭控制未列；不默认提供关闭 | `server-default` | [CP](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)、[KR](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-model-release.md)、[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)：B/C | Agent 套餐的思考能力无可用一手声明；可调档位、默认、关闭、逐模型 Messages 控制未列 |
| GLM 5.3 / backend `260801` | `low/high/max` | 原厂 `max`；火山 Plan 未单列 effort 默认 | 服务端默认 | 不可关闭；不提供关闭 | `enabled-effort`；省略未指定的 effort | [G](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)：D；[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[AP](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)、[CP](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：B/C | 火山该 backend 的默认、兼容别名折叠、逐模型 Messages 示例未列 |
| GLM 5.3 Flash / Platform `260828`、Plan backend `260901` | `low/high/max` | 火山 Platform `260828` 默认 `max`；Plan `260901` 未独立列默认 | `max`，采用 Platform 对应能力声明 | 不可关闭；不提供关闭 | `enabled-effort` | [GF](https://ark.volcengine.com/models/glm-5-3-flash.md)、[T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)：A；[P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：C | 两个版本标识的默认/折叠没有逐字段等价声明；保留来源版本 |
| MiniMax M3 / `minimax-m3-modelhub` | `low/medium/high` | 官方 Plan 目录 `medium` | `medium` | 官方 `off→minimal` 仅为编码声明，未直接保证完全关闭；不默认提供关闭 | `enabled-effort` | [P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：C | `minimal` 的模型级完整语义、关闭行为、其他 effort 折叠及单独 Messages 文档未列 |
| `ark-code-latest` | 账号选择路由，无固定集合 | 随选中目标，无统一 effort 默认 | 服务端默认 | 无统一关闭保证；不默认提供关闭 | `server-default` | [P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[R](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md#3a775131)：B/C | 无统一固定容量、模态、档位与开关契约 |
| Auto | 智能调度模式，无固定集合 | “默认选择”指路由模式，不是 effort 默认 | 服务端默认 | 无统一关闭保证；不默认提供关闭 | `server-default` | [R](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md#3a775131)、[CP](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)：B | 无统一固定能力；Model Name 不支持配置为 Auto，通过控制台选择 |

## 兼容别名折叠

下表是官方服务端对传入 effort 值的折叠规则，描述请求侧取值如何被归并；它不等于项目开放给用户的档位。项目实际可选项与 wire 取值见[本地实际开放档位](<model-thinking-audit.md#本地实际开放档位与-wire-取值>)。

| 模型范围 | 官方折叠规则 | 项目含义 |
|---|---|---|
| Doubao Evolving、2.1 Pro/Lite `260915`、2.0 Mini `260428` | `none→minimal`；`minimal` 不思考；`xhigh/max→high` | low/medium/high 是三个思考强度；minimal 是独立关闭状态，预算 1024 不是它的等价实现；本地只开放 low/medium/high，关闭走 `thinking.type=disabled` |
| DeepSeek V4.1 Flash / Economy `261017` | `minimal→low`、`medium/xhigh→high`、`ultra→max`；Chat/Responses 的 `none` 关闭 | Messages 专页只列 low/high/max；关闭单独通过 `thinking.type=disabled` 表达；本地未开放 minimal 档位，映射为 `null` 即不发送该 wire 值 |
| DeepSeek V4 Pro GA `260813`、Flash GA `260731` | `none/minimal→关闭`、`medium→low`、`xhigh→high` | minimal 不增加第四个思考强度；关闭使用独立入口 |
| Kimi K3.1 Pro `261024` | 深度思考表：`none/minimal→关闭思考`、`low→low`、`medium/high→high`、`xhigh/max→max`；模型页：只有 low/high/max 三档且不可关闭 | 两份官方原文互斥；本地只开放 low/high/max，不提供关闭入口，见《Kimi K3.1 Pro 的官方原始冲突》 |
| GLM 5.3 Flash Platform `260828` | `none/minimal/low→low`、`medium/high→high`、`xhigh/max→max` | 不提供 off；官方 Plan 目录 `260901` 的六个输入键不能解释成六种独立强度 |
| GLM 5.3 原厂 | 普通原厂 API 只接受 low/high/max；原厂 Coding Plan 有七输入折叠 | 原厂 Coding Plan 与火山 Coding Plan 不同，不将其折叠直接写成火山保证 |
| Kimi K3、K2.8 Preview | 官方目录只有 low/high/max 同名映射 | 不套用 K3.1 的折叠 |
| MiniMax M3 | 官方目录 `off→minimal`，另列 minimal/low/medium/high | 保留编码证据；不由 off 键名推断完全关闭，不自行增加 max/xhigh 折叠 |

规则来源：[火山深度思考表 T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md#fc5eac89)、[V4.1 模型专页 DS](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md#reasoning-effort)、[官方 Plan 目录 P](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[智谱原厂思考说明](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)。

### 本地实际开放档位与 wire 取值

下表是继承快照时的默认档位集合，由 `thinkingLevelMap` 决定：只有显式映射的 Core 档位会被发送，映射为 `null` 的档位按 pi-ai 契约不受支持。用户显式自定义映射时，以其有效映射为准。

| 模型 | Core 可选档位 | `output_config.effort` 取值 | 关闭方式 |
|---|---|---|---|
| Doubao Evolving、2.1 Pro、2.1 Lite、2.0 Mini | off、low、medium、high | low、medium、high 原值 | `thinking.type=disabled` |
| DeepSeek V4.1 Flash / Economy | off、low、high、max | low、high、max 原值 | `thinking.type=disabled` |
| DeepSeek V4 Pro / Flash GA | off、low、high、max | low、high、max 原值 | `thinking.type=disabled` |
| Kimi K3.1 Pro | low、high、max | low、high、max 原值 | 无关闭入口 |
| Kimi K3、Kimi K2.8 Preview | low、high、max | low、high、max 原值 | 无关闭入口 |
| GLM 5.3、GLM 5.3 Flash | low、high、max | low、high、max 原值 | 无关闭入口 |
| MiniMax M3 | low、medium、high | low、medium、high 原值 | 无关闭入口 |
| Kimi K2.7 Code | 无 | 不发送 | 不适用 |
| ark-code-latest / Auto | 无 | 不发送 | 不适用 |

默认快照没有开放 `minimal`：官方折叠把它折到 `low`（V4.1）或视为不思考（Doubao），两种都不是独立思考强度，因此默认配置不提供该 Core 档位。用户可按有效性规则自定义映射；官方目录的 `off→minimal` 编码本身不构成 MiniMax M3 的关闭入口。

### Kimi K3.1 Pro 的官方原始冲突

[深度思考表 T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md#fc5eac89) 的 `kimi-k3-1-pro-261024` 行原文为：

> 传入 `none` / `minimal`：将关闭思考
> 始终开启思考，不使用 **thinking** 参数。
> 传入 `low`：将映射为 `low`；传入 `medium` / `high`：将映射为 `high`；传入 `xhigh` / `max`：将映射为 `max`

[Kimi K3.1 Pro 模型页](https://ark.volcengine.com/models/kimi-k3-1-pro.md)写：

> 具备1M上下文与三档思考强度
> 思考常驻，通过 reasoning_effort 在 low / high / max 之间调节即可
> 思考模式能关吗？不能，思考常驻是旗舰模型的刻意设计

两份官方原文互斥：深度思考表给出 none/minimal 的关闭路径，模型页只承认 low/high/max 且不可关闭。项目按模型页的实际档位收口，只开放 low/high/max、不提供关闭入口；深度思考表的 none/minimal 关闭路径作为未采信的官方冲突保留，不据此推断 wire 值，也不因此改写容量与模态结论。

### `thinking.type` 适用性未确认的模型

[深度思考表 T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)的“支持模型”清单列出可传 `thinking.type` 的条目，含 doubao 家族（`doubao-seed-evolving`、`doubao-seed-2-1-pro-260915`、`doubao-seed-2-1-lite-260915`、`doubao-seed-2-0-mini-260428`）、`glm-5-3-flash-260828`、`deepseek-v4-1-flash-261017`、`deepseek-v4-1-flash-economy-261017`、`deepseek-v4-pro-ga-260813`、`deepseek-v4-flash-ga-260731`，以及只在平台直推的若干版本。

清单未包含 `kimi-k3-1-pro-261024`、`glm-5-3-260801`、`kimi-k3-260701`、`kimi-k2-8-260901`、`minimax-m3-modelhub`，而这五款在快照中仍按 `enabled + effort` 发送 `thinking.type`。可依据的只有[官方插件 transport](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)通用改写为 `enabled` 的 C 级实现；深度思考表对 K3.1 Pro 同时写有“不使用 thinking 参数”。因此这五款的 `thinking.type` 适用性标为未确认；档位、容量与模态结论不受影响，是否改用其他传输方式需进一步核验。

## Messages 字段与模型级模式

[Messages API M](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)将 effort 定义为 `output_config.effort`，并明确把支持模型、默认取值、兼容映射及与 `thinking.type` 的关系链接到[深度思考表 T](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)。因此该模型表是字段文档指定的依据，已明确的能力不依赖实际请求才成立。

公共 Messages 文档对 `doubao-seed-2-1-pro-260915` 给出以下精确组合：

```json
{"thinking":{"type":"enabled"},"output_config":{"effort":"medium"}}
```

V4.1 专页的原文是：

> “thinking.type 为 adaptive，output_config.effort 才有效。”

项目据此区分以下请求约定：

| 模式 | 最终思考控制 | 适用范围 |
|---|---|---|
| `adaptive-effort` | `thinking:{type:"adaptive"}` 与 `output_config.effort` | V4.1 Flash 与 Economy |
| `enabled-effort` | `thinking:{type:"enabled"}` 与已指定的 `output_config.effort`；未指定档位且默认未列时不补 effort | 其他已确认具有可调原生档位的模型 |
| 关闭 | `thinking:{type:"disabled"}`；不附带 effort 或预算 | 表中确认可关闭的模型 |
| `server-default` | 不注入 `thinking`、`output_config.effort` 或 `thinking.budget_tokens` | K2.7 Code、动态路由及独立档位未获确认的条目 |
| 显式旧预算兼容模式 | 保留用户显式选择的预算映射与对应 `budget_tokens` | 历史用户覆盖；不作为模型原生档位声明 |

模型级适配使用公开请求载荷钩子 `onPayload`，把 Core 的档位选择与最终 wire 模式分开；原生模式不携带 Claude 专有的预算/显示参数。旧显式覆盖继续作为兼容配置，原生模式的默认与关闭规则不静默替换用户覆盖。

### 官方通用适配与 V4.1 专页冲突

[官方插件 0.8.4 的 transport X](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)先通过 `forceAdaptiveThinking:true` 选择 Core effort 分支，再把 `adaptive/enabled` 一律改写成：

```js
thinking: { type: 'enabled' }
```

其注释为“Ark uses enabled + output_config.effort”，适用于官方公开实现的通用策略，但与 V4.1 专页的 adaptive 生效前提直接冲突。项目采用**模型专页优先**：V4.1 两款保留 adaptive，其余可调模型使用 enabled。通用 schema 存在 adaptive 枚举，并不表示所有模型都要求 adaptive；`forceAdaptiveThinking:false` 导致 Core 预算分支，也不等价于 enabled+原生 effort。

## 版本与默认范围的保留项

- **DeepSeek GA**：Pro 官方 Plan sourceModelIds 明列 `deepseek-v4-pro-ga-260801` 与 `deepseek-v4-pro-ga-260813`；Flash 官方目录只明列 `deepseek-v4-flash-ga-260731`。当前控制面与请求 ID 的精确对应由显式 aliases 维护，不通过删日期匹配其他版本。
- **K3.1 Pro**：火山模型页与深度表的默认 max 对应 `261024`；Plan 请求名称与平台直推名称分属渠道命名空间，不能将平台日期 ID 说明当作 Plan `output_name` 无效的依据。
- **GLM 5.3 Flash**：Platform 模型页和深度表对应 `260828`；官方 Plan 目录来源 ID 为 `260901`。项目采用 max 的模型默认，并同时保留 Plan 未独立给出该默认与折叠表的事实。非 Flash GLM 5.3 只有原厂默认 max、没有火山单列默认，故继承服务端。
- **K3 / K2.8**：三档清单不是默认档位证据，默认保持服务端继承。K2.7 的思考能力只在 Coding 套餐有一手声明，[Coding 概览](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)写“支持文本、图片与视频输入，思考模式，对话与 Agent 任务”，[Agent 概览](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)未声明其思考能力，官方 Plan 目录也没有该模型的 `reasoningEfforts`；Agent 侧的思考能力因此记为未知。两套餐都不声明可调档位，这与非思考模型不同。
- **MiniMax M3**：精确来源 ID 的官方 Plan 目录确认三档和默认 medium；目录中的 off 编码不足以单独证明完全关闭。两套餐当前概览标“即将下线”，固定版本目录仍标 Published；发行快照不代表实时生命周期。
- **动态路由**：`ark-code-latest` 是账号选择路由，控制台可选择 Auto；Auto 是智能调度模式，不是同一固定模型的另一个名字。官方示例 256000/32000 及不同输入模态配置均不能作为所有目标的固定能力。

## 容量、模态与验证状态

容量采用[能力快照来源](<model-capabilities.md>)中的逐套餐整数；原生思考模式不改变这些字段。V4.1 的 Chat/Responses 128K 是请求输出默认，不替代 Plan 的 393216 配置。模型页和官方目录中的视频/音频能力与当前 Messages 可表达的 text/image 范围分别记录，逐模型的额外模态与传输边界见[模型层模态与当前传输边界](<model-capabilities.md#模型层模态与当前传输边界>)；MiniMax Coding 的视觉声明不自动补成 Agent 的已核实范围，且其 Coding 侧视觉与官方 Plan 目录的 text-only 条目构成来源冲突，已在能力文档的冲突表保留。

本次审计已核对官方能力声明、来源冲突与项目适配约定；真实 Plan 请求、边界容量及具体模式的线上接受性未实测。离线回归验证字段生成、覆盖优先级与模式隔离，不代替线上验证；这一状态不改变表中已获文档确认的档位、默认及开关结论。

## 主要来源

| 编号 | 官方来源与作用 |
|---|---|
| T | [火山深度思考](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)：精确模型开关、默认及兼容折叠 |
| M | [创建 Message](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)：字段、模式枚举与 Pro260915 示例 |
| DS / DE | [V4.1 专页](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md)、[Economy 模型页](https://ark.volcengine.com/models/deepseek-v4-1-flash-economy.md)：Messages 专属条件、经济版显式同参 |
| P / X | [官方插件 0.8.4 Plan 目录](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)、[transport.js](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)：精确来源 ID、目录参数、公开 Messages 适配；官方来源链见[方舟 DSH 接入](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-deepseek-harness.md#configure-via-plugin) |
| AP / CP | [Agent Plan 概览](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)、[Coding Plan 概览](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)：渠道范围、模型限制与生命周期 |
| G | [智谱 GLM 5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)：原厂三档、常驻与默认；不替代火山渠道默认 |
| R | [Coding Pi 模型配置](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md#3a775131)：账号路由与 Auto 的关系 |
| K1 | [Kimi K3.1 Pro 模型页](https://ark.volcengine.com/models/kimi-k3-1-pro.md)：三档思考强度、常驻不可关闭、输入模态与工具调用；与深度思考表冲突时并列保留 |
| PI | [pi-ai 1.1.0 类型契约](https://unpkg.com/@earendil-works/pi-ai@1.1.0/dist/types.d.ts)与[Anthropic Messages 适配实现](https://unpkg.com/@earendil-works/pi-ai@1.1.0/dist/api/anthropic-messages.js)：`Model.input` 模态集合、`thinkingLevelMap` 的 `null` 语义、请求侧 `thinking` 与 `output_config` 组装 |
