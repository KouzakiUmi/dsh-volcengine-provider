# 验证记录

## 目标与范围

- 实际目标 **DSH Core 0.2.1-rc.3**；兼容声明不扩展到未测试版本。
- ArkCli **1.0.37** 的命令帮助、随包官方 Skills、raw action 注册及无网络预览。
- 全部业务测试使用假凭据、假 CLI 与假网络；Host 测试只使用临时目录。

## 已执行

### 语法、单元测试与构建

```sh
node scripts/check.mjs
node --test test/*.test.mjs
node scripts/build.mjs
```

- JavaScript 语法、manifest 基本字段和前后端依赖边界检查。
- 账号、双订阅隔离、revision 冲突、目录字段/能力、缓存、签名向量、额度错误/单位、OAuth 生命周期、设置页交互及授权 URL 白名单。
- HMAC 签名测试使用独立 OpenSSL 推导的固定向量，不只比较实现自身的两次输出。
- 构建生成 Host 模块与惰性 CommonJS Client 工厂；不新增安装构建依赖。

当前结果：**132 项 JavaScript 单元测试、7 项归档测试全部通过**，24 个 JavaScript 源文件语法/边界检查通过，构建生成 10 个运行产物。发布测试覆盖 OIDC 身份、版本与渠道、归档校验、registry 错误分类及发布后完整性检查。

### 实际 Core 隔离加载

[Host 验证脚本](../scripts/host-smoke.mjs) 通过：

- 真实 Core 导入、Config Schema、Typert RPC 注册。
- 先加载既有原生 llm-pi-ai，再加载本插件，验证共存。
- 独立账号凭据服务桥接、两个路由各 10 个模型；缺凭据时不显示为可用模型。
- 模型上下文和输出规格解析；单独停用 Coding 路由不影响 Agent。
- dispose 后清除本插件服务与两个适配器，既有 Core 不被修改。

复用 Core 传输时使用隔离 `credentials` / `llm` 上下文：局部 registry 先暂存并校验新适配器，再通过稳定代理与宿主公开 registration handle 原子替换路由集；失败保留旧适配器与路由，设置页显示错误，重新选择有效账号可恢复。已在真实 Core 中验证损坏缓存导致更新失败时旧路由仍可用、随后可恢复。不二次贡献原生 pi-ai 的通用配置目录/模型发现 namespace；账号与模型管理由本插件设置页负责。

### 真实 React 与 Chrome 离线交互

[浏览器验证脚本](../scripts/browser-smoke.cjs) 通过：

- 使用目标宿主随包 React/ReactDOM 与已安装 Chrome，在独立非持久浏览器上下文中渲染实际构建产物。
- 只提取宿主静态 React 模块，主动停止宿主应用启动；不访问运行中的 DSH 页面、接口或登录态。
- HTTP(S) 请求被拦截；全部 RPC 为假数据，不打开真实 OAuth 页面。
- 验证双卡片、额度剩余/AFP 分组、网页登录确认前不发起登录、确认后调用与卸载。
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
