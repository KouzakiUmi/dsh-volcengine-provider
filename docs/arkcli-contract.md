# ArkCli 接口依据与验证边界

## 版本与证据

目标 DSH Core 为 **`>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`**（已核验宿主为桌面 `0.2.1-rc.4` 与手机版 `0.2.2-rc.1`），消费的 `@earendil-works/pi-ai` 声明为 `>=1.1.0 <2.0.0`（已核验 `1.1.0` 与 `1.5.0`）；ArkCli 命令契约对照官方 CLI 帮助、随包官方 Skills 与官方仓库文档。**目标 CLI 需支持 `arkcli auth login volc-sso --no-browser` 两段式**：已用本机 ArkCli 1.0.37 实测 Phase 1 URL 输出格式、session 接力与 Phase 2 pending session 解析；真实授权码端到端登录未验收。既有 1.0.37 帮助、raw action `--dry-run` 与旧同设备真实验收仅作历史记录，不作为两段式已验收的依据；真实额度和推理调用尚未执行。

## OAuth

登录改用官方 CLI 的 `--no-browser` 两段式；插件只与官方 CLI 子进程交互，不启动浏览器、不拦截系统 URL opener。

Phase 1 —— 生成官方登录链接：

```sh
arkcli auth login volc-sso --no-browser
```

已用真实 ArkCli 1.0.37（Windows）验证：`volc-sso` 打印跨设备登录 URL、把 PKCE session 落盘到 `.arkcli/.sso-pending.json` 后以退出码 0 结束（含 JSON `authorize_url` / `next_command` / `stage: authorize_pending`，授权码有效期 600 秒）。不带 `volc-sso` 的 `auth login --no-browser` 是同设备回调流程：打印 `callbackPort` URL 后持续等待本地回调，不能用。CLI 打印官方登录 URL。插件只放行官方 CLI 输出的白名单官方链接：校验精确 HTTPS 主机/路径后把链接展示在设置页，不构造或改写会话参数（URL 输出格式与字段已按 1.0.37 实测核验）。用户在任意设备的浏览器完成 SSO，官方页面给出 base64 授权码。

Phase 2 —— 粘贴授权码完成登录：

```sh
arkcli auth login --no-browser --code <授权码> --credential-store encrypted-file
```

官方 CLI 用授权码完成 PKCE 交换并把凭据落盘到隔离账号目录。插件不处理 OAuth token 端点、不读取网页或授权码内容：授权码只在内存中作为 CLI 子进程 argv 传入，不落盘、不进 UI 状态、不进日志。

安全边界改写为只放行官方 CLI 输出的白名单官方链接 + 两段式流程；不再限定「仅已核验的 Windows ArkCli 1.0.37」，也不再写「不回退 cross-device 授权码流程」。插件不打包 Windows 原生桥二进制、不依赖 `playwright-core`。目标 CLI 需支持 `auth login volc-sso --no-browser` 两段式；已用本机 ArkCli 1.0.37 实测 Phase 1 URL 输出、session 落盘接力与 Phase 2 的 pending session 解析（假授权码进入内容校验，错误分支以退出码 0 返回 `{"ok":false}`，插件按输出判定失败）。真实授权码完成登录的端到端验收仍未执行，不得表述为已通过完整真实登录。

若 CLI 要求选择消费场景、签协议或配置 Key，插件会失败而不是替用户签署或创建/轮转 Key。缺少 CLI 或 CLI 不支持两段式时明确失败，不降级到旧的浏览器启动链。

### 账号隔离

官方 CLI 同时只有一个 active identity，跨身份登录可能清空并重建原 profile。因此每个插件账号独立设置 `HOME`、`USERPROFILE` 和 `XDG_CONFIG_HOME`，清除子进程继承的 Ark/Volc/AWS 身份变量，使用账号自己的 `.arkcli` 目录。

这不改变原 CLI 默认身份。Windows 下已通过两个不同的临时 HOME/USERPROFILE 目录运行本机 CLI，确认它在 USERPROFILE 下创建 `.arkcli`。该环境只传给 CLI 子进程；插件不再启动浏览器。两段式的真实授权码端到端交换仍未验收；Phase 1 命令、URL 格式与 Phase 2 pending session 解析已用真实 1.0.37 核验。

登录完成后依次调用：

```sh
arkcli auth whoami --format json
arkcli auth status --format json
```

要求 `logged_in=true`，再按 `profiles_summary[].type` 分别绑定 `agent-plan` 与 `coding-plan` 的 `name`。没有个人套餐或同类多 profile 时拒绝猜选。两类 profile 不交叉借用。

`1.0.37` 随包官方 `arkcli-auth-whoami.md` 明确身份为扁平字段：`name`、`user_id`、`account_id`。插件仅保存这三个字段的白名单摘要（内部为 name/userId/accountId），不持久化完整 CLI 响应；`user_id` 是 IAM 用户 ID，不能与账号 ID 混同。显示时官方名称优先，本地备注独立。旧绑定缺少摘要时尝试只读查询，查询失败不阻止编辑设置。

每次登录使用新的 `accounts/<id>/sessions/<homeId>`；成功核验后原子保存绑定，旧版无 homeId 的绑定继续使用 `accounts/<id>`。已经准备的模型调用保留其原绑定对应的目录，重登不修改该目录。

推理时通过下列接口在 Host 进程内临时读取指定 profile 的默认 Key，直接交给 Core 适配器，不写进插件元数据、不进 UI 状态、不输出日志：

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

控制台路由例外：清单把该条目的 `model_id`/`output_name` 都写成 `auto`，但它不能作为模型名调用（服务端返回 `UnsupportedModel`），官方要求改用 `ark-code-latest`。插件在目录归一阶段把 `auto` 映射为 `ark-code-latest`，展示名称保留上游的 Auto 语义；同一路由在清单出现两个名字时按首次出现合并，同一个名字重复仍是坏目录。证据见[验证记录](validation.md)。

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

源码链接指向上游主干；两段式登录契约以上游官方资料为准，未在本机做真机验收，`ArkCli 1.0.37` 的随包资料仅作历史证据。
