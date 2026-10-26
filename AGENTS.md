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

- Host 使用目标 Core 的 pi-ai 传输能力；Client 通过统一 RPC 调用 Host。源代码分别位于 [Host 入口](src/index.mjs) 和 [设置页](src/client.js)，共享契约位于 [RPC 定义](src/remote.mjs)。
- 两套套餐分别保存启用状态与所选账号，关闭套餐保留账号选择；逐模型开关和参数按账号、套餐、模型隔离。账号元数据与凭据引用由 [状态模块](src/state.mjs) 管理；版本 1 状态兼容迁移为版本 2，修改采用 revision 校验与原子写入。
- 网页登录交给官方 `arkcli auth login volc-sso`。每个账号使用隔离的 CLI home，登录完成后核验身份并绑定对应个人套餐 profile。
- 凭据引用模式分别使用推理 Key 与 IAM AK/SK；OAuth 模式使用隔离 CLI 身份。账号切换后清除相应缓存，防止身份串用。
- 模型目录优先采用官方返回的 `output_name`。本地快照作为起点，未知模型使用保守能力；空目录、损坏缓存和读取错误分别处理。
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
node --test test/*.test.mjs
python -m unittest discover -s test -p 'test_*.py'
node scripts/build.mjs
```

构建生成 `lib/`，源码与生成产物分开维护。归档包含运行入口、必要模型快照、用户文档与许可证。额外 Core / 浏览器验证入口见 [开发文档](docs/development.md)。

## 发布约定

- 普通版本（包括 `0.x`）发布到 npm `latest`；带 `-beta`、`-rc` 等预发行后缀的版本发布到 `next`。
- GitHub Actions 通过 OIDC Trusted Publishing 发布已验证的同一份归档，版本标签与包版本必须一致。
- 发布后检查精确版本、渠道、完整性和 provenance。npm 异步处理期间先核验现有上传状态，再决定恢复步骤。
- 提交采用 GitHub 可识别的签名；已发布标签与对应归档保留，以维持 provenance 的可追溯性。
