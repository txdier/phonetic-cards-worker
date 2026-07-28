# Phonetic Cards

一款部署在 Cloudflare Workers + D1 上的个人英语记词与文章练习工具。前端使用原生 HTML、CSS 和 JavaScript ES modules，由 Worker Assets 托管；后端 Worker 提供单用户认证和按用户隔离的数据 API。

## 当前功能

### 词库与复习

- 词库按关键词、标签、FSRS 状态和到期状态筛选并分页。
- 词卡记录原形、词形、中文释义、例句、重音、标签和词间关系。
- 使用 FSRS 四档评分（忘记、困难、良好、简单）安排复习。
- 支持 Markdown、CSV 和 JSON 导出。
- 单词、例句和文章句子优先使用 Azure TTS，并以 R2 缓存；不可用时自动回退 Web Speech API。
- PC 端筛选栏与词卡内容列对齐；手机端使用账户操作在上、模块导航在下的两行顶栏。
- 词间关系表单和已有关系保持在词卡边界内，宽屏两列、手机单列显示。

### 文章练习

- 创建、编辑和删除英文纯文本文章，保存标题、正文、作者、来源和笔记。
- 恢复上次阅读位置，记录完整阅读次数、有效阅读时长和完整全文朗读次数。
- 朗读句子、选中内容或全文；全文使用随状态切换的播放、暂停或继续操作，并支持从头、历史断点或指定句开始和语速调整。
- 全文朗读按句保存跨设备断点；顶部工具栏离屏后显示悬浮控制，朗读过程中自动保持当前句可见。
- 手机和平板使用浏览器原生文字选区和视口底部操作面板，可调整选区后发音、标记或从本句开始朗读。
- 标记同一句内的单词或短语，并在其他文章中自动高亮匹配内容。
- 阅读器区分普通文本、待整理标记和已收录生词；点击已收录词可查看中文释义和收录状态。
- 在待整理页将标记收录为词卡或移除标记；同原形词卡可选择合并或独立创建。
- 统计页按文章显示阅读、朗读、标记、待整理和已转换数量。
- 阅读进度或统计事件提交临时失败时保存在当前浏览器并按顺序重试。

## 技术栈

- Cloudflare Workers + Worker Assets
- Cloudflare D1
- Cloudflare R2 + Azure AI Speech
- ts-fsrs
- 原生 HTML / CSS / JavaScript ES modules
- Web Speech API
- Node.js 内置测试运行器 + JSDOM

项目没有前端构建步骤；`public/` 中的静态资源由 Worker Assets 直接提供。

## 目录结构

```text
phonetic-cards-worker/
├── package.json                         # npm 测试脚本与 JSDOM 开发依赖
├── wrangler.toml                        # Worker、Assets、D1 和 AUTH_USERNAME 配置
├── migrations/
│   ├── 0001_create_words_table.sql      # 初始词卡表
│   ├── 0002_add_users.sql               # users 表与 words.user_id
│   ├── 0003_article_practice.sql        # 词形、文章、标记、进度和事件表
│   ├── 0004_add_last_tested.sql         # 兼容保留的旧字段
│   ├── 0005_word_learning_fsrs.sql      # FSRS、标签和词间关系
│   ├── 0006_tts_cache_usage.sql         # TTS 用量和生成租约
│   └── 0007_add_article_aloud_position.sql # 全文朗读句子断点
├── src/
│   ├── index.js                         # Worker 入口与 API 路由
│   ├── auth.js                          # 登录、会话签名与用户校验
│   ├── http.js                          # JSON 响应辅助方法
│   ├── words-api.js                     # 词库 CRUD、筛选和分页
│   ├── reviews-api.js                   # FSRS 到期卡和幂等评分
│   ├── word-library-api.js              # 标签、关系、统计和导出
│   ├── tts-api.js                       # Azure TTS、R2 缓存和用量限制
│   ├── articles-api.js                  # 文章 CRUD 与阅读详情
│   ├── markings-api.js                  # 标记、移除与收录转换
│   ├── progress-api.js                  # 阅读位置和幂等统计事件
│   └── stats-api.js                     # 逐文章统计
├── public/
│   ├── index.html                       # 静态应用外壳
│   ├── app.js                           # 登录状态、模块导航与视图协调
│   ├── api.js                           # 浏览器 API 客户端
│   ├── routes.js                        # Hash 路由
│   ├── words-view.js                    # 词库、复习和设置视图
│   ├── articles-view.js                 # 文章库与编辑表单
│   ├── reader-view.js                   # 阅读、标记、朗读与进度
│   ├── pending-view.js                  # 待整理词条与收录表单
│   ├── stats-view.js                    # 文章统计视图
│   ├── styles.css                       # 全局、响应式和明暗主题样式
│   └── lib/                             # 文本、DOM、语音和阅读会话模块
├── tests/                               # 单元、API、DOM 和应用协调测试
└── docs/superpowers/                    # 已确认的设计规格与实施计划
```

后端标记与转换逻辑的主要入口是 `src/markings-api.js`，前端文章阅读交互的主要入口是 `public/reader-view.js`。

## 本地启动

### 1. 安装依赖和 Wrangler

```powershell
npm install
npm install -g wrangler
```

如已安装 Wrangler，可跳过第二条命令。

### 2. 配置本地认证变量

在项目根目录创建不会提交到 Git 的 `.dev.vars`：

```dotenv
AUTH_PASSWORD=<本地测试密码>
AUTH_SECRET=<足够长的随机签名密钥>
AZURE_TTS_KEY=<Azure Speech 密钥>
```

用户名来自 `wrangler.toml` 的 `[vars].AUTH_USERNAME`。不要把真实密码或签名密钥写进 README、`wrangler.toml` 或其他已跟踪文件。

### 3. 确认 D1 配置

`wrangler.toml` 中的 `database_name` 和 `database_id` 必须指向要维护的 D1 数据库。只有在重新创建数据库时才需要运行：

```powershell
wrangler d1 create phonetic_cards_db
```

创建后，把命令返回的 `database_id` 更新到 `wrangler.toml`。

### 4. 应用本地迁移

```powershell
wrangler d1 migrations apply phonetic_cards_db --local
```

本地 D1 状态保存在 `.wrangler/`，不得提交。

### 5. 启动应用

```powershell
wrangler dev
```

打开 `http://localhost:8787`，使用 `AUTH_USERNAME` 和 `.dev.vars` 中的密码登录。

## 测试与提交前验证

运行根目录测试：

```powershell
npm test
```

运行所有测试目录：

```powershell
npm run test:all
```

提交前检查差异格式：

```powershell
git diff --check
```

涉及界面的改动还应检查：

- 桌面端和移动端断点；
- 明色与深色主题；
- 键盘焦点和操作顺序；
- 页面是否出现水平滚动；
- 长单词和短语是否完整显示；
- 手机浏览器原生选区、选区手柄和底部操作面板；
- 全文朗读顶部与悬浮按钮的状态是否一致；
- 历史断点跳转、指定句起读和当前朗读句自动跟随；
- `320px`、`375px` 和横屏手机上的断点摘要与“跳转”按钮是否保持单行且无溢出。

测试数量会随功能变化，因此 README 不记录固定测试总数。

## 数据迁移

本地应用全部 migration：

```powershell
wrangler d1 migrations apply phonetic_cards_db --local
```

远程应用全部 migration：

```powershell
wrangler d1 migrations apply phonetic_cards_db --remote
```

新增表或字段时创建顺序 migration：

```powershell
wrangler d1 migrations create phonetic_cards_db <migration_name>
```

不要修改已经应用过的旧 migration。数据库结构变化必须新增文件，并先在本地应用和验证，再应用到远程环境。

## 部署

### 1. 登录 Cloudflare

```powershell
wrangler login
```

### 2. 配置远程 secret

```powershell
wrangler secret put AUTH_PASSWORD
wrangler secret put AUTH_SECRET
```

`AUTH_USERNAME`、`AZURE_TTS_REGION`、`AZURE_TTS_VOICE` 和
`TTS_MONTHLY_CHAR_BUDGET` 是 `wrangler.toml` 中的普通变量。创建一次音频桶：

```powershell
wrangler r2 bucket create phonetic-cards-audio
wrangler secret put AZURE_TTS_KEY
```

密码、会话签名密钥和 Azure 密钥必须使用 secret，不得写入仓库。

### 3. 应用远程 migration

```powershell
wrangler d1 migrations apply phonetic_cards_db --remote
```

### 4. 发布 Worker

```powershell
wrangler deploy
```

发布后先验证登录、词卡列表、文章详情、待整理转换和统计页面，再进行日常使用。

## 认证与数据边界

- 当前是一个 `AUTH_USERNAME` 的单用户配置，没有注册多个独立账号的功能。
- 登录时 Worker 使用 `AUTH_USERNAME` 和 `AUTH_PASSWORD` 校验；首次成功登录会确保 D1 `users` 表中存在对应记录。
- 会话有效期为 30 天，存放在使用 `HttpOnly`、`Secure`、`SameSite=Lax` 的 `session` cookie 中。
- 除登录接口外，业务 API 都要求有效会话，并使用当前 `user_id` 限制查询和修改。
- 同一个账号在手机、电脑和平板上看到同一份 D1 数据。

## 关键行为与维护注意事项

- 文章、标记、转换和统计需要联网；进度暂存与自动重试不是完整离线模式，也不处理跨设备离线冲突。
- Azure 或 R2 不可用、达到月度额度或持续限流时会回退 Web Speech API，不影响词库、复习和阅读。
- `words.familiarity` 与 `words.last_tested_at` 仅为旧数据兼容保留，当前代码不读取或更新。
- 只有用户主动标记的文章才计为词条来源；其他文章中的自动高亮不增加来源或统计。
- 收录待整理词条时必须填写中文释义；同原形冲突由用户选择合并或新建。
- 完整阅读必须从文章顶部到达末尾；完整全文朗读必须到达末尾且覆盖至少 80% 的句子。
- 全文朗读暂停时保留当前音频位置，并保存当前句作为跨会话断点；自然播放完成后清除断点。
- 跨设备只恢复到保存句的句首，不保存句内毫秒位置；加载文章时不会自动跳转到朗读断点。
- 编辑文章正文或重置阅读进度会清除朗读断点；只修改标题、作者等元数据时保留。
- 顶部朗读工具栏离开视口后，悬浮胶囊根据状态显示暂停、继续或选择起点；词语或选区面板打开时暂时隐藏。
- 移动端选区只接受阅读正文内、同一句中的非空英文内容，不阻止浏览器自身的复制、查询和选区手柄。
- 待整理页最大内容宽度为 920px：宽屏三列、中屏两列、手机单列；“收录”和“移除”按钮上下排列。
- 词库筛选栏最大宽度为 920px；手机顶栏账户操作在第一行，词库与文章练习导航在第二行。
- 词间关系在 PC 词卡内使用可收缩的两列布局，在不超过 640px 的视口下改为单列。
- 不提交 `.dev.vars`、`.wrangler/`、secret、本地 D1 状态或会话数据。
- 文章匹配、标记来源、转换和统计的详细规则见 [`docs/superpowers/specs/2026-07-15-article-practice-design.md`](docs/superpowers/specs/2026-07-15-article-practice-design.md)。
