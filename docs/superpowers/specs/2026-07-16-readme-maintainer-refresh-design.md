# README 维护手册化改写设计

日期：2026-07-16

## 1. 目标与读者

README 的主要读者是项目维护者本人。文档应优先回答以下问题：

1. 项目当前能做什么；
2. 新环境如何安装、初始化并启动；
3. 本地与远程数据库迁移如何执行；
4. 认证变量和 secret 如何配置；
5. 修改后如何验证并部署；
6. 出现问题时应先检查哪些位置。

README 不再承担完整产品规格或逐接口参考手册的职责。

## 2. 改写方式

采用整体重写，而不是继续在现有章节末尾追加内容。保留仍准确的部署、认证和 Web Speech 原理，但重新组织为“维护操作优先”的顺序，并删除已经过时或尚未实现的说明。

文档使用简洁中文，命令以 PowerShell 兼容写法为主。所有命令、路径、文件名和功能描述都必须能从当前代码或配置中直接验证。

## 3. README 结构

### 3.1 项目概览

用一段话说明项目基于 Cloudflare Workers、D1 和原生 HTML/CSS/JavaScript，包含两大模块：

- 记词本：词卡增删改、发音、学习模式、自测模式、熟悉度；
- 文章练习：文章管理、阅读进度、朗读、词语标记、待整理转换和逐文章统计。

### 3.2 当前功能

按用户工作流列出已实现能力，不罗列未来设想。应覆盖：

- 单用户环境变量认证与跨设备数据隔离；
- 记词卡、原形、词形、释义、例句、重音和熟悉度；
- 文章创建、编辑、删除与阅读位置恢复；
- 单词/短语标记、跨文章高亮与来源计数；
- 待整理词条的收录、移除、同原形合并或独立创建；
- 句子、选中内容和全文朗读；
- 阅读次数、有效时长、标记和完整朗读统计；
- 进度提交失败后的浏览器暂存与重试。

### 3.3 技术栈与目录结构

目录树反映当前模块化代码，而不是只列 `src/index.js`：

- `src/` 下的认证、文章、标记、进度、统计和单词 API；
- `public/` 下的应用协调器、各视图、路由、样式与通用库；
- `migrations/0001` 至 `0004`；
- `tests/`；
- `docs/superpowers/` 中的设计与实施记录。

### 3.4 本地启动

给出从新拉取代码到可用页面的最短流程：

1. `npm install`；
2. 创建不提交的 `.dev.vars`，配置 `AUTH_PASSWORD` 和 `AUTH_SECRET`；
3. 确认 `wrangler.toml` 中的 `AUTH_USERNAME` 和 D1 配置；
4. 执行本地 migrations；
5. 启动 `wrangler dev`；
6. 打开 `http://localhost:8787`。

### 3.5 测试与验证

说明：

- `npm test` 运行 `tests/*.test.js`；
- `npm run test:all` 运行 `tests/**/*.test.js`；
- 提交前至少运行完整测试和 `git diff --check`；
- UI 改动应检查桌面与移动端、明暗主题、键盘焦点和无水平滚动。

不在 README 中写死测试数量，因为测试数量会持续变化。

### 3.6 数据迁移与部署

明确区分：

- 本地：`wrangler d1 migrations apply phonetic_cards_db --local`；
- 远程：`wrangler d1 migrations apply phonetic_cards_db --remote`；
- 新建迁移：`wrangler d1 migrations create phonetic_cards_db <name>`；
- secret：`wrangler secret put AUTH_PASSWORD` 和 `wrangler secret put AUTH_SECRET`；
- 发布：`wrangler deploy`。

强调只能新增 migration，不能回改已经应用的旧 migration。

### 3.7 认证与数据边界

保留当前真实模型：

- `AUTH_USERNAME` 来自普通变量；
- `AUTH_PASSWORD` 与 `AUTH_SECRET` 来自 secret 或 `.dev.vars`；
- 登录成功后确保 `users` 记录存在，并签发 30 天 HttpOnly、Secure、SameSite=Lax cookie；
- 所有业务 API 都按 `user_id` 限制数据；
- 当前仍是单用户名配置，不声称已经支持多个独立账号注册。

### 3.8 维护注意事项

集中记录容易遗忘的约束：

- API 和前端都是原生模块，不引入前端框架；
- 文章、标记、转换和统计是在线功能，失败重试不等于完整离线模式；
- 语音依赖浏览器 Web Speech API，语音质量与支持度由浏览器决定；
- 待整理页内容宽度为 920px，宽屏三列、中屏两列、手机单列；
- 不提交 `.dev.vars`、本地 Wrangler 状态或 secret。

## 4. 删除或压缩的旧内容

以下内容不再保留为大段正文：

- “以后升级为多用户”的假设性改造步骤；
- 尚未实现的第三方 TTS 与 R2 音频缓存方案；
- 已经不存在的 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 操作提示；
- 只描述 0001/0002 migration 和单体 `src/index.js` 的旧目录树；
- 重复出现的部署与本地启动说明。

如需保留未来方向，只用一句“当前不在范围内”说明，不写实现方案。

## 5. 准确性与验收

README 改写后必须满足：

- 所有列出的文件和命令在仓库中存在或可执行；
- 功能描述与当前前后端代码一致；
- migration 数量和名称与目录一致；
- 不包含真实密码、secret 或 `.dev.vars` 内容；
- 不宣称未实现的功能；
- Markdown 代码块闭合，`git diff --check` 无错误；
- 完整测试通过，证明文档修改未伴随意外代码变化。

## 6. 非目标

- 不生成逐接口请求/响应参考；
- 不生成完整数据库字段字典；
- 不新增截图或架构图；
- 不修改代码、配置、迁移或部署状态；
- 不发布、推送或创建 Pull Request。
