# 更新记录

[返回主页](../README.md)

## 0.1.0 · 开发预览

### 插件

- 分离国内个人 Agent Plan / Coding Plan 两条模型路由。
- 账号元数据与宿主凭据引用管理；两套订阅独立选择账号。
- 官方 ArkCli `volc-sso` 网页登录、账号隔离目录、进度/取消/超时与登录结果核验。
- 官方套餐模型目录拉取，优先使用 `output_name`；目录按账号与订阅隔离。
- IAM AK/SK 与 OAuth 两种额度查询路径；Coding 百分比与 Agent AFP 能力分组。
- 原子路由更新、失败保留旧路由、损坏缓存可诊断与恢复。
- OAuth 推理 Key 短时内存缓存、并发共享与生命周期失效。

### 工程与文档

- GitHub README 主页、真实组件假数据预览、使用及接口文档。
- Node 22.19.0 / 24、Ubuntu / Windows CI 配置。
- 插件包与 SHA-256 artifact；版本标签触发 npm Trusted Publishing 和 GitHub Release。
- 项目与插件界面统一使用 `dsh-volcengine-provider`，采用 MIT 许可。

### 验证边界

已通过隔离测试、实际目标 Core 加载和离线 React/Chrome 交互验证。真实 ArkCli OAuth 首登、在线接口、推理调用与生产安装待验收。具体结果见[验证记录](validation.md)。
