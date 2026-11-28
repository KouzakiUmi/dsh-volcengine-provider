# 验证记录

## ArkCli 跨平台发现与一键安装

- 从 [Ark CLI 官方 npm 包](https://www.npmjs.com/package/@volcengine/ark-cli/v/1.0.70) 核对 `1.0.70` 的六种平台依赖和原生文件命名；逐平台记录官方 tarball 的 SHA-512。真实 Linux ARM64 安装包通过完整性校验，目标文件为 AArch64 ELF，未声明动态解释器。
- Windows x64 在工作区隔离目录下载真实官方包，完成摘要校验、原生 `--version` 自检、原子落位和路径发现；`auth login volc-sso --help` 有 `--no-browser`。没有发起授权或使用真实账号。
- 回归覆盖无 Host PATH 的 npm 子包发现、显式配置优先、不可执行文件跳过、坏摘要与超限拒绝、取消、并发去重和安装后立即重查。离线 Chrome 在 390 px 验证检测缺失、点击安装、取消、重试和登录入口恢复，安装本身不发起登录。
- 尚未在真实 proot、macOS 或 Windows ARM64 宿主上执行安装自检；当前 DSH Profile 未改动。

## Seedream 原生透明图与图层拆分

- 契约来源：[Agent Plan 模型上线公告](https://docs.volcengine.com/docs/ark/agent-plan-personal-model-release?lang=zh)、[Seedream 5.5 教程](https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-5)和[图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)。插件沿用套餐别名与 `/api/plan/v3/images/generations`，不切换到按量地址。
- 静态检查、构建（25 个文件）、Node 480 项和 Python 10 项通过。用模拟方舟响应验证文生与多图生 RGBA、100 张拆分产物、混合格式、原字节保存、富文本 OCR、无效组合拦截及下载超时。实际桌面 Core `0.2.2-rc.5` 在离线夹具中接受输入 Schema、校验拆分结果及 OCR 元数据。
- 用与桌面宿主一致的前端资产运行离线 Chrome 检查：390 px 下图层分页、透明棋盘背景、坐标、OCR 展开、独立下载链接均通过，普通图片大图缩放和 Esc 关闭仍可用。
- 真实 Agent Plan 调用（2026-11-27）：工作区 `volc_imagine`、桌面 Core `0.2.2-rc.5` Schema 与隔离附件库，使用 `doubao-seedream-5.5` 发出两次请求，均为 HTTP 200。文生返回 1024×1024 RGBA PNG，85.41% 像素全透明；拆分自制文字海报返回 1024×1024 JPEG 底图和 1673×627 RGBA PNG 图层（90.94% 像素全透明），含绝对、归一化边界框，OCR 识别出 `SEED TEST` 并返回字样式。三份原始文件的尺寸、格式、字节数和附件 SHA-256 均经本地回读核对。
- 本次未安装到当前 DSH Profile；多参考图生 RGBA 和 100 张拆分上限仍由隔离测试覆盖。

## 0.2.21 设置页按功能分区与倍率徽标

- 标签重构：顶层从「按套餐分」改为「按功能分」（额度 / 模型 / 图片生成 / 账号与登录），每个分区内按套餐渲染可折叠面板；套餐启用与账号选择只在账号与登录分区出现一次。实测窄屏默认高度从重构前的 1112px（单套餐 + 隐藏另一套餐）变为 1281px（两个套餐额度同时可见），即在同一视口里多展示了一个套餐，且去掉了额度分区里的套餐开关与账号选择块。
- 长度取证：`scripts/browser-smoke.cjs` 新增 `DSH_TEST_MEASURE=1` 受控测量（不参与断言），在 390px 窄屏输出展开/收起两种状态的区块高度。重构前记录：默认 1112px，其中额度窗口 656px（59%）；展开模型列表 2193px，模型目录一项 1150px（演示仅 1 个模型，真实 16 个模型时更长）。
- 排序：模型列表内已启用模型排在前面，同组保持目录原序；已启用判定沿用「旧快照缺 `enabled` 视为启用」。
- 倍率徽标：`resolveConsumption` → `rateBadge` → `withRateBadges` 注入 `LlmModelInfo.badge`。用两套真实清单实跑：GLM 5.4 在两套餐均为 `x3.60` tone `info`、剩余 12 天；`glm-5.3` 为 `x4.50` neutral；`ark-code-latest` 无徽标。
- 编程套餐 GLM 5.4：真实 ArkCli 清单（2026-11-26）两套餐都返回 `glm-5-4-261123`；`agent-plan` 上游 `model_id` 为 `glm-5-4-261101`，`coding-plan` 与 `output_name` 相同。两者 `context_window` 1048576、`max_completion_tokens` 131072、`input_modalities` text/image/video、`enabled_thinking: true` 一致。
- 重构缺陷修复：交叉核对发现模型参数草稿被整体替换而非按字段合并，导致同一次编辑里除最后一个字段外的修改全部丢失；已恢复合并语义并补 `effortsMode` 联动逻辑，单测重新覆盖。
- 发布前独立交叉核验（只读代理，快照 HEAD `21ca75f` + 工作区改动）提出 2 阻断 / 3 建议 / 5 提示，已全部处理：
  - **阻断**：图片生成分区的「前往 Agent 套餐」把已废弃的 `agent-plan` 传给导航；四个分区判定条件都不匹配该 id，点击后整页空白且键盘导航失效。现改为跳「账号与登录」，并在 `navigateSettings` 增加分区白名单回落，新增用例点击该按钮验证目标分区与「至少一个分区可见」。
  - **阻断**：折叠面板箭头用 JS 八进制转义写成 `\25BE`，实际渲染成控制字符 U+0015 加字面 `BE`。现直接使用 Unicode `▾`。
  - 建议：`PlanQuotaPanel` 未从 context 取 `disabled`（登录进行中仍可再起登录任务），改为按传入 busy 计算；账号与登录分区双重描边（`vcp-card` 内联样式压过剥离规则），去掉内联卡片样式；changelog 引用了从未发布的 0.2.20，改为 0.2.21。
  - 提示：分区渲染顺序与标签顺序不一致 → 标签改为「额度 / 模型 / 图片生成 / 账号与登录」与 DOM 一致；折叠摘要在额度失败态曾误报「已采集」，改为区分失败/鉴权未就绪；模型参数草稿的字段名笔误（`draftsMode` → `effortsMode`）。
  - 测试补充：套餐启用开关与账号选择的唯一性断言、按内容而非渲染索引定位分区、键盘导航补「最后一个分区之后循环回第一个」、图片生成跳转回归。
- 已执行：`node scripts/check.mjs`（62 源文件）、`node scripts/build.mjs`（24 文件）、`node --test test/*.test.mjs` **469 项通过**；离线 Chrome 验证（假 RPC、HTTP(S) 阻断）：四分区导航与键盘循环、同分区内两个套餐面板同时可见、切走后隐藏不卸载、模型编辑器跨标签保留、390px 窄屏两个额度面板均不溢出、深浅色 × 2 种令牌配置共 4 组 WCAG AA 全过（最低 4.59:1）；截图 `test-output/tabs-021*.png`。
- 未覆盖：未在运行中的 DSH 宿主里重启核对（需安装新版本后生效）；未调用真实方舟推理或额度接口。

### 编程套餐 GLM 5.4 与模型选择器倍率徽标

- 真实账号清单（ArkCli 1.0.64 → 运行中自动升级到 1.0.65，插件隔离身份，2026-11-26）两个套餐都返回 `glm-5-4-261123`：`agent-plan`（tier medium）上游 `model_id` 为 `glm-5-4-261101`，`coding-plan`（tier pro）`model_id` 与 `output_name` 相同；两者的 `context_window` 1048576、`max_input_tokens`/`max_completion_tokens` 131072、`input_modalities` text/image/video、`enabled_thinking: true` 完全一致。0.2.19 发布时 coding-plan 尚未返回该模型，本次按新清单补齐。
- 倍率徽标链路：`resolveConsumption(plan, id)` → `rateBadge()` → `withRateBadges()` 注入 `LlmModelInfo.badge`。用两套真实清单实跑归一后的模型行：GLM 5.4 在两套餐均为 `x3.60` tone `info`、剩余 12 天；`glm-5.3` 为 `x4.50` neutral；`kimi-k2-8-preview` `x4.80`、`deepseek-v4-1-flash` `x1.25` 等既有折扣模型按时间窗生效；`ark-code-latest` 无徽标（动态路由不伪造倍率）。
- Core 契约核对（本机 `app.asar` 内 `@deepseek-ai/dsh-llm@0.2.2-rc.5`）：`LlmModelBadge = { text: LocalizedText（en 必填）, tone: neutral|info|success|warning }`，注释写明 badge 只由 `listModels()` 的目录发现携带、exact-route resolution 省略；`index.ts` 的 `normalizeModelInfo` 会复制 `badge`。因此徽标必须在适配器外面补，且 `resolveModel` 不得返回它——两点各有测试锁定。
- 已执行：`node scripts/check.mjs`（62 源文件）、`node scripts/build.mjs`（24 文件）、`node --test test/*.test.mjs` **468 项通过**（新增倍率契约 6 项、徽标注入与不覆盖 2 项、`resolveModel` 不含徽标 1 项）。
- 未覆盖：未在运行中的 DSH 宿主里确认选择器实际渲染效果（需要重启加载新 bundle 后目视核对）；未调用真实方舟推理；未验证活动结束后徽标自动回常规价的实际刷新时机（依赖 Core 的目录刷新节奏，本地只用注入时间戳的单测覆盖）。

## 0.2.19 新增 GLM 5.4（Agent Plan）

- 真实账号清单（ArkCli 1.0.64，插件隔离身份 `agent-plan_cn-beijing_personal` / tier medium，2026-11-24）返回 `model_id` `glm-5-4-261101`、`output_name` `glm-5-4-261123`、`context_window` 1048576、`max_input_tokens`/`max_completion_tokens` 131072、`input_modalities` `text`/`image`/`video`、`enabled_thinking: true`。同账号 `coding-plan_cn-beijing_personal`（tier pro）清单只有 `glm-5-3-flash`、`glm-5.3`，未返回 GLM 5.4。
- 一手来源核对：[Agent Plan Pi 接入](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-pi.md)已列 `glm-5.4`（`input` `text`/`image`，上下文 1024000 与输出 128000 为文案值，不采用）；[Coding Plan Pi 接入](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md)与 Coding 模型名列表未列该模型，`glm-latest` 仍指向 `glm-5.3`；[套餐概览](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview.md)支持模型表尚未更新；[智谱 GLM-5.4](https://docs.bigmodel.cn/cn/guide/models/glm-5.4.md)声明 1M 上下文、128K 输出、输入含视频/图像/文本/文件；官方 Plan 目录 `dsh-volcengine-plugin@0.8.5` 的 `plan-models.json` 与 0.8.4 同一 SHA-256（`9d921b7a…`），未收录该模型，故容量取真实清单注册值。
- 倍率来源：[AFP 抵扣规则](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-afp-credits-billing-rules)列 `glm-5.4` 为 3.6 限时、原 4.5；[限时折扣活动](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-model-discount)给出窗口 2026-11-23 00:00:00 至 2026-12-07 23:59:59（8 折）。
- 思考档位未获专属声明：火山[深度思考](https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md)表未列 `glm-5-4-*`，智谱[深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)只声明 `reasoning_effort` 从 GLM-5.2 起支持、5.3 系列仅 low/high/max。快照因此把三档标为推导并记为 `partial`，默认档位继承服务端，不提供关闭入口。
- 容量字段落差留档：真实清单 `max_input_tokens` 也是 131072，与 `context_window` 1048576 相差 8 倍；快照只有 `contextWindow`/`maxTokens` 承载字段（与既有 GLM 5.3、Kimi 条目同一约定），因此 Core 按 1M 上下文装配时可能发出服务端会拒绝的长输入。该行为是既有约定，不是本次新引入；若实测确认 `max_input_tokens` 是硬上限，需要新增承载字段并在装配层收敛。
- 已执行：`node scripts/check.mjs`（59 源文件）、`node scripts/build.mjs`（23 文件）、`node --test test/*.test.mjs` **459 项通过**、`python -m unittest discover -s test -p 'test_*.py'` 10 项通过。
- 未覆盖：未对 `glm-5-4-261123` 发起真实推理或 Messages 请求，档位、服务端默认与 `max_input_tokens` 是否硬性拒绝都未实测；未验证 Coding Plan 其他 tier 是否已上架该模型。

## 0.2.19 会话图片引用自动补全（与 GLM 5.4 同版发布）

- 根因（静态核对本机桌面宿主 Core `0.2.2-rc.5` 源码，`app.asar` 内 `@deepseek-ai/dsh-llm-pi-ai/src/context.ts`）：pi-ai 适配器为每个图片块插入 `requestImageHandleText` 文本，形如 `Image "name" (sha256:…) ; request preview WxHpx.`，只含内容 ID；`@deepseek-ai/dsh-attachment` 的 `readImage` 要求完整 `ImageAttachmentRef`（`mediaType` / `bytes` / `width` / `height`）并逐项校验。旧 `parseAttachmentSpec` 只接受裸 ID、`attachmentId=`、`attachment={}`，且裸 ID 无完整引用时无法读取附件，因此"模型看得到 sha256 也用不了图"。
- 改动：新增 `src/attachment-index.mjs`（请求装配后扫描 messages 图片块、内容寻址去重、按会话记录最近一张、全局 512 / 每会话 64 / 最多 32 会话上限、卸载清空）；`src/media.mjs` 支持 handle 原文与短摘要、`session-latest`、注入式附件解析与去重；`src/media-image.mjs` 补全会话引用参数、输出可复制的完整 `attachment={…}`；`src/index.mjs` 在 `ManagedAdapter.stream` / 已准备请求的 `stream` 前登记图片，并在 `resolveImageAccess` 兜底登记。
- 发布前独立交叉核验（只读代理 `raccoon/sn-deepseek-v4-1-flash-1017`，快照 HEAD `e514e9c` + 工作区改动）提出 9 项，已按影响修复：
  - **阻断级**：`latest()` 在会话标识缺失时回退"全局最近一张"，可能把别的会话的图当成用户刚给的那张；附件服务只校验内容哈希，不会发现选错 ID，属静默取错内容。现改为严格限本会话，缺会话标识或本会话无图时明确报错。
  - 结果文本的"原样传回 `attachment=`"说明同时覆盖了"Original 文件附件"行，模型照抄必然失败且错误文案与事实不符。现标明原文件行是文件附件、不能作为 `image` 参考图，说明只针对"会话图片"行。
  - 附件对象被清理/损坏时直接抛英文存储错误。现转成区分"已清理"与"校验失败"的中文提示。
  - `session`/`latest` 之外的 `auto` 别名会占用同名本地文件、且与方舟控制台路由名混淆，已移除该别名。
  - 索引会话表原本无上限、全局淘汰后残留悬空 id，现加会话数上限并在淘汰时同步剔除。
  - 错误文案原称"本会话可见历史"但 `resolve` 实为内容寻址全局查找，已改为"本次会话图片索引"以与实现一致（完整 sha256 是精确引用，允许跨会话）。
- 已执行：`node scripts/check.mjs`（59 源文件语法与导入闭包）、`node scripts/build.mjs`（23 文件）、`node --test test/*.test.mjs` **459 项通过**（含新增会话隔离、文件附件拒绝、存储错误提示、会话上限用例）。
- 未覆盖：未在运行中的 DSH 宿主里重启验证（本机 profile 安装的是 npm 发布的 0.2.17，工作区改动需重新构建并安装后生效）；未调用真实方舟生图 / 图生图接口，未验证真实上传图片的端到端编辑。
- 宿主降级预期：peer 范围仍含 `0.2.1-rc.4`。若该版本不在 `GenerateOptions` 传 `sessionId`，索引只进全局表，`session-latest` 会明确报错（功能不可用，但不会取错图），完整 sha256 与本地路径不受影响；本机只在 `0.2.2-rc.5` 上核过 `sessionId` 传递链路。

## 0.2.17 设置页按套餐分区与图片生成单开关（历史记录，分区方案已被 0.2.21 的功能分区取代）

- 设置页四分区改为「Agent 套餐 / 编程套餐 / 账号与登录 / 图片生成」，每套餐一张卡片完整承载启用、账号、额度窗口、模型目录与技术细节；模型列表与高级信息默认折叠。`.vcp-tabs` 固定 `overflow-y:hidden` 并横向可滚，消除标签条多余滚动条。
- 图片生成由「风险确认 + 工具开关」两道门合并为单个「启用图片生成」开关，一次 `setMedia` 同时写入 `riskAcknowledged` 与 `imageTool`（后端既有合并语义，未改）；计费说明保留在卡片内。
- 已执行：`node scripts/check.mjs`、`node scripts/build.mjs`（22 文件）、`node --test test/*.test.mjs` **433 项通过**、`python -m unittest discover -s test -p 'test_*.py'` **10 项通过**。
- 真实 React/Chrome 离线验证通过（前端资产自本机 `app.asar` 的 `dsh-web-frontend` 提取，假 RPC、HTTP(S) 阻断）：四标签导航与键盘操作、隐藏分区不卸载、模型列表默认折叠可展开、单一「启用图片生成」开关 check→uncheck→check 各产生一次 `setMedia` 双字段、390px 窄面板无横向溢出且四标签容纳、768px 双套餐逐一切换、深浅色 × 两种 secondary 令牌配置共 4 组 WCAG AA 全过（最低 text 4.67:1 / control 5.17:1）；截图 `test-output/client-preview*.png`。
- 未覆盖：真实 Ark 生图调用、真实生产 DSH 页面、真实读屏器。

## 0.2.17 图片渲染壳与设置页四分区（分区方案已被上方「按套餐分区」取代）

- 设置页改为「概览与额度 / 模型目录 / 账号与登录 / 图片生成」四标签；工作区隐藏不卸载，模型编辑器、账号表单与登录状态跨标签保留；空账号自动进入账号与登录。标签支持方向键/Home/End，`aria-controls` 指向同一个持久 tabpanel，跨分区跳转在渲染后滚动并聚焦目标。
- 图片卡片在 `tool.call.toolview` 注册 `volc_imagine`：生成中/失败/空结果、原图画廊、大图缩放、下载、复制提示词、原图 `onError` 重试、损坏原图回退预览、旧 `owner.loadImage` / `sessions.readAttachment` 兼容与 Blob URL 回收。
- 原图与预览分离：`saveFile` 逐字节保存原始 PNG/JPEG，`saveImage` 另存宿主规范化视觉输入；下载字节 sniff 与 `output_format` 不一致时失败。原图回源路由校验回环/同源、附件参数与流出长度，成功响应使用私有缓存，错误响应不缓存。
- 独立 UI/UX 审查（Claude Sonnet 5.5 / high）发现的原图失败态、跨标签焦点/滚动、`aria-controls`、焦点环、原图/预览标识与术语问题已修复并补回归；审查未操作生产 GUI。
- 已执行：`node scripts/check.mjs`、`node scripts/build.mjs`、`node --test test/*.test.mjs` **433 项通过**；`python -m unittest discover -s test -p 'test_*.py'` **10 项通过**；`python scripts/pack.py --output-dir test-output/media-tabs-package` 与 `verify-package.py` 通过（48 文件，SHA256 `a1360247b9030af240eefd75d2a5e35b7200a9f6131286673ed6d888ec4d1d1d`）。
- 当前宿主 Core 隔离 Host smoke 通过：真实 Core schema、RPC registry、隔离凭据、双模型目录、选择与 dispose，无网络。宿主脚本中 Economy 上下文断言按当前快照由 1024000 修正为 1048576。
- 真实 React/Chrome 离线验证通过：四标签导航、账号/套餐/模型操作、额度分组与倒计时、图片模型选择、原图回源、原生下载、大图缩放/Escape、390px 无横向溢出、深浅色与两种 secondary 令牌配置对比度均通过；截图 `test-output/client-with-tabs.png`、`test-output/client-media-preview.png`。
- 未覆盖：真实 Ark 生图调用、真实生产 DSH 页面、真实读屏器；全局 ArkCli 当前认证失效，本轮未重登或修改其凭据。

## 0.2.17 设置页紧凑化适配受限容器

- 背景：宿主设置对话框是严格限制大小的小容器（实测内容列约 360px、固定高度滚动）；插件原尺寸层级（32px 控件、18px 主标题、18px 卡片内边距、16px 间距）与该容器密度不匹配。
- 改动：整体紧凑化——控件 minHeight 26px、主标题 15px、卡片标题 13px、卡片内边距 12px、区块间距 10px、开关 30×18、圆角收敛；额度主数字 18px、状态条 6px、状态色与对比度保持不变。
- 已执行：436 项单元测试通过（含按新尺寸更新的样式快照断言）；真实 React/Chrome 离线验证改用 360×440 受限容器：无横向溢出、按钮 28px / 下拉 27px / 主标题 15px，深浅色截图无 pageerror（`test-output/compact-*.png`）。
- 安装：desktop profile 0.2.16 → 0.2.17（`file:` 本次 tarball，SHA256 41a78cb3…），dependency spec / lockfile / 安装 manifest 与 bundle 四项一致；运行中宿主仍加载旧 bundle，真实 GUI 生效待重启后核验。

## 0.2.17 登录态到期提醒与官方时限说明

- 根因诊断（真实本机，ArkCli 1.0.48）：官方 SSO cross-device refresh_token 为 JWT，`exp - iat` 恰为 48 小时，续期不轮换、不延长；到期后服务端拒绝续期（`invalid_request - The request parameter refresh_token is invalid`），CLI 要求重新登录。STS / ID token 有效期 15 分钟，有效期内 CLI 自动续期（凭据文件时间戳与一次成功续期落盘证实）。诊断只读取令牌的时间 claim 与文件时间戳，未输出凭据内容。
- Host：新增 `src/oauth-expiry.mjs`，只解读 refresh_token 的 exp claim、从隔离身份目录读取到期；`read` 按 OAuth 绑定下发 `oauthExpiresAt`（ISO 字符串或 null），按绑定缓存，重新登录 / 凭据变化 / 卸载时失效。凭据引用账号不带该字段。
- Client：账号卡片正常 / 临期（剩余 ≤2 小时）/ 到期三态提醒；登录确认与等待授权码界面增加 48 小时登录态、10 分钟授权码时限说明；到期未知不显示文字。
- 已执行：`node scripts/check.mjs`、`node scripts/build.mjs`、`node --test test/*.test.mjs` 436 项通过（含新增到期模块 7 项、manager 集成 2 项、client 提醒 5 项）；`python -m unittest discover -s test -p 'test_*.py'` 10 项通过。
- 真实 React/Chrome 离线验证（桌面 0.2.1-rc.4 前端资产自 app.asar 提取，假 RPC、HTTP(S) 阻断）：OAuth 账号三态文本 / 字重 / role 断言通过，到期未知不显示，登录确认时限说明可见，深浅色截图无 pageerror；截图在 `test-output/expiry-*.png`（临时目录，不进归档）。
- 未覆盖：真实授权码端到端登录仍未验收；48 小时为当前官方服务实测值（ArkCli 1.0.48），不是长期契约，界面文案以实测值为据。
- 既有问题（与本次改动无关，未修复）：工作区 `scripts/browser-smoke.cjs` 登录段仍用旧浏览器桥按钮文案（「确认并打开官方登录页」），与两段式 UI 不同步；账号区展开状态在套餐启停触发的重渲染后丢失（移除本次新增行的基线对照复现相同）。

## 0.2.17 媒体生成（已被图片渲染壳与四分区记录取代）

- 本节早期草稿曾包含视频任务与视频路由；当前版本已移除视频工具、任务存储和路由，仅保留 `volc_imagine`。实际覆盖与未验收范围以顶部「图片渲染壳与设置页四分区」为准。

## 目标与范围

- 已核验宿主有两个：桌面 **DSH Core 0.2.1-rc.4**（`DSH NEXT` 的 Core / llm / llm-pi-ai / credentials / launch-environment / typert-protocol manifest，pi-ai `1.1.0`）与手机版 **the agent harness 0.2.2-rc.1**（Node 24.22.1，pi-ai `1.5.0`）。五个 Core 包的 Peer 声明为 `>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`，pi-ai 为 `>=1.1.0 <2.0.0`；范围内其他版本未逐一验证。并集范围使 npm 默认 semver 与宿主 `includePrerelease` 判定同时匹配两个已核验的预发行宿主。
- ArkCli **1.0.37** 的命令帮助、随包官方 Skills、raw action 注册及无网络预览。
- 单元业务测试使用假凭据、假 CLI 与外部网络替身；两段式 Phase 1/接力/Phase 2 解析已用真实 ArkCli 1.0.37 核验，真实授权码端到端登录未验收，边界见 0.2.14 段。

## 0.2.14 Phase 1 命令与构建闭包修复

- 修复 Phase 1 命令为 `arkcli auth login volc-sso --no-browser`：真实 ArkCli 1.0.37（Windows，非 TTY）实测该形态打印跨设备登录 URL、把 PKCE session 落盘 `.arkcli/.sso-pending.json` 后以退出码 0 结束，输出 JSON 含 `authorize_url`/`next_command`/`stage: authorize_pending`，授权码 600 秒有效。0.2.13 使用的 `auth login --no-browser` 在同一隔离环境实测打印 `callbackPort` URL 后不退出、持续等待本地回调——此行为与官方随包文档「非 TTY 即 Phase 1」的说法冲突，以实测观察为准。
- CLI 错误分支以退出码 0 返回 `{"ok":false}`（1.0.37 实测），`oauth.mjs` 的 `command()` 现在要求退出码 0 且输出不含 `"ok":false` 才判成功；Phase 2 用官方 `next_command` 形态 `auth login --no-browser --code <授权码> --credential-store encrypted-file`，实测能从 pending session 解析并做授权码内容校验。
- 授权码取出后立即清除内存副本，不再依赖 Phase 2 结果；白名单提取用官方 `authorize_url` JSON 形态补充回归用例。
- 构建改为先清空 `lib/` 再复制 `src/` 全部 `.mjs`/`.json`（不再维护硬编码清单），修复 0.2.13 漏发 `login-url.mjs` 导致已发布 tarball 中 `lib/oauth.mjs` 导入失败的问题（npm 0.2.13 tarball 的 lib/ 确实缺该文件，已核实）。`check.mjs` 新增 `src/` 相对导入闭包校验；`verify-package.py` 新增归档内 `lib/*.mjs` 相对导入可解析校验，可拦截同类漏发。
- 真实授权码端到端登录仍未验收：以上真机核验覆盖 Phase 1 输出/退出、session 接力与 Phase 2 pending 解析及错误形态，未执行真实 SSO 完成的完整登录。真实额度、推理调用、生产安装与跨平台真实 CLI 行为仍未验收。

## 0.2.13 无浏览器两段式登录

- 网页登录从「官方 ArkCli broker 同设备流程 + 私有 PATH 启动桥（Windows `rundll32.exe`）+ Playwright 独立 Chrome + 127.0.0.1 IPC」改为官方 CLI `arkcli auth login --no-browser --credential-store encrypted-file` 两段式：Phase 1 由 CLI 打印官方登录 URL，插件校验官方主机/路径白名单后把链接展示在设置页，用户在任意设备浏览器完成 SSO 并取得 base64 授权码；Phase 2 用户在设置页粘贴授权码，插件调用 `arkcli auth login --no-browser --code <授权码> --credential-store encrypted-file`，由官方 CLI 完成 PKCE 交换与凭据落盘。
- 插件不处理 token 端点、不读取网页或授权码内容（授权码只在内存传给 CLI 子进程 argv，不落盘、不进 UI 状态、不进日志）、不启动浏览器、不拦截系统 URL opener；不再打包 Windows 原生桥二进制、不再依赖 `playwright-core`。CI 不再产出 Windows 桥 artifact，归档校验不再要求桥文件。
- 安全边界改写为只放行官方 CLI 输出的白名单官方链接 + 两段式流程；不再限定「仅已核验的 Windows ArkCli 1.0.37」，也不再写「不回退 cross-device 授权码流程」。身份核验（whoami / auth status / 双套餐 profile）、账号隔离目录、原子绑定、取消/超时/写入保护、白名单身份摘要、OAuth 账号走 CLI raw action 查额度（不需要 AK/SK）全部保留。
- 实测范围：本机 Core smoke（隔离 Host 加载、RPC、双路由、目录、路由失败保留、dispose，HTTP 由本地替身响应）与离线单测（假 CLI、假凭据、外部网络替身）覆盖两段式的链接白名单校验、授权码只经 argv 传递、不落盘/不入日志、取消/超时/写入保护等非浏览器路径；具体测试数量见「当前结果」。
- 未验收边界：发布时本机没有安装 ArkCli，`--no-browser` 两段式未做真机验收；后续实测发现该版本 Phase 1 命令在同设备回调流程下不退出导致登录卡住，已在 0.2.14 修复。

## 0.2.12 本机 Core 版本适配

- 现场取证：手机版 the agent harness 的内置运行时为 `r15-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5`（App 1.0.11 诊断快照），`/opt/dsh` 的 `@deepseek-ai/dsh`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-credentials`、`dsh-launch-environment`、`dsh-typert-protocol` manifest 均为 `0.2.2-rc.1`，`@earendil-works/pi-ai` 为 `1.5.0`，cordis `4.1.0`、schemastery `3.19.0`。本机 profile 的插件目录为指向工作区的链接，版本 `0.2.11`。
- 宿主兼容判定（`@deepseek-ai/dsh-app-boot`）用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 检查 `@deepseek-ai/dsh*` peer；该模式下 `>=0.2.1-rc.4 <0.3.0` 已匹配 `0.2.2-rc.1`。但 npm 默认 semver 不含预发行同元组例外，实测 `0.2.2-rc.1` 不匹配该范围，`pi-ai 1.1.0` 也不匹配本机 `1.5.0`；从 registry 安装时会成为依赖解析阻碍。
- 声明改为并集 `>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`（五个 Core 包）与 `>=1.1.0 <2.0.0`（pi-ai）。实测在 npm 默认 semver 与宿主 `includePrerelease` 两种判定下，`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.1`、`0.2.2-rc.1`、`0.2.2`、`0.2.9` 均匹配，`0.3.0` 不匹配；`1.1.0`、`1.5.0` 匹配 pi-ai 范围，`2.0.0` 不匹配。未设置 `engines.dsh`：宿主一旦读到该字段会改为只判定它、忽略 peer。未来新的 `0.2.x-rc.N` 预发行号仍需按 semver 同元组规则重新核对。
- 运行时代码未改。以 `DSH_TEST_HOST_ROOT=/opt/dsh` 加载本机真实 Core/SDK 复核：`scripts/host-smoke.mjs`（隔离 Host 加载、RPC、双路由、目录、路由失败保留、dispose）、`scripts/model-thinking-smoke.mjs`（两套餐 192 项真实 Core/SDK 请求断言）、`scripts/model-management-smoke.mjs`（状态迁移、开关、覆盖优先级、已准备请求隔离）与 `scripts/model-capabilities-smoke.mjs`（图片元数据、工具选择、隔离）全部通过；HTTP 全部由本地替身响应，未调用真实推理或额度接口。
- `scripts/host-smoke.mjs` 中 `deepseek-v4-1-flash-economy-261017` 的上下文断言由 `1049000` 同步为快照现值 `1024000`；该差异来自 0.2.10 快照刷新后的旧脚本硬编码，与本机 Core 无关。
- 新增 `test/manifest-compat.test.mjs`，锁定五个 Core peer、pi-ai 声明、版本号与两种 semver 判定下的匹配回归。

## 0.2.11 Core 版本声明修正

- 现场取证：桌面 `DSH NEXT` 的 `app.asar` 内 `@deepseek-ai/dsh-llm`、`dsh-llm-pi-ai`、`dsh-credentials`、`dsh-launch-environment`、`dsh-typert-protocol` 的 manifest 版本均为 `0.2.1-rc.4`，`@earendil-works/pi-ai` 为 `1.1.0`；PATH 上没有其他 `dsh` 安装，`~/.dsh` 下也没有第二份 Core。此前声明只写 `0.2.1-rc.5`，与本机宿主不一致。
- 声明改为 `>=0.2.1-rc.4 <0.3.0`（五个 Core 包），以实际核验的 rc.4 为下限，同系列后续版本仍在范围内；未逐一验证该范围内的其他版本。按 semver 默认规则，该范围匹配 `0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.1` 及后续 `0.2.x` 稳定版；其他预发行号（如 `0.2.2-rc.1`）不在默认匹配内，若宿主升级到此类版本需要重新核对声明。宿主 rc.4 中核到插件使用的 `resolveRetryPolicy`、`resolveImageAttachmentAccess`、`registerAdapter`、`providerRetryPolicy` 等符号存在（字符串级核对，非类型级验证）。
- `node scripts/check.mjs` 与 `node --test test/*.test.mjs` 全部通过（368 项），`lib/` 重建；本次只改声明与文档，未改运行时代码。

## 0.2.10 控制台路由可用性与上游参数刷新

- 使用已绑定的真实方舟账号（隔离 CLI home，`auth whoami` 返回 `logged_in=true`、身份为既有账号）执行 `arkcli plans model-list`：Agent 与 Coding 两套套餐各返回 16 条，集合与本地缓存一致，`selected_model_id` 为 `auto`。上游没有新增或移除模型。
- 真实调用探针（Anthropic Messages 路径）：`model=auto` 在 `/api/plan/v1/messages` 与 `/api/coding/v1/messages` 均返回 `404 UnsupportedModel`；同一路径下 `doubao-seed-2-1-pro-260915`（Agent）、`doubao-seed-2-1-pro`（Coding）与 `ark-code-latest`（两套）均返回 200，其中 `ark-code-latest` 的响应 `model` 为 `auto`。请求只发一条 `max_tokens=8` 的最小消息，未读取或输出凭据。
- 官方资料复核：[Coding Plan Pi](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-pi.md) 明确 Model Name 不支持配置为 `Auto`、需通过控制台切换；[Agent 套餐概览](https://www.volcengine.com/docs/82379/2366394)与[Coding 套餐概览](https://www.volcengine.com/docs/82379/1925114)（最近更新 2026-10-29）给出 Kimi K3.1 Pro 1024k 上下文/1024k 输出、Economy 1024k 上下文，并把 `minimax-m3`、`kimi-k2.7-code` 标注为即将下线。
- 本地实现按上述证据把清单里的 `auto` 归一为可用的 `ark-code-latest`，展示名称保留“Auto（智能调度）”；旧缓存与旧设置键只读继续生效。开关与参数保存以当前生效设置为基线，恢复默认同时清除历史键；显式最大输出高于新上下文时保留原设置、收敛有效调用并提示。`node --test test/*.test.mjs` 共 368 项全部通过，含归一、旧缓存、旧设置键读写与超界收敛用例；`lib/` 已按源码重建。
- 未覆盖：没有对每个模型重放真实推理，也没有重跑真实浏览器截图（模型卡片文案变化由离线 React 测试覆盖）；`test/test_verify_package.py` 本轮无法执行，原因是 `.dsh` 目录与解释器带 Low 完整性标签，而用户 TEMP 为默认 Medium，Low 进程无法向上写入（`icacls /L` 已取证），与本次改动无关。

## 0.2.9 Core 适配、设置页与消耗倍率

- 从桌面 `app.asar` 的产品与各包 manifest 核对实际 Core / llm / llm-pi-ai / credentials / launch-environment / typert-protocol 版本，其消费的 pi-ai 为 `1.1.0`；插件 peer 声明与该版本对齐，没有改写宿主安装。当前复核（2026-11-03）读到的宿主版本为 `0.2.1-rc.4`，本条原记的 `0.2.1-rc.5` 已无法在本机复现，版本口径以 0.2.11 段为准。
- 真实目标 Core 隔离 Host 加载通过，覆盖 Core Schema、RPC、双路由、模型目录、路由失败保留和 dispose；模型管理、逐模型思考与能力矩阵使用同一真实 Core/SDK 和假 HTTP，未调用真实推理。
- 设置页参考 Our Free Model 2.7.1 的卡片与标签信息层级，保留本插件原有账号、双套餐、额度、模型参数和异步保护。真实 React/Chrome 离线验证名称旁倍率、限时标记、能力标签、模型开关与参数、额度分组、登录路径、390px 窄屏和窄内容栏；HTTP(S) 全部阻断，RPC 为假数据。
- 深浅色 ×（宿主实色 secondary 令牌 / 缺失令牌）四组对比度审计均通过 WCAG AA。首次审计发现按钮/开关主题过渡中间色与折扣小字对比不足，已去除相关颜色过渡并修正文字透明度后复验通过。
- 倍率依据[官方 AFP 抵扣规则](https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-afp-credits-billing-rules)与[共享折扣活动](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-model-discount)固化，逐模型来源和 Kimi K3 活动结束冲突见[能力参数](model-capabilities.md#消耗倍率)。测试覆盖两套套餐别名、活动开始前/截止/结束后、未知与动态路由无倍率，以及倍率元数据不进入 Core 配置；Coding 仅作相对消耗参考，未实测线上计费。

## 0.2.8 模型能力覆盖

- 对照两套 Plan 的 Pi 文档、套餐概览、官方插件目录及目标 Core/SDK 契约复核模型参数与输入模态；官方音视频能力与当前文本/图片传输边界、思考字段的资料冲突分别见[能力参数](model-capabilities.md)和[思考参数审计](model-thinking-audit.md)。未进行真实账号推理。
- 使用真实目标 Core 和 SDK、假凭据与离线 HTTP 替身验证两套餐的图片能力声明、工具调用选择及已准备请求隔离；服务端违规返回工具调用时的拦截由隔离测试验证。
- 尚未实测方舟服务端对工具禁用请求或图片输入的接受情况，也未以真实网络回放服务端违约工具事件。旧版回退结果依据源码分析，未进行端到端回退测试。
- 使用 React/Chrome 离线验证复选框勾选、分别恢复继承、未知默认的未定态以及 390px 窄屏与深浅色；RPC 为假数据。

## 0.2.7 设置页额度展示调整

- 使用真实 React/Chrome 与假 RPC 数据离线验证账号、模型操作、额度分组及实时倒计时；覆盖深浅色、390px 视口、768px 视口及宽窗口中的 390px 内容栏。
- 对比度检查覆盖深浅色与两种主题令牌配置；补充每套餐独立时钟、重置时间变化后清理旧时钟和到期状态测试。未在运行中的 DSH 页面或真实额度接口复验。

## 0.2.6 紧凑设置页与额度倒计时

- 账号管理默认收起，双套餐随可用宽度并列或堆叠；真实 React/Chrome 离线测试覆盖交互、深浅色、390px 和额度分组，使用假 RPC 数据。
- 倒计时使用接口返回的有效重置时间；缺失、无效和到期均有明确状态。隔离测试覆盖计时、卸载清理、分组及重置时间跨层传递，未验证真实账号的在线额度响应。

## 0.2.5 逐模型思考参数与请求适配

- 逐项来源、独立档位、默认及关闭规则见[模型思考审计](model-thinking-audit.md)。已公开能力与尚未公开的默认/关闭控制分别记录。
- 真实 Core 的公开 PiAiAdapter 与 SDK 请求钩子完成两套餐 **192 项离线请求矩阵检查**：逐模型声明默认、独立档、enabled/adaptive 模式、显式关闭、未强制和 Auto。全部 HTTP 使用假响应。
- 验证原始覆盖保留、旧预算继承兼容、常驻思考关闭限制、跨模型/并发隔离、旧 prepared call 与凭据绑定固定、取消和错误脱敏。
- 真实 React/Chrome 离线复验深浅色、390px、参数操作与状态分类；新版模型预览见[思考参数预览](client-model-thinking-preview.png)。

## 0.2.4 模型快照与界面重构

- 参数按[固化能力来源](model-capabilities.md)逐字段核对，优先对应 Plan Pi 明确整数；补齐当前 15 个固定模型族与账号选择路由配置，并保留冲突/思考控制的证据边界，不把其他 Provider 原厂上限直接覆盖 Plan。
- 显式别名覆盖控制面 ID、Plan 调用 ID 与文档名称；未知版本不去日期猜测。真实已有目录样本只读回放：Agent 原有 8 个、Coding 原有 7 个 32K 回退项均缩减为仅 `auto`，各 15 个固定模型采用固化默认值；原始状态文件逐字节未变。
- 回归覆盖旧缓存内存合并、友好显示名、原 ID 操作键、用户覆盖优先、默认输出不超过有效上下文、别名进入 Core 前剥离；旧 GLM medium 默认保留原值、有提示地降为不强制，真实 Core resolve/prepare 均通过。实际 Core 隔离 Host 再次通过，验证 16 配置/套餐及 Economy 的 `1049000`/`393216`；模型管理和请求优先级脚本通过，全部 HTTP 使用替身。
- 设置页保留全部原 RPC/并发保护，参考 Antigravity ACP 0.1.29 与 OpenDesign CoRouter 0.1.4 的公开客户端：编号分区、DSW 令牌、卡片/控件、技术信息折叠、紧凑成功状态、主次按钮。没有复制对方业务逻辑。
- 真实 Core 的 listModels 返回友好名称；真实 React 模型目录验证“豆包 Seed 2.1 Pro”“Kimi K3.1 Pro”“DeepSeek V4.1 Flash”及折叠调用 ID，见[模型名称预览](client-model-names-preview.png)。
- 新增布局、样式所有权、重叠实例卸载和紧凑状态回归；保留旧 Host 安全授权链接、登录确认/取消、未知启动保护、身份/额度迟到隔离等既有覆盖。真实 React/Chrome 离线复验深浅色、390px、模型参数、原生折叠及控件实际尺寸。
- 能力边界来自对应来源资料；真实服务端容量上限和 Plan 思考控制效果尚需单独的推理验证。

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

当前结果：**358 项 JavaScript 测试、10 项 Python 归档测试通过**，43 个 JavaScript 源文件语法/边界检查通过，构建包含 16 个模块/Client 产物，归档不再包含浏览器桥文件。模型管理测试覆盖旧状态迁移、套餐/模型开关、逐模型参数、请求默认值及适配器生命周期；发布测试覆盖 OIDC 身份、版本与渠道、归档校验（含 `catalog-snapshot.json` 与 `consumption-rates.json` 必需项）、registry 错误分类及发布后完整性检查。

### 实际 Core 隔离加载

[Host 验证脚本](../scripts/host-smoke.mjs) 通过：

- 真实 Core 导入、Config Schema、Typert RPC 注册。
- 先加载既有原生 llm-pi-ai，再加载本插件，验证共存。
- 独立账号凭据服务桥接、两个路由各 16 个固化模型配置；缺凭据时不显示为可用模型。
- 模型上下文和输出规格解析；单独停用 Coding 路由不影响 Agent。
- dispose 后清除本插件服务与两个适配器，既有 Core 不被修改。

通过公开 PiAiAdapter 和模型级 Provider 钩子复用 Core 传输；路由代际先构造校验，再经稳定代理和公开 registration handle 原子替换。凭据解析固定到该代际的账号及绑定，通用 pi-ai 设置与模型发现仍由宿主实例负责。真实 Core 已验证损坏缓存时保留旧路由及恢复路径，已准备调用继续使用原配置与凭据上下文。

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
- 已检查重构后的[桌面浅色预览](client-settings-preview.png)、[桌面深色预览](client-settings-preview-dark.png)、[390px 深色窄屏预览](client-settings-preview-mobile-dark.png)与[空账号入口](client-settings-preview-empty.png)。主题使用受控 DSW 令牌；390px 无横向溢出、账号选择框高度小于 64px、卡片移动端 padding 为 12px、原生 details 可正常开合。不是生产 DSH 页面截图，账号和额度均为假数据。
- 模拟网页登录从等待到成功，验证官方用户名自动更新至账号区与套餐卡片、旧额度清空、重新查询归属新身份；进度条与文案统一表达剩余额度。

## 身份与交互修复验证（2026-10-26）

- 根因：旧实现只检查 `whoami.logged_in`，没有保存或返回官方身份，客户端只展示本地 label。现保存白名单身份摘要，保留本地备注，并兼容只读恢复旧绑定的身份。
- 隔离测试覆盖独立登录目录、失败登录保留旧绑定、旧请求仍读取旧目录、身份持久化不夹带完整响应、OAuth 未绑定套餐拒绝 profile 回退。
- 覆盖登录已提交而路由失败的独立状态、外部实例变更后的刷新与路由更新、独立 Store 冲突保护、强制额度刷新失败后不复用旧成功缓存、凭据服务异常不拖垮设置页。
- 实际 Core Host 与模型管理脚本再次通过；失败切换时已断言所选账号与实际生效账号不同，保留路由后可恢复。模型请求仍全部使用假 HTTP。
- Client 替身按 React 依赖语义执行 effect；真实 React/Chrome 离线测试覆盖登录结果刷新、套餐与模型操作、额度重查及窄屏布局。不是对所有异步交错或真实 OAuth 的穷尽验证。
- Context7 文档查询因额度限制不可用；身份契约以本机 `@volcengine/ark-cli 1.0.37` 随包官方 whoami 文档核验。

## 完整操作路径回归

- 空账号直接网页登录：确认前不写入；确认后自动创建账号并使用新 revision 启动 OAuth；取消确认不留下账号。
- 已有账号登录其他身份不覆盖原账号或套餐选择；登录后显式选择并启用指定套餐，不改变另一套餐。
- 启动冲突后同步 revision；启动响应丢失后读回正在运行的任务；启动及补读同时断网时保留结果未知保护态并退避同步，分别验证 Host 已启动和未启动两种恢复结果；进度查询短暂失败保留取消入口与写入保护，恢复后继续完成。
- 删除正在编辑的账号关闭旧表单；未绑定套餐和没有隔离 Profile 的操作禁用且说明原因；禁用控件有可见状态，空状态不再引导点击禁用按钮。
- 思考映射切回继承时读取目录默认而不是旧覆盖，并清除不兼容默认档位；路由失败不把保存值称为生效值；恢复停用模型明确会重新启用。
- 额度查询不锁住账号管理；切换账号后立即允许新查询，迟到响应不覆盖新账号数据。
- 真实 React/Chrome 离线模拟完成“空账号 → 确认 → 假 OAuth 成功 → 选择并启用 Agent 套餐 → 查询额度”。该离线 UI 测试不打开真实官方页面；真实同设备 OAuth 另按下节独立验收。
- 当前登录使用官方 CLI 的 `volc-sso --no-browser` 两段式：Phase 1 生成官方登录链接，Phase 2 由用户粘贴授权码完成；不启动浏览器、不使用启动桥（见 0.2.14 段）。

## 浏览器隔离修复验证（2026-10-27）

- 代码检查发现 CLI 子进程重写 HOME/USERPROFILE/XDG_CONFIG_HOME，并由它启动日常默认浏览器，存在隔离环境传播风险；没有直接编辑 Chrome Preferences 的插件代码。尚未用真实用户 Chrome 重现或证明“外部篡改”提示的唯一根因。
- 本机 ArkCli 1.0.37 隔离目录探针确认使用 USERPROFILE 下的 `.arkcli`；定向核验原生浏览器调用为 PATH 查找的 rundll32。CLI 版本和平台在启动登录前检查，仅开放已核验的 Windows 1.0.37。
- 真实原生 C# 桥进程已验证：精确官方 URL、每任务鉴权 token、仅 127.0.0.1 IPC、链接原样传递、一次链接幂等与异链拒绝；不存在修改系统 opener 或注册表的路径。POSIX opener 打包固定执行位并预检 X_OK，防止缺执行位时落到系统浏览器；其 CLI 行为未验收，当前不开放登录。
- Playwright Core 1.64.1 在净化环境的独立 Worker 中加载，启动可见、启用沙箱的临时 Chrome，仅 goto 原始方舟链接；不读取 DOM、密码、Cookie 或授权码。宿主 DEBUG/DEBUG_FILE/PWDEBUG、Node 预加载和 CLI 环境不传播，驱动输出捕获丢弃。取消、超时、失败和迟到启动均有回收测试。
- `node scripts/test-oauth-browser.mjs` 在宿主调试开关开启时通过真实 Chrome 离线验证：官方页面与 CLI callback 均由本地 fixture 拦截，模拟自动回调后关闭所属窗口，无真实登录或提码。
- **真实验收通过**：`node scripts/test-oauth-live.mjs --confirm-real-login` 使用正式构建产物、官方 CLI 和独立临时目录。用户在方舟同设备页面手动授权后，官方回调完成，CLI 登录成功，whoami 身份与 Agent/Coding 两类个人套餐 profile 核验通过，临时绑定原子持久化成功，随后窗口及全部临时身份/元数据清理完成。没有改变生产账号、安装插件或调用额度/推理。
- Context7 额度不可用，Playwright 启动契约对照 [官方 API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch)、安装版本类型与实现；Windows CLI 浏览器实现采用对应安装版本的定向只读核验，并以真实回调验收收口。

## 未执行

- 新用户首次购买/签约、创建或轮转 Key 的完整流程。
- 真实 raw 额度信封、实时模型目录与推理调用。
- 生产 Profile 安装、重启和会话模型迁移。
- 其他 Core / ArkCli 版本、企业席位及跨平台的真实 CLI / 宿主行为。

## 仍需验收的外部契约

1. 新用户首次消费场景选择、协议及 Key 操作必须由用户在官方流程完成；当前真实验收使用已有个人套餐账号。
2. raw GetAFPUsage/GetCodingPlanUsage 的 `{}` 请求与响应信封；本轮只验证真实身份/profile 摘要，不验证额度接口。
3. 沿用配置的 Anthropic 兼容路径、长上下文和思考档位；模型快照不是实时官方能力声明。
4. 实际 OAuth 页面与回调地址由官方 CLI 生成，随 CLI 版本而定。

具体命令依据见[接口文档](arkcli-contract.md)。

## 0.2.1 修复验证

- 单参数 factory(require) 加载实际构建产物，未提供虚假的 CommonJS 参数。
- 覆盖空模型行、非法/重复 ID 和保留名称；坏缓存返回 invalid-cache，正常套餐不受影响。
- 取消排队中的状态写入与登录绑定后，元数据未落盘、模型路由未更新，后续保存仍可执行。
- 临时写入接受 AbortSignal，并在原子替换前再次检查取消状态；已完成的原子提交不会因后续取消而回滚。
- 本机 DSH Desktop 0.2.1-rc.3 已在安装入口修复后实际启动到主界面。
