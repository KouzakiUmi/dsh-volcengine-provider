# ArkCli 接口依据与验证边界

## 版本与证据

目标 DSH Core 为 **0.2.1-rc.3**；ArkCli 命令契约对照 **@volcengine/ark-cli 1.0.37** 的帮助、随包官方 Skills 与官方仓库文档。帮助和 raw API 的 `--dry-run` 已核验；真实登录、真实额度和推理调用尚未执行。CLI 更新可能改变响应格式。

## OAuth

网页登录按钮调用官方原生命令：

```sh
arkcli auth login volc-sso
```

用户点击并确认后，由 CLI 打开浏览器、创建 OAuth 请求、处理本地回调并管理身份。页面提供等待授权、核验、成功、失败、取消和五分钟超时状态。

登录页面参考：<https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=>。实际授权地址和回调参数由 CLI 生成，页面随 CLI 版本而定。

`auth login` 根命令可能展示交互菜单；显式 `volc-sso` 避免依赖该菜单。本机版本的 `--login-mode` 只在根命令注册，`volc-sso --login-mode broker` 会报 unknown flag，因此没有向子命令传此参数。

官方浏览器流使用 loopback callback。非 TTY 首次登录能否无需额外交互完成尚未实测；若 CLI 要求选择消费场景、签协议或配置 Key，插件会失败而不是替用户签署或创建/轮转 Key。官方另有 `--no-browser` 两段式授权码流程，本插件当前不实现该交互。

### 账号隔离

官方 CLI 同时只有一个 active identity，跨身份登录可能清空并重建原 profile。因此每个插件账号独立设置 `HOME`、`USERPROFILE` 和 `XDG_CONFIG_HOME`，清除子进程继承的 Ark/Volc/AWS 身份变量，使用账号自己的 `.arkcli` 目录。

这不改变原 CLI 默认身份。Windows 下 Go 通常通过 `USERPROFILE` 解析 home；该隔离设置已做假进程验证，但仍需要真实 OAuth 验收。原系统浏览器 Cookie 不由插件清理；用户需在官方页面确认实际授权账号。

登录完成后依次调用：

```sh
arkcli auth whoami --format json
arkcli auth status --format json
```

要求 `logged_in=true`，再按 `profiles_summary[].type` 分别绑定 `agent-plan` 与 `coding-plan` 的 `name`。没有个人套餐或同类多 profile 时拒绝猜选。两类 profile 不交叉借用。

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
