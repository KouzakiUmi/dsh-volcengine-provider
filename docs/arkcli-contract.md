# ArkCli 接口依据与验证边界

## 版本与证据

目标 DSH Core 为 **0.2.1-rc.5**；ArkCli 命令契约对照 **@volcengine/ark-cli 1.0.37** 的帮助、随包官方 Skills 与官方仓库文档。帮助、raw API 的 `--dry-run` 和 Windows 同设备真实登录已核验；真实额度和推理调用尚未执行。网页登录的启动器拦截契约仅对 Windows ArkCli 1.0.37 核验，其他平台/版本在登录前拒绝。

## OAuth

网页登录按钮调用官方原生命令：

```sh
arkcli auth login --login-mode broker --credential-store encrypted-file
```

用户点击并确认后，CLI 在独立账号目录中创建官方 broker 会话，生成 `https://ark.volcengine.com/region:cn-beijing/arkcli/login`（或无 region 前缀的相同入口），并携带 callbackNonce、callbackPort 和 sessionId。链接必须通过精确 HTTPS 主机/路径和回调字段校验，且原样交给浏览器，不构造或改写会话参数。官方网页直接回调官方 CLI；插件不处理 OAuth token 端点，不读取网页或授权码，也不使用 cross-device 手动授权码流程。

本机 Windows ArkCli 1.0.37 的浏览器函数已定向核验为 `exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()`。插件只在该登录子进程的 PATH 首位放置仓库 C# 源码编译的同名桥，并设置 NoDefaultCurrentDirectoryInExePath；不会替换系统文件、注册表或默认浏览器。桥通过带每任务 256-bit 随机令牌的 127.0.0.1 POST 将原始链接交回 Host，仅接受一次链接，同链接重试幂等、不同链接拒绝。桥不启动浏览器、不使用代理或系统默认凭据。未核验的平台/CLI 版本在启动登录前拒绝，防止未知启动实现绕过桥。

Playwright Core 1.64.1 在净化环境的独立 Worker 中加载，移除 DEBUG/DEBUG_FILE/PWDEBUG、Node 预加载和 CLI 变量，捕获丢弃驱动输出。它使用 `chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true, env: 正常系统环境 })` 自动创建临时配置，只打开上述原始链接；既不连接现有浏览器，也不指定日常 User Data。CLI 完成且身份/套餐核验后自动关闭所属窗口；取消、超时、失败同样回收浏览器和 IPC。

已用真实 Windows/Chrome/ArkCli 1.0.37 完成官方页面登录、自动回调、whoami 身份、两类个人套餐 profile 和临时绑定持久化验收，结束后清理全部测试凭据。CI 从 Windows 构建产物将原生桥带入通用归档；POSIX wrapper 固定 0755 且预检 X_OK，但其 CLI 启动契约未验收，不开放 POSIX 网页登录。

若 CLI 要求选择消费场景、签协议或配置 Key，插件会失败而不是替用户签署或创建/轮转 Key。缺少 Chrome、Playwright 或不兼容 CLI 时明确失败，不降级到旧的默认浏览器启动链。

### 账号隔离

官方 CLI 同时只有一个 active identity，跨身份登录可能清空并重建原 profile。因此每个插件账号独立设置 `HOME`、`USERPROFILE` 和 `XDG_CONFIG_HOME`，清除子进程继承的 Ark/Volc/AWS 身份变量，使用账号自己的 `.arkcli` 目录。

这不改变原 CLI 默认身份。Windows 下已通过两个不同的临时 HOME/USERPROFILE 目录运行本机 CLI，确认它在 USERPROFILE 下创建 `.arkcli`。该环境只能传给 CLI，不能用于浏览器启动；浏览器始终使用正常系统 HOME/USERPROFILE 和独立临时配置。真实账号同设备自动回调已在 Windows ArkCli 1.0.37 验收；插件不读取官方页面中的授权码。

登录完成后依次调用：

```sh
arkcli auth whoami --format json
arkcli auth status --format json
```

要求 `logged_in=true`，再按 `profiles_summary[].type` 分别绑定 `agent-plan` 与 `coding-plan` 的 `name`。没有个人套餐或同类多 profile 时拒绝猜选。两类 profile 不交叉借用。

`1.0.37` 随包官方 `arkcli-auth-whoami.md` 明确身份为扁平字段：`name`、`user_id`、`account_id`。插件仅保存这三个字段的白名单摘要（内部为 name/userId/accountId），不持久化完整 CLI 响应；`user_id` 是 IAM 用户 ID，不能与账号 ID 混同。显示时官方名称优先，本地备注独立。旧绑定缺少摘要时尝试只读查询，查询失败不阻止编辑设置。

每次登录使用新的 `accounts/<id>/sessions/<homeId>`；成功核验后原子保存绑定，旧版无 homeId 的绑定继续使用 `accounts/<id>`。已经准备的模型调用保留其原绑定对应的目录，重登不修改该目录。

推理时通过下列接口在 Host 进程内临时读取指定 profile 的默认 Key，直接交给 Core 适配器，不写进插件元数据、不发给浏览器、不输出日志：

```sh
arkcli profile apikey get --profile <profile> --plain
```

## 模型目录

```sh
arkcli plans model-list --plan agent-plan --profile <profile> --format json
arkcli plans model-list --plan coding-plan --profile <profile> --format json
```

官方响应：

```json
{
  "plan": "agent-plan",
  "selected_model_id": "backend-model-id",
  "models": [{"model_id": "backend-model-id", "model_name": "展示名", "output_name": "data-plane-alias", "selected": true}]
}
```

配置调用 ID 优先 `output_name`，空时才使用 `model_id`；`model_name` 仅展示。空数组表示当前目录为空，不能用旧列表掩盖。按账号和订阅分别缓存。

目录不包含完整能力规格。已知模型沿用兼容快照；未知模型默认声明文本输入、32768 上下文、8192 输出，不提供未核实的思考档位，也不强制默认 low。用户可在模型参数中按已确认的能力设置覆盖值。这些起始值不是官方模型能力承诺。

Anthropic Messages 协议与 `/api/plan`、`/api/coding` 地址沿用既有 provider 配置；ArkCli 官方 Skills 常展示的是 OpenAI 兼容路径 `/api/plan/v3`、`/api/coding/v3`。不能把后者直接用于 Anthropic 适配器；当前兼容路径与能力快照仍需真实推理验证。

## 额度

凭据引用账号使用 IAM AK/SK 签名调用 `GetAFPUsage` / `GetCodingPlanUsage`，行为参考 subusage。推理 API Key 不用于签名。

OAuth 账号复用官方 CLI 鉴权调用 raw action：

```sh
arkcli api usage.get_afp_usage --params '{}' --profile <profile> --format json
arkcli api usage.get_coding_plan_usage --params '{}' --profile <profile> --format json
```

两个 action 在 CLI 注册表存在，其 `--dry-run` 已确认 `network=blocked`。实际 `{}` 请求体及 raw 响应信封未做真实接口验收。使用 raw 而非 `usage plan` 是因为官方文档明确后者不展示 Agent Plan 的 daily 窗口。

- Coding：已用百分比直接读取，`0.39` 不是 `39%`；重置时间单位秒。
- Agent：AFP 绝对 used/limit；重置时间单位毫秒。文本 5h/week、全部能力 month、日能力 day 分组展示。
- 错误、缺凭据、空窗口均明确报告，不假装还有 100% 额度。
- 缓存键包含账号、订阅和绑定信息；共享同一查询，默认 60 秒缓存，可强制刷新。

## 操作范围

登录由设置页按钮启动，套餐购买、续费、协议确认和 Key 管理在官方流程中完成。身份查询采用 `auth status`；官方 `profile list/show` 可能同步并回写 Key 库存。删除插件账号仅移除元数据，隔离 CLI 凭据目录保留。

## 官方来源

- [ArkCli 官方仓库](https://github.com/volcengine/ark-cli)
- [OAuth 登录参考](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-auth/references/arkcli-auth-login.md)
- [套餐模型目录](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-plans/references/arkcli-plans-model-list.md)
- [套餐额度与 daily 限制](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-usage/references/arkcli-usage-plan.md)
- [Profile 管理与副作用](https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-profile/SKILL.md)

源码链接指向上游主干；当前适配契约以 ArkCli 1.0.37 的随包资料为准。
