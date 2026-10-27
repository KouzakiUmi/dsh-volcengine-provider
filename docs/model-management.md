# 模型管理设计

## 数据与迁移

状态版本升级为 `2`，兼容读取版本 `1`。保留账号、OAuth 绑定、目录和 `active` 的既有语义，并增加：

```js
{
  enabled: { 'agent-plan': true, 'coding-plan': true },
  modelSettings: {
    'account-id:agent-plan': {
      'model-id': {
        enabled: false,
        contextWindow: 131072,
        maxTokens: 8192,
        temperature: 0.5,
        reasoningEfforts: { off: null, low: 'low', high: 'high' },
        defaultReasoning: 'low',
        forceAdaptiveThinking: true
      }
    }
  }
}
```

所有模型设置字段均可省略。版本 1 迁移时，有所选账号的套餐默认为启用，原来未选择账号的套餐默认为停用。迁移只在内存中读取；下一次有效修改才写回。关闭套餐保留所选账号与模型设置；关闭模型保留其他参数；目录刷新保留设置；删除账号清理其设置。

模型参数按账号、套餐、模型隔离。`defaultReasoning`：省略表示使用兼容默认（支持 low 时采用 low，否则不强制）；`null` 表示不强制默认档位；其他值必须由有效的 `reasoningEfforts` 声明支持。`reasoningEfforts: false` 表示无可选思考档位；字典只接受 Core 已有档位，只有 off 可为 null，且至少声明一个非 off 档位。

参数校验：正安全整数 contextWindow/maxTokens，maxTokens 不得超过有效 contextWindow；temperature 为 0 到 1 的有限数；forceAdaptiveThinking 为布尔值。预算模式只接受 off/minimal/low/medium/high，非 off 的映射值必须与档位同名、off 为 null，避免底层将 xhigh/max 折叠为 high 而产生虚假档位。原生 effort 模式按声明的映射值发送。拒绝未知字段、非法模型 ID、数组和敏感凭据字段。设置不会创建目录里不存在的模型。

## 固化能力与缓存

能力参数采用[来源核验快照](model-capabilities.md)，模型清单仍由账号 Plan 查询。显式 `aliases` 连接已核实的控制面 ID、调用别名和文档名称，不根据字符串去日期或改标点猜版本；`aliases` 不是 Core 字段，进入适配器前剥离。

读取已缓存目录时，已识别模型的能力默认值与当前快照合并，保留原调用 ID；代码式展示名采用固化友好名称，已有可读名称保留；不就地写状态、不改变账号/启用状态，`modelSettings` 覆盖仍优先。只缩小上下文而未明确覆盖输出时，继承输出被限制到该上下文；显式输出不被静默改写。未知版本、Auto 及尚未核实的思考控制保守标记。目录移除已保存默认档位时，原设置保留，有效默认改为不强制并返回 `settingsWarning`；界面显示失效选项与重新选择入口，避免旧合法配置阻断模型解析。显式自定义映射不被目录更新覆盖。

## RPC

沿用 `volcengineProvider.invoke` 和 revision 并发检查：

- `setProviderEnabled {plan, enabled, revision}`
- `setModelEnabled {accountId, plan, modelId, enabled, revision}`
- `saveModelSettings {accountId, plan, modelId, settings, revision}`：替换该模型的参数覆盖；省略 enabled 时保留原启用开关，显式提供时才改写。
- `resetModelSettings {accountId, plan, modelId, revision}`：清除该模型覆盖，恢复目录默认（包括启用状态）。

读取仍返回 `active`、`accounts`、`catalogs` 等原字段，新增 `enabled`。每个 `catalogs[]` 增加 `enabledCount` 和 `models[]`：

```js
{ id, name, enabled, capabilityUnverified, settings, defaults, effective }
```

其中 defaults/effective 含 contextWindow、maxTokens、reasoningEfforts、defaultReasoning（无默认时为 null）、forceAdaptiveThinking，temperature 可省略。settings 是原始覆盖值；需处理目录兼容问题时另含 settingsWarning。count 仍为完整目录数量。

## 路由与请求

- 仅启用套餐且存在所选账号时注册路由；仅启用模型进入 Core 目录。
- `providerProfile` 移除全局 `reasoning: low`，避免未知/非思考模型被强制送入不支持的档位。
- 模型能力覆盖进入 Core 模型描述；temperature 和逐模型 defaultReasoning 由 Host 请求包装器应用，显式请求参数优先。
- 已准备的调用捕获当时适配器和默认参数，并持有其上下文直到调用结束或被回收；设置更新不改变在途调用。流结束、取消和错误均释放持有，插件卸载强制中止并清理全部代际；清理错误仅记录，不覆盖请求结果。路由更新失败保留此前路由与默认参数。
- 未知模型保持保守能力，不通过补造思考档位解决调用错误。

## 界面与验证

两张套餐卡片提供独立启用复选框，账号选择与启用状态分开。模型列表提供逐模型开关、参数编辑和恢复默认。参数空值表示继承；思考默认可选继承、不强制或有效档位；模式可选继承、原生 effort、固定预算。说明温度在启用思考时可能被传输层忽略，输出 token 还受思考预算和上下文约束。

验收覆盖：旧状态迁移、关闭后账号保留、开关隔离、设置持久化/重置/刷新保留、非法参数拒绝、未知模型不再触发默认 low 错误、请求覆盖优先级、已准备请求不随设置变化、实际 Core 与假 HTTP 字段验证。真实 OAuth 的独立验收见[验证记录](validation.md)；模型管理脚本不验证真实推理、Plan 上限或服务端思考参数效果。
