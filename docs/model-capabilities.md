# 固化模型参数与来源

核验日期：2026-10-27。此表是插件采用的配置快照，不是推理边界实测。模型清单仍从所选账号的 ArkCli Plan 查询；上下文、输出和当前传输可表达的输入模态从本文件列明的一手资料固化，不在拉取清单时逐模型查询详情。

## 来源优先级

1. [Agent Plan Pi 接入](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-pi.md)、[Coding Plan Pi 接入](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md)中的明确整数，分别按套餐采用。
2. 对应套餐的[Agent 概览](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)、[Coding 概览](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md)。
3. 官方文档明确指向的 `dsh-volcengine-plugin@0.8.4` [Plan 目录](https://unpkg.com/dsh-volcengine-plugin@0.8.4/plan-models.json)补缺失整数、别名。其官方来源链见 [DeepSeek Harness 接入文档](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-deepseek-harness.md#configure-via-plugin)。参考文件 SHA-256：`9d921b7a989af72c49ee69ad61d9ab4fc1863af6fc7c4f1c6c6b04968716a9ad`。
4. 目标 Core `0.2.1-rc.3` 消费的 `@earendil-works/pi-ai@1.1.0` [发行元数据](https://registry.npmjs.org/@earendil-works/pi-ai/1.1.0)与[模型源](https://github.com/earendil-works/pi/tree/main/packages/ai)。其他 Provider 的原厂参数仅用于交叉核对，不覆盖更窄的 Plan 配置。旧 `@mariozechner/pi-ai` 不能冒充目标消费版本。

同一 Pi 示例同时使用 `256000`、`262144`、`393216`、`1048576` 和 `1049000`，因此不做统一的“K 乘 1000/1024”转换。

## 固化配置

表中名称为便于查阅的模型族；实际请求 ID 保留 ArkCli 返回的 `output_name`。精确控制面版本与调用别名的对应关系在快照 `aliases` 中逐条声明，不去日期、不替换标点猜测版本。

| 模型 | 上下文 | Agent 最大输出 | Coding 最大输出 | 输入 | 来源/说明 |
|---|---:|---:|---:|---|---|
| Doubao Seed Evolving | 1048576 | 256000 | 256000 | text、image | 两套 Plan Pi |
| Doubao Seed 2.1 Pro | 1048576 | 256000 | 256000 | text、image | 两套 Plan Pi |
| Doubao Seed 2.1 Lite | 1048576 | 256000 | 256000 | text、image | 两套 Plan Pi |
| Doubao Seed 2.0 Mini | 262144 | 128000 | 128000 | text、image | 两套 Plan Pi |
| Kimi K3.1 Pro | 1048576 | 128000 | 128000 | text、image | 两套 Plan Pi；不采用原厂宣传的更高输出 |
| DeepSeek V4.1 Flash | 1048576 | 393216 | 393216 | text、image | 两套 Plan Pi |
| DeepSeek V4.1 Flash Economy | 1049000 | 393216 | 393216 | text、image | 两套 Plan Pi，存在下列来源冲突 |
| Kimi K2.8 Preview | 1048576 | 1048576 | 1048576 | text、image | 两套 Plan Pi；当前快照不沿用旧 131072 |
| GLM 5.3 Flash | 1048576 | 128000 | 128000 | text、image | 两套 Plan Pi |
| GLM 5.3 | 1048576 | 128000 | 128000 | text | 两套 Plan Pi |
| DeepSeek V4 Pro GA | 1048576 | 393216 | 393216 | text | 两套 Plan Pi，不从 V4.1 推导视觉能力 |
| DeepSeek V4 Flash GA | 1048576 | 393216 | 393216 | text | 两套 Plan Pi |
| Kimi K3 | 1048576 | 128000 | 65536 | text、image | 分别采用 Agent/Coding Pi；Coding 是保守示例配置 |
| Kimi K2.7 Code | 262144 | 32768 | 32768 | text、image | Pi 未列；官方 Plan 插件精确整数，概览 256k/32k 佐证 |
| MiniMax M3 | 1048576 | 131072 | 131072 | Agent: text；Coding: text、image | 官方 Plan 插件补容量；Coding 概览明确视觉，Agent 视觉未单独核实 |
| ark-code-latest | 256000 | 32000 | 32000 | text | 官方插件的账号选择路由配置，不代表固定模型的真实边界 |

`auto` 是动态路由，没有已核实的统一容量/模态/档位，不能等同 `ark-code-latest`。若清单返回 `auto`，仍采用标有“能力未核实”的保守回退，而不伪造为 1M。真正未知的未来版本也保留回退。

### 明确保留的冲突

- Coding Kimi K3：Pi 明确为 `65536`；Coding 概览为 `128k`、官方插件为 `131072`。本次选择较保守且整数明确的 Pi 配置，不宣称已实测服务端硬上限。
- Economy 上下文：Plan Pi 为 `1049000`；Platform/官方插件为 `1024k`/`1048576`。按对应 Plan Pi 选值，不将两个数默认为相等。
- Kimi K2.8 输出：当前两套 Plan Pi 为 `1048576`，旧官方插件为 `131072`；采用当前套餐接入文档。
- Doubao 2.1/Evolving 输出：Pi 为 `256000`，官方插件为 `262144`；Mini 则是 `128000` 与 `131072`。逐字段按上述优先级保留，不统一二进制化。
- GLM 输出：Pi 为 `128000`，官方插件/原厂 pi-ai 为 `131072`；采用套餐 Pi。
- MiniMax M3：官方插件仅列 text，Coding 概览明确视觉；Coding 采用 text/image。Agent 未获得相同范围的直接声明，保守采用 text 并保留未核实标记。

## 显示名称

固定模型在快照中声明可读标签，例如“豆包 Seed 2.1 Pro”“DeepSeek V4.1 Flash”“Kimi K3.1 Pro”。读取旧缓存或重新拉取时，ID、带日期的别名和代码式名称采用该标签，已有可读的服务端名称保留。动态路由显示为“Auto（智能调度）”，其容量仍按未知项处理。

名称只用于展示；模型匹配、请求参数、开关和覆盖配置继续使用原调用 ID。设置页将 ID 收入默认折叠的“模型技术标识”，模型选择器获得相同的可读名称。

## 思考档位与传输边界

Plan 使用 `anthropic-messages`，原生档位字段为 `output_config.effort`。[Messages 文档](https://ark.volcengine.com/region:cn-beijing/docs/messages-api.md)明确将支持模型、默认与折叠规则链接到[深度思考表](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)。逐模型证据、来源层级、精确缺项及验证状态见[模型思考审计](<model-thinking-audit.md>)；已确认的能力与线上请求验证分别记录。

| 模型 | 独立思考强度 / 其他状态 | 插件继承默认 | 默认关闭入口 | Messages 原生模式 |
|---|---|---|---|---|
| Doubao Evolving、2.1 Pro、2.1 Lite | low/medium/high；minimal 为不思考 | high | 提供 | enabled + effort |
| Doubao 2.0 Mini 260428 | low/medium/high；minimal 为不思考 | medium | 提供 | enabled + effort |
| DeepSeek V4.1 Flash / Economy 261017 | low/high/max；minimal 折为 low | high | 提供 | adaptive + effort |
| DeepSeek V4 Pro / Flash GA | low/high/max；minimal 折为关闭 | high | 提供 | enabled + effort |
| Kimi K3.1 Pro | low/high/max；常驻思考 | max | 不提供 | enabled + effort |
| Kimi K3 | low/high/max；常驻思考 | 服务端默认，官方未列档位默认 | 不提供 | enabled + effort |
| Kimi K2.8 Preview | low/high/max | 服务端默认，官方未列 | 不提供，关闭未单列 | enabled + effort |
| Kimi K2.7 Code | 思考已确认，可调独立档未列 | 服务端默认 | 不提供，关闭未单列 | server-default |
| GLM 5.3 | low/high/max；常驻思考 | 服务端默认；原厂为 max，火山未单列 | 不提供 | enabled + effort |
| GLM 5.3 Flash | low/high/max；常驻思考 | max，依据 Platform 260828；Plan backend260901 未另列 | 不提供 | enabled + effort |
| MiniMax M3 | low/medium/high | medium，官方 Plan 目录 | 不提供；官方 off→minimal 不单独证明完全关闭 | enabled + effort |
| Auto / ark-code-latest | 动态目标，无固定统一档位 | 服务端默认 | 不提供统一保证 | server-default |

- 模型级请求载荷适配将 Core 档位选择与最终 `thinking.type` 分开：V4.1 两款采用专页要求的 adaptive，其余已知可调模型采用 enabled；二者均使用 `output_config.effort`，不附带 Claude 预算/显示字段。关闭请求使用 disabled；未指定且官方默认未列时不补 effort。server-default 不注入思考控制。
- [官方插件 0.8.4 transport](https://unpkg.com/dsh-volcengine-plugin@0.8.4/transport.js)通用地把 adaptive 改为 enabled，与 [V4.1 专页](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md#reasoning-effort)“adaptive 才使 effort 生效”冲突；项目采用模型专页优先，不统一改写 V4.1。
- 兼容别名不增加独立强度；none/minimal 在常驻模型上可能折为 low，而非关闭。具体折叠按[逐模型规则](<model-thinking-audit.md#兼容别名折叠>)处理。
- 旧用户显式预算覆盖保留为兼容模式，与模型原生 effort 分开；Core 的 minimal=1024 预算仍开启思考，不等价于 Doubao 的 minimal 不思考。`reasoningEfforts:false` 仅表示不提供可调档，不表示模型无思考或强制关闭。

## 缓存与用户覆盖

- 旧目录中的通用 32768/8192 回退会在读取时与最新固化配置合并，更新内存中的能力默认值；不改写生产状态文件，不改变账号绑定、模型请求 ID 或启用状态。
- `modelSettings` 仍是用户显式覆盖，优先于快照，恢复默认才清除覆盖。若目录更新移除了已保存的默认思考档位，原值保留，调用暂不强制失效档位；设置页提供提示和重新选择入口。显式自定义映射仍可定义自己的有效档位。
- 用户只缩小上下文而未显式指定输出时，继承输出被约束到有效上下文，避免更新默认值后出现输出大于上下文；显式输出值不被静默改写。
- `aliases` 和未核实标签只用于匹配/展示，进入 Core 模型描述前剥离，避免未知字段泄漏到第三方 schema。

## 维护与验收

更新时同时检查当前 Plan `model_id` / `output_name` 映射、对应套餐资料、冲突表和回归样本。`test/catalog-snapshot.test.mjs` 覆盖当前清单、整数值、显式别名、不同版本拒绝猜测、旧缓存升级、覆盖优先级和 Core 参数传播。测试只验证本地声明，不代替真实服务端边界测量。
