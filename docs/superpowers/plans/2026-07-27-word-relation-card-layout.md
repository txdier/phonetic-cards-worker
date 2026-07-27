# 词间关系卡片内布局修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 PC 端词卡内的关系表单和已有关系行完整留在卡片边界内，同时保留移动端单列布局。

**架构：** 不修改 HTML 或 JavaScript，只将关系表单的桌面网格从固定最小宽度的四列改为两个可收缩列，并将已有关系行改为“可收缩内容列 + 按内容宽度操作列”。使用静态 CSS 回归断言保护桌面和移动端规则，再在真实三列词卡页面中测量关系面板及其子元素边界。

**技术栈：** 原生 CSS、Node.js 内置测试运行器、浏览器响应式布局测量

## 全局约束

- 仅修改 `public/styles.css` 中的关系表单和关系行网格规则。
- 不修改关系数据结构、API、表单字段、按钮文案或事件处理。
- 不改变词卡网格列数，也不让展开的词卡横跨整行。
- 保留现有 `max-width: 640px` 单列断点。

---

### Task 1：关系面板卡片内网格

**文件：**
- 修改：`tests/static-shell.test.js`
- 修改：`public/styles.css`

**接口：**
- 输入：`.pc-relation-panel form`、`.pc-relation-row` 及其移动端覆盖规则。
- 输出：PC 端两列关系表单、两列关系行，以及移动端单列关系内容。

- [ ] **Step 1：编写失败的静态 CSS 回归测试**

在 `tests/static-shell.test.js` 中新增：

```js
test('word relation controls stay within narrow cards', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const relationForm = css.match(/\.pc-relation-panel form\s*\{([^}]*)\}/)?.[1];
  const relationRow = css.match(/\.pc-relation-row\s*\{([^}]*)\}/)?.[1];

  assert.ok(relationForm, 'relation form should have a style rule');
  assert.ok(relationRow, 'relation row should have a style rule');
  assert.match(relationForm, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(relationRow, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.pc-relation-panel form,\s*\.pc-relation-row\s*\{[^}]*grid-template-columns:\s*1fr/);
});
```

- [ ] **Step 2：运行目标测试并确认按预期失败**

运行：

```bash
node --test tests/static-shell.test.js
```

预期：新增测试失败，失败信息显示关系表单仍使用四列固定最小宽度网格。

- [ ] **Step 3：应用最小 CSS 修复**

将 `public/styles.css` 中的关系表单规则改为：

```css
.pc-relation-panel form {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px; margin-top: 10px;
}
```

将已有关系行规则改为：

```css
.pc-relation-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--line);
}
```

保留现有移动端规则：

```css
.pc-library-filters, .pc-relation-panel form, .pc-relation-row {
  grid-template-columns: 1fr;
}
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
npm.cmd test
```

预期：全部测试通过，0 个失败。

- [ ] **Step 6：验证真实 PC 端词卡布局**

启动本地 Wrangler 开发服务器，在约 `1920×900` 视口打开词库并展开一个词条的“详情”。测量并确认：

- `.pc-relation-panel` 的左右边界不超过所属 `.pc-card`。
- 关系表单中的每个输入框、选择框和按钮均不超过所属 `.pc-card`。
- 相邻词卡未被覆盖，页面没有新增横向滚动。

- [ ] **Step 7：验证移动端单列布局**

将视口切换为约 `400×832`，确认关系表单六个控件按单列排列，关系面板和页面均没有横向溢出。

- [ ] **Step 8：检查差异并提交**

运行：

```bash
git diff --check
git diff -- tests/static-shell.test.js public/styles.css
git status --short
```

确认只有计划内的测试和样式修改后提交：

```bash
git add tests/static-shell.test.js public/styles.css
git commit -m "fix: contain word relation controls in cards"
```
