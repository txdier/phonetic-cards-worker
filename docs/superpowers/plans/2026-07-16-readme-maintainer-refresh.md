# README Maintainer Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outdated README with a concise Chinese maintenance manual that accurately describes the current word-card and article-practice application, local setup, migration, testing, authentication, deployment, and maintenance constraints.

**Architecture:** Treat current source code, `package.json`, `wrangler.toml`, migrations, and tests as the source of truth. Rewrite only `README.md`; do not change runtime code, configuration, migrations, dependencies, or deployment state.

**Tech Stack:** Markdown, Cloudflare Workers, D1, Wrangler, native HTML/CSS/JavaScript, Node.js test runner

## Global Constraints

- The README is primarily for the maintainer's future deployment and maintenance work.
- Use concise Chinese and PowerShell-compatible commands.
- Describe only functionality present in the current repository.
- Cover both 记词本 and 文章练习 workflows.
- List migrations `0001` through `0004` and the modular `src/`, `public/`, `tests/`, and `docs/superpowers/` layout.
- Include `npm install`, local `.dev.vars`, local/remote migrations, `wrangler dev`, `npm test`, `npm run test:all`, `git diff --check`, Wrangler secrets, and `wrangler deploy`.
- Do not hard-code the current test count.
- Do not include real passwords, secrets, session tokens, or `.dev.vars` values.
- Remove obsolete `REPLACE_WITH_YOUR_D1_DATABASE_ID`, future multi-user implementation instructions, and future TTS/R2 implementation instructions.
- Record that the pending organizer is a 920px responsive ledger: three columns on wide screens, two on medium screens, one on phones.
- Do not add screenshots, API payload tables, database field dictionaries, frameworks, or dependencies.

## File Structure

- Modify `README.md`: the only implementation file; becomes the maintainer-oriented source of operational guidance.
- Read-only sources: `package.json`, `wrangler.toml`, `migrations/*.sql`, `src/*.js`, `public/*.js`, `public/lib/*.js`, and `tests/*.test.js`.

---

### Task 1: Rewrite README as an operations-first maintenance manual

**Files:**
- Modify: `README.md`
- Verify: `package.json`, `wrangler.toml`, `migrations/`, `src/`, `public/`, `tests/`

**Interfaces:**
- Consumes: repository file names, npm scripts, Wrangler configuration, implemented UI workflows, authentication behavior, and migration commands.
- Produces: a standalone `README.md` containing the exact sections and operational guidance below.

- [ ] **Step 1: Run a failing stale-README audit**

Run this PowerShell command before changing `README.md`:

```powershell
@'
const { readFileSync } = require('node:fs');
const readme = readFileSync('README.md', 'utf8');
const required = [
  '0003_article_practice.sql',
  '0004_add_last_tested.sql',
  'src/markings-api.js',
  'public/reader-view.js',
  'npm install',
  'npm run test:all',
  'git diff --check',
  '920px'
];
const forbidden = [
  'REPLACE_WITH_YOUR_D1_DATABASE_ID',
  '以后（想加第二个真实用户）',
  '接入一个 TTS 服务生成音频'
];
const missing = required.filter(value => !readme.includes(value));
const stale = forbidden.filter(value => readme.includes(value));
if (missing.length || stale.length) {
  console.error(JSON.stringify({ missing, stale }, null, 2));
  process.exit(1);
}
console.log('README maintenance audit passed');
'@ | node -
```

Expected: exit code 1. The current README omits current migrations/modules/commands/920px guidance and still contains obsolete setup and future implementation text.

- [ ] **Step 2: Confirm every referenced source-of-truth file exists**

Run:

```powershell
@(
  'package.json', 'wrangler.toml',
  'migrations/0001_create_words_table.sql',
  'migrations/0002_add_users.sql',
  'migrations/0003_article_practice.sql',
  'migrations/0004_add_last_tested.sql',
  'src/index.js', 'src/auth.js', 'src/words-api.js', 'src/articles-api.js',
  'src/markings-api.js', 'src/progress-api.js', 'src/stats-api.js',
  'public/app.js', 'public/words-view.js', 'public/articles-view.js',
  'public/reader-view.js', 'public/pending-view.js', 'public/stats-view.js',
  'public/routes.js', 'public/styles.css'
) | ForEach-Object {
  if (-not (Test-Path -LiteralPath $_)) { throw "Missing README source: $_" }
}
```

Expected: exit code 0 with no output.

- [ ] **Step 3: Replace README with the approved section structure**

Use `apply_patch` to replace `README.md`. The finished document must use this exact top-level order and content contract:

```markdown
# Phonetic Cards

一款部署在 Cloudflare Workers + D1 上的个人英语记词与文章练习工具。前端使用原生 HTML/CSS/JavaScript，由 Worker Assets 托管；后端 Worker 提供单用户认证和按用户隔离的 API。

## 当前功能

### 记词本

- 新增、编辑和删除词卡，记录原形、词形、中文释义、例句和重音。
- 使用浏览器 Web Speech API 朗读单词和例句，可切换慢速朗读。
- 学习模式展示完整词卡；自测模式支持揭示答案、记得/忘记判断和熟悉度更新。

### 文章练习

- 创建、编辑、删除英文纯文本文章，保存标题、作者、来源和笔记。
- 恢复上次阅读位置，记录完整阅读次数、有效阅读时长和完整全文朗读次数。
- 朗读句子、选中内容或全文；全文支持暂停、继续、停止、从指定句开始和语速调整。
- 标记同一句内的单词或短语，并在其他文章中自动高亮匹配内容。
- 在待整理页将标记收录为词卡或移除标记；同原形词卡可选择合并或独立创建。
- 统计页按文章显示阅读、朗读、标记、待整理和已转换数量。

## 技术栈

- Cloudflare Workers + Worker Assets
- Cloudflare D1
- 原生 HTML / CSS / JavaScript ES modules
- Web Speech API
- Node.js 内置测试运行器 + JSDOM

## 目录结构

列出 `wrangler.toml`、`migrations/0001` 至 `0004`、模块化 `src/` API 文件、`public/` 视图和 `lib/`、`tests/`、`docs/superpowers/`。每项使用一行短注释说明职责。

## 本地启动

1. 运行 `npm install`。
2. 在不提交的 `.dev.vars` 中设置示例占位值 `AUTH_PASSWORD=...` 与 `AUTH_SECRET=...`，不放真实值。
3. 确认 `wrangler.toml` 中 `AUTH_USERNAME`、D1 `database_name` 与 `database_id` 指向目标环境；重新创建数据库时运行 `wrangler d1 create phonetic_cards_db` 并更新 `database_id`。
4. 运行 `wrangler d1 migrations apply phonetic_cards_db --local`。
5. 运行 `wrangler dev` 并打开 `http://localhost:8787`。

## 测试与提交前验证

列出 `npm test`、`npm run test:all` 和 `git diff --check`。说明 UI 改动还需检查桌面/移动端、明暗主题、键盘焦点和水平溢出；不要写死测试数量。

## 数据迁移

列出本地 apply、远程 apply 和 `wrangler d1 migrations create phonetic_cards_db <name>`。明确旧 migration 不可回改，只能新增顺序 migration。

## 部署

依次列出 `wrangler login`、两个 `wrangler secret put`、远程 migration 和 `wrangler deploy`。说明 `AUTH_USERNAME` 是 `wrangler.toml` 普通变量，密码和签名密钥不可写进仓库。

## 认证与数据边界

说明当前是一个环境变量用户名的单用户配置；首次登录确保 D1 `users` 记录存在；会话 cookie 有效 30 天并使用 HttpOnly、Secure、SameSite=Lax；所有业务 API 按 `user_id` 约束；不宣称支持注册多个账号。

## 关键行为与维护注意事项

- 文章、标记、转换和统计需要联网；进度暂存重试不是完整离线模式。
- 语音能力取决于浏览器 Web Speech API。
- 待整理页最大内容宽度为 920px，宽屏三列、中屏两列、手机单列；收录/移除按钮上下排列。
- `.dev.vars`、`.wrangler/`、secret 和本地运行状态不得提交。
- 正文匹配、标记来源、转换和统计的详细规则以 `docs/superpowers/specs/2026-07-15-article-practice-design.md` 为准。
```

Write the actual directory tree and command blocks in full; do not leave the descriptive instructions from the template as prose. Keep operational explanations short enough that the README remains easy to scan.

- [ ] **Step 4: Re-run the README audit and verify it passes**

Run the exact command from Step 1 again.

Expected: exit code 0 and output `README maintenance audit passed`.

- [ ] **Step 5: Verify command names, migration names, and stale text**

Run:

```powershell
rg -n "npm install|npm test|npm run test:all|git diff --check|wrangler d1 migrations apply|wrangler secret put|wrangler deploy|000[1-4]_" README.md
rg -n "REPLACE_WITH_YOUR_D1_DATABASE_ID|以后（想加第二个真实用户）|接入一个 TTS 服务生成音频" README.md
```

Expected: the first command finds every required operation and all four migrations; the second command produces no matches.

- [ ] **Step 6: Run repository verification**

Run:

```powershell
npm run test:all
git diff --check
git status --short
```

Expected: all tests pass, `git diff --check` produces no output, and only `README.md` plus the already committed plan/spec history are part of this task.

- [ ] **Step 7: Commit the README rewrite**

```powershell
git add README.md
git commit -m "docs: refresh maintainer README"
```
