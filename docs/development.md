# 开发、CI 与发布

[返回主页](../README.md) · [使用说明](usage.md) · [验证记录](validation.md)

## 本地开发

Node.js >=22.19.0；打包使用 Python >=3.9 标准库。

```sh
node scripts/check.mjs
node scripts/build.mjs
node --test test/*.test.mjs
python -m unittest discover -s test -p 'test_*.py'
python scripts/pack.py --output-dir test-output/local-package
python scripts/verify-package.py test-output/local-package
```

`lib/` 为生成目录。Windows 构建使用系统 .NET Framework C# 编译器，从仓库源码生成私有浏览器桥 `lib/browser-bridge/win32/rundll32.exe`；源码树不保存预编译 exe。Linux/macOS 构建不会交叉编译该文件，制作通用包前需恢复同一提交在 Windows CI 构建的桥。归档检查会拒绝缺桥文件或 POSIX opener 缺少执行位的包。

打包产出 `.tgz` 与同名 `.tgz.sha256`；已有同名文件会报错，可换用新的输出目录。

## CI 流程

[工作流](../.github/workflows/ci.yml) 包含四步：**检查 → 打包 → npm 发布 → GitHub Release**。

| 触发 | 测试 / 构建 / artifact | npm 与 Release |
|---|---|---|
| 推送 `main` | 执行 | 跳过 |
| Pull Request | 执行 | 跳过 |
| 手动运行 | 执行 | 跳过 |
| 推送 `v*` 标签 | 执行 | 所有检查通过后执行 |

检查矩阵为 Ubuntu / Windows × Node 22.19.0 / 24。单元测试使用假 CLI、假凭据和外部网络替身，并验证真实本地 loopback IPC；Windows 另执行真实原生桥进程。Windows/Node 24 保存 `windows-browser-bridge` artifact，Ubuntu 打包任务恢复该原生桥后使用 Python 3.12 验证入口、跨平台桥文件、POSIX 执行位、归档路径、校验和及标签版本，上传 `plugin-package` artifact，保留 14 天。

标签发布使用同一次运行已验证的插件包。npm job 使用 GitHub OIDC 短期身份，授权为 `id-token: write`；Release job 单独获取 `contents: write`。其余 job 为只读，官方 Actions 固定到 commit SHA。

## npm Trusted Publisher

包设置中的信任字段必须与工作流精确一致：

| 字段 | 值 |
|---|---|
| GitHub owner | `KouzakiUmi` |
| Repository | `dsh-volcengine-provider` |
| Workflow filename | `ci.yml` |
| Environment | 留空 |
| Allowed action | 允许直接 `npm publish` |

npm 默认的 staged publishing 权限与直接发布不同，需要选择允许直接发布。发布 job 实际检查 Node >=22.14、npm >=11.5.1，并显示运行版本。

绑定信任要求包已存在、账号有写权限且启用 2FA。可在 npm 官网包设置中完成；使用 npm >=11.15.0 时，也可执行：

```sh
npm trust github dsh-volcengine-provider --repo KouzakiUmi/dsh-volcengine-provider --file ci.yml --allow-publish
npm trust list dsh-volcengine-provider --json
```

本机登录及首次发布的安全确认由维护者在官方网页使用 Windows Hello 完成。CI 使用 OIDC，仓库无需保存本机 npm token。

## 首次发布与后续版本

首次创建包时，维护者使用已核验的插件包发布。普通版本（包括 `0.x`）使用 `latest`：

```sh
npm publish ./<插件包.tgz> --access public --tag latest --ignore-scripts --registry=https://registry.npmjs.org/
```

后续更新版本、提交代码，再推送同版本标签：

```sh
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

- 普通版本（包括 `0.x`，如 `0.1.0`）发布到 npm `latest`，供插件市场默认检测与安装。
- 只有带预发行后缀的版本（如 `0.2.0-beta.1`、`1.0.0-rc.1`）使用 npm `next`，GitHub Release 标为 prerelease。
- 标签须与包版本一致，且该版本尚未发布；已存在版本会明确报错，应更新版本号后创建新标签。
- 发布后核验精确版本、dist-tag、tarball integrity 与 provenance；npm 成功后再创建 GitHub Release。
- npm 可能在接受上传后继续异步处理；核验最多 61 轮、间隔 5 秒，并受 job 总时限约束。遇到暂时不可见时先确认已上传版本，避免重复发布。

真实账号和接口的验证状态见[验证记录](validation.md)。

## 额外本地验证

- [Host 验证脚本](../scripts/host-smoke.mjs)：`DSH_TEST_HOST_ROOT` 指向目标 Core 的 `dsh` 目录，ASAR 使用对应 Electron 的 Node 模式。
- [浏览器验证脚本](../scripts/browser-smoke.cjs)：使用既有 Playwright、Chrome 与目标前端资产；RPC 为假数据，HTTP(S) 请求被阻断。
- [同设备浏览器离线验证](../scripts/test-oauth-browser.mjs)：构建后运行，使用真实独立 Chrome 和本地拦截的官方页面/CLI 回调，验证自动关窗；可在宿主 DEBUG/PWDEBUG 开启时核验 Worker 日志隔离。
- [真实登录验收](../scripts/test-oauth-live.mjs)：仅在明确同意真实登录后传 `--confirm-real-login`，用户在独立窗口手动授权；临时保存 CLI 身份和绑定，结束后清理，不安装插件、不调用推理或额度接口。

浏览器脚本环境变量：

```text
DSH_TEST_FRONTEND_ASSETS   目标前端 dist/assets 目录
DSH_TEST_PLAYWRIGHT_ROOT   能解析 playwright-core 的目录
DSH_TEST_SCREENSHOT        截图输出位置
```
