# 火山方舟 Provider：项目设计与维护

## 项目目的

为 DeepSeek Harness 提供国内个人版火山方舟 Agent Plan / Coding Plan 接入，集中管理账号、官方网页登录、模型目录和套餐额度。功能说明见 [README](README.md)，接口依据见 [ArkCli 文档](docs/arkcli-contract.md)。

## 命名约定

| 用途 | 固定名称 |
|---|---|
| 用户可见名称、设置页标题、文档标题 | **火山方舟 Provider** |
| npm 包名、插件导出名、仓库名 | `dsh-volcengine-provider` |
| RPC 服务 / namespace | `volcengineProvider` |
| 设置分区 ID | `volcengine-provider` |
| Agent Plan 路由 | `volcengine-agent-plan` |
| Coding Plan 路由 | `volcengine-coding-plan` |

显示名称与技术标识分开维护。包名用于安装命令、模块加载、日志来源和数据目录，不作为用户界面标题。调整显示文案时保留技术标识及已有数据路径，避免破坏 RPC、账号状态和模型路由。

## 采用方案与关键取舍

- Client 构建产物注册懒加载工厂 `factory(require)`，直接返回 `{ name, inject, apply }`；宿主不传入 CommonJS 的 `module` 或 `exports`。隔离和浏览器测试使用相同的单参数调用契约。
- Host 使用目标 Core 的 pi-ai 传输能力；Client 通过统一 RPC 调用 Host。源代码分别位于 [Host 入口](src/index.mjs) 和 [设置页](src/client.js)，共享契约位于 [RPC 定义](src/remote.mjs)。
- 两套套餐分别保存启用状态与所选账号，关闭套餐保留账号选择；逐模型开关和参数按账号、套餐、模型隔离。账号元数据与凭据引用由 [状态模块](src/state.mjs) 管理；版本 1 状态兼容迁移为版本 2，修改采用 revision 校验与原子写入。
- 网页登录使用官方 `arkcli auth login --login-mode broker --credential-store encrypted-file` 同设备流程，原样打开官方方舟 `/region:cn-beijing/arkcli/login` 链接，回调、会话及凭据均由 CLI 管理。每次登录使用独立 session CLI home，身份和个人套餐核验完成后原子切换绑定；取消、失败或冲突不覆盖上次可用身份。旧绑定没有 homeId 时继续使用原账号目录；已准备请求固定其绑定目录。
- CLI 私有 PATH 中的浏览器启动桥拦截系统 URL opener，通过随机令牌鉴权的 127.0.0.1 IPC 将链接交给 Host；不修改系统 opener、注册表或默认浏览器。Playwright 驱动在净化环境的独立 Worker 中加载，丢弃驱动输出，使用正常系统 HOME/USERPROFILE 和独立临时 Chrome 配置，只打开链接，不读取网页、密码、Cookie 或授权码。CLI 成功核验后及取消/超时/失败时关闭所属浏览器和 IPC；不回退到日常浏览器或 cross-device 授权码流程。
- 启动桥是安全边界：当前网页登录仅允许已核验的 Windows ArkCli 1.0.37，其他平台/版本在启动登录前拒绝。Windows 原生桥由仓库 C# 源码编译，CI 将 Windows 构建产物带入通用归档；POSIX opener 归档固定 0755、运行前检查执行权限，其 CLI 契约仍未验收，不据此开放 POSIX 登录。真实 Windows 同设备登录、双套餐核验和临时绑定已通过，验证边界见验证记录。
- 空账号直接提供网页登录；新增 OAuth 身份在用户确认后自动创建本地账号，无需先填写技术 ID。已有账号时保留“登录其他账号”，不覆盖原账号及套餐选择。已验证账号可通过显式动作选择并启用指定套餐。
- 登录进度传输错误保留进行中状态、取消入口及写入保护，退避重试；启动响应丢失时先读回任务；补读同样失败时保留结果未知的保护态并持续退避同步，确认无任务后才允许重新操作。额度查询按套餐独立忙态，不阻塞账号编辑或切换；身份变化后丢弃旧额度响应。缺少绑定或隔离 Profile 时说明受限操作，不提供必失败的请求。
- 删除账号后清理其编辑草稿；模型继承参数基于目录 defaults 而非含覆盖的 effective；路由更新失败时保存配置不得称为已生效。停用模型的恢复默认入口需明确会重新启用。
- 官方 `whoami` 的 name/user_id/account_id 只以白名单摘要持久化并展示，不保存完整响应。界面优先显示官方名称，本地 label 作为独立备注；旧 OAuth 绑定缺少摘要时，只读恢复身份，不要求重复网页登录。
- 账号快照按套餐提供 oauthProfiles、hasQuotaAccess；OAuth 未绑定的套餐不得回退到手填 profile 或凭据引用。路由更新失败时同时展示所选账号与 appliedAccounts 实际生效账号，避免把保存成功等同于路由生效。
- 设置页保留账号、Agent、Coding 三个同时挂载的编号分区，采用 DSW 主题令牌、统一卡片/控件、主次按钮与原生高级信息折叠；模型默认折叠，成功登录使用紧凑状态，活动/错误/旧授权链接仍保留完整入口。样式按插件实例独立持有并回收。参考 Antigravity ACP 0.1.29 视觉层级及 OpenDesign CoRouter 0.1.4 格式，390px 与深浅色需离线浏览器复验。登录后刷新身份并使旧额度失效；切换账号隔离模型草稿；额度有效百分比、AFP 分组与异步保护不因美化改写。
- 状态写入采用独占文件锁、锁内磁盘 revision 校验和唯一临时文件，防止独立实例覆盖；刷新会同步外部变更并重建路由。异常退出残留锁不自动抢占，须确认无写入进程后处理。
- 登录绑定写入遵循取消信号，取消检查覆盖排队、临时写入及原子替换前；坏模型目录保持设置页可读，路由更新仍显式拒绝损坏数据。
- 凭据引用模式分别使用推理 Key 与 IAM AK/SK；OAuth 模式使用隔离 CLI 身份。账号切换后清除相应缓存，防止身份串用。
- 模型清单优先采用官方返回的 `output_name`，能力参数从可追溯 Plan Pi 文档与官方目录固化；来源优先级、整数值与冲突见 [能力快照来源](docs/model-capabilities.md)。只匹配逐条声明的 aliases，不去日期猜版本；别名元数据进入 Core 前剥离。模型名称使用固化可读标签修正代码式缓存名，可读服务端名称保留；请求及配置键始终使用原 ID，技术 ID 在设置页默认折叠。旧缓存能力在读取时与快照合并，不改写生产状态或清除用户 modelSettings；显式用户覆盖优先，继承输出不超过用户缩小后的上下文。继承能力变化导致默认档位失效时保留原设置、有效调用不强制该档位，并向页面返回可修复提示。Auto/未知版本保守标记；空目录、损坏缓存和读取错误分别处理。
- Coding 额度沿用上游百分比单位；Agent 额度保留 AFP 绝对量并按能力范围分组。缺数据或请求失败时报告状态。
- 路由更新先构造和校验新配置，再原子替换；更新失败时保留此前可用路由与模型默认参数。已准备的调用固定其配置快照。卸载时回收服务、适配器、进程、定时器和缓存。
- Provider 不设置全局默认思考档位；默认档位按单个模型的有效能力选择。未知或非思考模型不强制 low。显式请求参数优先于保存的默认参数，预算模式和原生 effort 模式分别说明。详细契约见 [模型管理设计](docs/model-management.md)。

## 验收标准

1. 安装元数据、设置导航、页面标题和文档使用正确的显示名；包名、RPC、路由和数据目录保持兼容。
2. Agent/Coding 独立启停并保留账号选择；逐模型开关、参数及额度按账号与套餐隔离，错误结果不产生伪造额度。
3. 登录取消、超时、设置冲突和卸载具有明确结果；凭据内容不进入 UI 或插件元数据。
4. 显示名变更须同步相关测试和真实组件截图，同时保留模块技术标识断言。
5. 当前目标 Core 与外部接口的已验证范围以 [验证记录](docs/validation.md) 为准。

## 构建与测试

```sh
node scripts/check.mjs
node scripts/build.mjs
node --test test/*.test.mjs
python -m unittest discover -s test -p 'test_*.py'
```

构建生成 `lib/`，源码与生成产物分开维护。归档包含运行入口、必要模型快照、用户文档与许可证。额外 Core / 浏览器验证入口见 [开发文档](docs/development.md)。

## 发布约定

- 普通版本（包括 `0.x`）发布到 npm `latest`；带 `-beta`、`-rc` 等预发行后缀的版本发布到 `next`。
- GitHub Actions 通过 OIDC Trusted Publishing 发布已验证的同一份归档，版本标签与包版本必须一致。
- 发布后检查精确版本、渠道、完整性和 provenance。npm 异步处理期间先核验现有上传状态，再决定恢复步骤。
- 提交采用 GitHub 可识别的签名；已发布标签与对应归档保留，以维持 provenance 的可追溯性。
