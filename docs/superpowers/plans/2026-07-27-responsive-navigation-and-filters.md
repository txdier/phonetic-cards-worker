# 响应式导航与筛选栏修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 修复移动端顶部两行顺序和账户操作布局，并让 PC 端词库筛选栏与 920px 主内容列对齐。

**架构：** 保持现有 HTML 和 JavaScript 行为不变，仅在现有样式表中补充内容宽度约束，并在 `640px` 移动端断点通过 Flexbox `order` 调整两行顺序。使用静态样式回归测试约束关键声明，再用完整测试和实际视口渲染验证。

**技术栈：** 原生 HTML/CSS/JavaScript、Node.js 内置测试运行器、JSDOM

## 全局约束

- 移动端断点保持为 `max-width: 640px`。
- 移动端账户操作在第一行，用户名靠左，主题与退出登录按钮在右侧。
- 移动端模块导航在第二行，两个入口等宽。
- PC 端筛选栏最大宽度为 `920px` 并水平居中。
- 不改变文案、点击处理、路由、主题持久化或退出登录行为。
- 不新增 JavaScript 交互。

---

### Task 1：响应式导航与筛选栏样式

**文件：**
- 修改：`tests/static-shell.test.js`
- 修改：`public/styles.css`

**接口：**
- 输入：`public/styles.css` 中的 `.pc-library-filters`、`.pc-topnav`、`.pc-module-tabs`、`.pc-account-actions` 和 `.pc-username` 样式规则。
- 输出：受静态回归断言保护的 PC 端内容宽度和移动端两行布局。

- [ ] **Step 1：编写失败的静态样式回归测试**

在 `tests/static-shell.test.js` 中新增：

```js
test('navigation and word filters follow the responsive content layout', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const filters = css.match(/\.pc-library-filters\s*\{([^}]*)\}/)?.[1];

  assert.ok(filters, 'word filters should have a style rule');
  assert.match(filters, /max-width:\s*920px/);
  assert.match(filters, /margin:\s*0\s+auto\s+18px/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-account-actions\s*\{[^}]*order:\s*-1/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-account-actions\s*\{[^}]*width:\s*100%/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-module-tabs\s*\{[^}]*width:\s*100%/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-username\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-username\s*\{[^}]*text-overflow:\s*ellipsis/);
});
```

- [ ] **Step 2：运行测试并确认按预期失败**

运行：

```bash
node --test tests/static-shell.test.js
```

预期：新增测试失败，失败信息指出 `.pc-library-filters` 缺少 `max-width: 920px`，且移动端缺少账户栏排序规则。

- [ ] **Step 3：应用最小 CSS 修复**

将 `public/styles.css` 中的筛选栏规则改为：

```css
.pc-library-filters {
  max-width: 920px; margin: 0 auto 18px; display: grid;
  grid-template-columns: minmax(180px, 1.4fr) repeat(2, minmax(130px, .7fr)) auto auto auto;
  gap: 9px; align-items: center;
}
```

在 `@media (max-width: 640px)` 中将移动端顶栏相关规则改为：

```css
.pc-topnav { align-items: stretch; flex-direction: column; }
.pc-account-actions { order: -1; width: 100%; flex-wrap: nowrap; }
.pc-username {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-right: auto;
}
.pc-module-tabs { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
.pc-module-tab { width: 100%; }
```

- [ ] **Step 4：运行目标测试并确认通过**

运行：

```bash
node --test tests/static-shell.test.js
```

预期：`tests/static-shell.test.js` 全部通过，0 个失败。

- [ ] **Step 5：运行完整测试套件**

运行：

```bash
npm test
```

预期：全部测试通过，0 个失败。

- [ ] **Step 6：检查 PC 和移动端实际渲染**

启动本地开发服务器，在约 `1920×900` 和 `400×832` 视口检查：

- PC 端词库筛选栏左右边缘与标题、词卡内容列对齐。
- 移动端第一行显示用户名、主题、退出登录，第二行显示等宽的词库和文章练习入口。
- 移动端没有横向滚动，长用户名不会挤掉操作按钮。

- [ ] **Step 7：检查差异并提交**

运行：

```bash
git diff --check
git diff -- tests/static-shell.test.js public/styles.css
git status --short
```

确认只有计划内的测试和样式修改后提交：

```bash
git add tests/static-shell.test.js public/styles.css
git commit -m "fix: align responsive navigation and filters"
```
