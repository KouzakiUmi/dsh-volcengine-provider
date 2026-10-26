# 验证记录

## 目标与范围

- 实际目标 **DSH Core 0.2.1-rc.3**；兼容声明不扩展到未测试版本。
- ArkCli **1.0.37** 的命令帮助、随包官方 Skills、raw action 注册及无网络预览。
- 全部业务测试使用假凭据、假 CLI 与假网络；Host 测试只使用临时目录。

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

当前结果：**210 项 JavaScript 单元测试、7 项归档测试全部通过**，31 个 JavaScript 源文件语法/边界检查通过，构建生成 12 个运行产物。模型管理测试覆盖旧状态迁移、套餐/模型开关、逐模型参数、请求默认值及适配器生命周期；发布测试覆盖 OIDC 身份、版本与渠道、归档校验、registry 错误分类及发布后完整性检查。

### 实际 Core 隔离加载

[Host 验证脚本](../scripts/host-smoke.mjs) 通过：

- 真实 Core 导入、Config Schema、Typert RPC 注册。
- 先加载既有原生 llm-pi-ai，再加载本插件，验证共存。
- 独立账号凭据服务桥接、两个路由各 10 个模型；缺凭据时不显示为可用模型。
- 模型上下文和输出规格解析；单独停用 Coding 路由不影响 Agent。
- dispose 后清除本插件服务与两个适配器，既有 Core 不被修改。

复用 Core 传输时使用隔离 `credentials` / `llm` 上下文：局部 registry 先暂存并校验新适配器，再通过稳定代理与宿主公开 registration handle 原子替换路由集；失败保留旧适配器与路由，设置页显示错误，重新选择有效账号可恢复。已在真实 Core 中验证损坏缓存导致更新失败时旧路由仍可用、随后可恢复。不二次贡献原生 pi-ai 的通用配置目录/模型发现 namespace；账号与模型管理由本插件设置页负责。

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
- 已检查[界面预览](client-preview.png)。这不是生产 DSH 页面截图，账号和额度均是假数据。

## 未执行

- 真实 OAuth 浏览器授权及非 TTY 首登。
- 真实 CLI profile 摘要、raw 额度信封、实时模型目录与推理调用。
- 生产 Profile 安装、重启和会话模型迁移。
- 其他 Core / ArkCli 版本、企业席位及跨平台的真实 CLI / 宿主行为。

## 仍需验收的外部契约

1. 官方 `volc-sso` 在非 TTY 的首次消费场景选择；需要选择/协议/Key 操作时必须由用户在官方流程完成。
2. `profiles_summary` 的真实元素结构，以及 raw GetAFPUsage/GetCodingPlanUsage 的 `{}` 请求与响应信封。
3. 沿用配置的 Anthropic 兼容路径、长上下文和思考档位；模型快照不是实时官方能力声明。
4. 实际 OAuth 页面与回调地址由官方 CLI 生成，随 CLI 版本而定。

具体命令依据见[接口文档](arkcli-contract.md)。

## 0.2.1 修复验证

- 单参数 factory(require) 加载实际构建产物，未提供虚假的 CommonJS 参数。
- 覆盖空模型行、非法/重复 ID 和保留名称；坏缓存返回 invalid-cache，正常套餐不受影响。
- 取消排队中的状态写入与登录绑定后，元数据未落盘、模型路由未更新，后续保存仍可执行。
- 临时写入接受 AbortSignal，并在原子替换前再次检查取消状态；已完成的原子提交不会因后续取消而回滚。
- 本机 DSH Desktop 0.2.1-rc.3 已在安装入口修复后实际启动到主界面。
