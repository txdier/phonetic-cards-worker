# 语音卡片 · 部署到 Cloudflare Workers + D1

## 目录结构
```
phonetic-cards-worker/
├── wrangler.toml               # Worker 配置（含 D1 migrations_dir 绑定 + AUTH_USERNAME 变量）
├── migrations/
│   ├── 0001_create_words_table.sql   # 第一版建表语句
│   └── 0002_add_users.sql            # 新增 users 表 + words.user_id 字段
├── src/index.js                # Worker 后端逻辑（登录/会话 + 生词的增删改查 API）
└── public/index.html           # 前端页面（静态资源，由 Worker Assets 托管）
```

## 部署步骤

1. 安装 wrangler（如果还没装）
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. 创建 D1 数据库
   ```bash
   wrangler d1 create phonetic_cards_db
   ```
   命令执行后会返回一个 `database_id`，把它填进 `wrangler.toml` 里的
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`。

3. 应用 migrations 建表
   ```bash
   wrangler d1 migrations apply phonetic_cards_db --remote
   ```
   本地开发调试时用 `--local` 代替 `--remote`。
   wrangler 会自动读取 `migrations/` 目录下按序号命名的 SQL 文件并依次执行，
   已经执行过的文件会被记录，不会重复跑。

   **以后要改表结构时**（比如加新字段），不要直接改老的迁移文件，而是新建一个：
   ```bash
   wrangler d1 migrations create phonetic_cards_db add_something
   ```
   这会在 `migrations/` 里生成一个新的空文件（比如 `0002_add_something.sql`），
   把新的 `ALTER TABLE ...` 之类的语句写进去，再执行 `apply` 命令即可，
   老数据不会丢。

4. 设置登录密钥
   - **正式环境**（`wrangler deploy` 之后生效）：
     ```bash
     wrangler secret put AUTH_PASSWORD
     wrangler secret put AUTH_SECRET
     ```
     执行后会提示你输入值，输入完直接回车即可（不会显示在终端历史里）。
   - **本地预览**（`wrangler dev`）：`wrangler secret put` 设置的是线上密钥，本地调试
     读的是项目根目录下的 `.dev.vars` 文件，自己新建一个（不要提交到 git）：
     ```
     AUTH_PASSWORD=你的本地测试密码
     AUTH_SECRET=一串足够长的随机字符串
     ```
   用户名不需要 secret，直接改 `wrangler.toml` 里 `[vars]` 下的 `AUTH_USERNAME` 就行。
   这两个密钥具体的设计说明见下面"用户体系是怎么设计的"一节。

5. 本地预览
   ```bash
   wrangler dev
   ```
   打开 `http://localhost:8787` 就能看到页面，数据存本地模拟的 D1。

6. 正式发布
   ```bash
   wrangler deploy
   ```
   发布后会给你一个 `*.workers.dev` 的域名，绑定自己的域名可以在
   Cloudflare Dashboard 的 Workers → 触发器 里加自定义域名。

## 用户体系是怎么设计的

**现在（单人使用，但支持跨设备）**

登录不查数据库，而是跟 Worker 的环境变量比对，部署前需要设置三个值：

```bash
wrangler secret put AUTH_PASSWORD   # 你的登录密码
wrangler secret put AUTH_SECRET     # 用来签名登录会话的密钥，随便一串足够长的随机字符串即可
```

`AUTH_USERNAME`（用户名）不算敏感信息，已经作为普通变量写在 `wrangler.toml` 的
`[vars]` 里，你可以直接改成自己想要的用户名，不需要用 secret。

登录流程：
1. 前端提交用户名密码到 `/api/login`。
2. Worker 拿这两个值跟 `AUTH_USERNAME` / `AUTH_PASSWORD` 比对。
3. 通过后，Worker 会在 D1 的 `users` 表里"确保"存在这个用户（第一次登录自动建一条记录，
   之后一直复用同一个 `user_id`），然后签发一个 30 天有效期的登录态，写入 `session` cookie
   （HttpOnly + Secure，前端 JS 读不到，也拿不走）。
4. 之后所有 `/api/words*` 请求都靠这个 cookie 识别"这是谁的生词"，不再依赖之前那种
   "换个浏览器就是新用户"的 `device_id` 方案——只要用同一个账号密码登录，
   手机、电脑、平板看到的都是同一份数据。

**以后（想加第二个真实用户）**

`users` 表已经建好了（`id / username / password_hash / created_at`），`words` 表也已经
有 `user_id` 外键，所以以后从"环境变量单用户"升级到"数据库里存多个用户"时，改动会很小：

1. 把 `handleLogin` 里"跟环境变量比对"的逻辑，换成"查 `users` 表，校验 `password_hash`"。
2. 新增用户时，往 `users` 表插入一行，`password_hash` 用 `crypto.subtle` 的 PBKDF2/SHA-256
   算一个哈希存进去（不要存明文密码）。
3. 前端登录界面完全不用改，接口形状（`POST /api/login { username, password }`）也不用改。

老的 `device_id` 字段还留在 `words` 表里（migration 0001 建的），没有被删除，只是新代码
不再使用它，纯粹是为了不破坏已有数据、避免一次有风险的删列操作。

## 关于发音

前端用的是浏览器自带的 `speechSynthesis`（Web Speech API），不需要
额外的服务器成本，但不同系统/浏览器发音质量会有差异。如果之后想要
统一、更自然的发音，可以：

1. 接入一个 TTS 服务生成音频。
2. 把生成好的 mp3 存进 Cloudflare R2。
3. 前端优先播放 R2 里缓存好的音频，没有的话再回退到 `speechSynthesis`。

这个可以作为后续迭代，现在的版本先把最核心的记录、发音、自测流程跑通。

## 本地开发与验证

首次拉取代码或迁移更新后，依次运行：

```powershell
wrangler d1 migrations apply phonetic_cards_db --local
npm run test:all
wrangler dev
```

`npm test` 可运行根目录中的常规测试；提交前建议使用 `npm run test:all` 覆盖所有测试目录。

## 文章练习工作流

文章练习第一版支持手动创建纯文本英文文章，并保留标题、正文、作者、来源和笔记。文章库可进入单栏阅读器，正文适合手机和桌面阅读。

在文章中选中同一句内的单词或短语后，可以先“标记生词”，不必立即填写中文。用户明确标记过的文章是该生词的显式来源；相同内容在其他文章中会自动高亮，但自动出现不算显式来源，也不会增加该文章的标记统计。待整理页可集中取消标记或补充中文并转换为记词卡片。

转换时必须填写中文释义。原形由用户确认，所选拼写会作为词形记录；原形和词形都能匹配文章。遇到相同原形时，界面会要求选择合并到已有卡片或创建独立卡片，不会自动替用户决定。

每篇文章独立记录以下统计：

- 完整阅读次数：从文章顶部阅读到末尾才计数；
- 有效阅读时长：页面在前台且最近 60 秒内有滚动、选择、点击或朗读操作才累计；
- 显式标记、待整理和已转入词本数量；
- 完整全文朗读次数：朗读到末尾且覆盖至少 80% 的句子才计数。

文章、标记、转换和统计功能当前是 online-only（需联网使用）。阅读进度或统计提交临时失败时会先暂存在当前浏览器并自动重试，但这不是完整离线模式，也不提供跨设备离线冲突合并。
