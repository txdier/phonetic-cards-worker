import { renderInlineError, requestConfirmation } from './lib/dom.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(action, text, className = 'pc-btn-ghost') {
  const button = element('button', className, text);
  button.type = 'button';
  button.dataset.action = action;
  return button;
}

function formatDate(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN');
}

function progressText(progress) {
  if (!progress) return '';
  if (progress.completed) return '已完成';
  const percent = Math.round(Math.max(0, Math.min(1, Number(progress.last_position_ratio) || 0)) * 100);
  return percent > 0 ? `已读 ${percent}%` : '未开始';
}

function canonicalArticleBody(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

export function updateArticlesAfterSave(articles, { saved, editingId = null, resetProgress = false }) {
  if (!saved) return articles;
  if (!editingId) return [saved, ...articles];
  return articles.map(article => {
    if (article.id !== editingId) return article;
    const next = { ...article, ...saved };
    if (resetProgress) {
      next.progress = {
        last_position_ratio: 0,
        completed: false,
        read_count: 0,
        active_read_ms: 0,
        full_read_aloud_count: 0,
        updated_at: saved.updated_at ?? article.progress?.updated_at
      };
    }
    return next;
  });
}

export function createArticlesView({
  root,
  api,
  navigate,
  route,
  aloudCheckpointStore = null,
  progressQueue = null
}) {
  let articles = [];
  let mounted = true;
  let editingId = null;
  let editingBody = '';
  let editingPositionRatio = 0;
  let pageError = '';
  let editRequestVersion = 0;

  function invalidateEditRequests() {
    editRequestVersion += 1;
  }

  function setPageError(message) {
    pageError = message || '';
    root.querySelector('[data-role="page-error"]')?.remove();
    if (!pageError) return;
    renderInlineError(root, pageError);
    root.querySelector(':scope > [data-inline-error]').dataset.role = 'page-error';
  }

  function renderHeader(title, subtitle) {
    const header = element('div', 'pc-header');
    header.append(element('div', 'pc-eyebrow', 'ARTICLE PRACTICE · 文章练习'));
    header.append(element('div', 'pc-title', title));
    header.append(element('div', 'pc-sub', subtitle));
    root.append(header);
  }

  function renderPlaceholder() {
    const labels = { pending: '待整理', stats: '阅读统计', reader: '文章阅读' };
    renderHeader(labels[route.page] || '文章练习', '此页面将在下一阶段完善。');
    const empty = element('div', 'pc-empty', route.page === 'reader' ? '阅读器正在建设中。' : '功能正在建设中。');
    empty.append(actionButton('back-library', '返回文章库'));
    root.append(empty);
  }

  function renderLibrary() {
    invalidateEditRequests();
    root.replaceChildren();
    renderHeader('文章库', '保存文章，并从这里开始阅读练习。');
    const toolbar = element('div', 'pc-toolbar pc-article-toolbar');
    toolbar.append(element('div', 'pc-sub', `共 ${articles.length} 篇文章`));
    toolbar.append(actionButton('new', '+ 新建文章', 'pc-addbtn'));
    root.append(toolbar);
    if (pageError) {
      renderInlineError(root, pageError);
      root.querySelector(':scope > [data-inline-error]').dataset.role = 'page-error';
    }

    if (!articles.length) {
      root.append(element('div', 'pc-empty', '文章库还是空的。新建一篇文章开始练习吧。'));
      return;
    }
    const grid = element('div', 'pc-grid pc-article-grid');
    for (const article of articles) {
      const card = element('article', 'pc-card pc-article-card');
      card.dataset.id = article.id;
      const title = element('h2', 'pc-article-title', article.title);
      card.append(title);
      const meta = element('div', 'pc-article-meta');
      if (article.author) meta.append(element('span', '', `作者：${article.author}`));
      if (article.source) meta.append(element('span', '', `来源：${article.source}`));
      meta.append(element('span', '', `创建于 ${formatDate(article.created_at)}`));
      const progress = progressText(article.progress);
      if (progress) meta.append(element('span', 'pc-progress-state', progress));
      card.append(meta);
      const actions = element('div', 'pc-article-actions');
      actions.append(actionButton('open-reader', '开始阅读', 'pc-btn-primary'));
      actions.append(actionButton('edit', '编辑'));
      const remove = actionButton('delete', '删除');
      remove.classList.add('pc-danger');
      actions.append(remove);
      card.append(actions);
      grid.append(card);
    }
    root.append(grid);
  }

  function field(form, name, labelText, options = {}) {
    const wrap = element('div', options.full ? 'pc-full' : '');
    const label = element('label', '', labelText);
    label.htmlFor = `article-${name}`;
    const input = options.multiline ? document.createElement('textarea') : document.createElement('input');
    input.id = `article-${name}`;
    input.name = name;
    input.required = Boolean(options.required);
    if (options.multiline) input.rows = options.rows || 5;
    const error = element('div', 'pc-field-error');
    error.dataset.errorFor = name;
    error.setAttribute('role', 'alert');
    wrap.append(label, input, error);
    form.append(wrap);
  }

  function renderForm(article = {}) {
    invalidateEditRequests();
    editingId = article.id || null;
    editingBody = article.body || '';
    editingPositionRatio = Math.max(
      0,
      Math.min(1, Number(article.progress?.last_position_ratio) || 0)
    );
    root.replaceChildren();
    renderHeader(editingId ? '编辑文章' : '新建文章', editingId ? '修改文章内容后选择是否重置阅读进度。' : '标题和正文为必填项。');
    const form = element('form', 'pc-form pc-article-form');
    form.noValidate = true;
    form.dataset.role = 'article-form';
    field(form, 'title', '标题', { required: true, full: true });
    field(form, 'body', '正文', { required: true, multiline: true, rows: 12, full: true });
    field(form, 'author', '作者（可选）');
    field(form, 'source', '来源（可选）');
    field(form, 'notes', '笔记（可选）', { multiline: true, rows: 3, full: true });
    const actions = element('div', 'pc-form-actions');
    actions.append(actionButton('cancel-form', '取消'));
    const submit = actionButton('save', editingId ? '保存修改' : '创建文章', 'pc-btn-primary');
    submit.type = 'submit';
    actions.append(submit);
    form.append(actions);
    root.append(form);
    for (const name of ['title', 'body', 'author', 'source', 'notes']) {
      form.elements[name].value = article[name] || '';
    }
    form.elements.title.focus();
  }

  function validate(form) {
    let valid = true;
    for (const name of ['title', 'body']) {
      const missing = !form.elements[name].value.trim();
      form.querySelector(`[data-error-for="${name}"]`).textContent = missing ? `${name === 'title' ? '标题' : '正文'}不能为空` : '';
      form.elements[name].setAttribute('aria-invalid', String(missing));
      valid = !missing && valid;
    }
    return valid;
  }

  async function save(form) {
    if (!validate(form)) return;
    invalidateEditRequests();
    const submit = form.querySelector('[data-action="save"]');
    const cancel = form.querySelector('[data-action="cancel-form"]');
    submit.disabled = true;
    cancel.disabled = true;
    const data = Object.fromEntries(['title', 'body', 'author', 'source', 'notes'].map(name => [name, form.elements[name].value]));
    if (editingId) {
      data.resetProgress = await requestConfirmation({
        title: '是否重置阅读进度？',
        message: '重置会清除这篇文章的阅读进度和统计；也可以保留现有进度后继续保存。',
        confirmLabel: '重置进度',
        cancelLabel: '保留进度'
      });
      if (!mounted || !form.isConnected) return;
    }
    try {
      const savedArticleId = editingId;
      const bodyChanged = canonicalArticleBody(data.body) !== canonicalArticleBody(editingBody);
      const shouldClearAloudCheckpoint = Boolean(
        savedArticleId &&
        (data.resetProgress === true || bodyChanged)
      );
      const saved = await api(savedArticleId ? `/api/articles/${encodeURIComponent(savedArticleId)}` : '/api/articles', {
        method: savedArticleId ? 'PATCH' : 'POST', body: JSON.stringify(data)
      });
      if (shouldClearAloudCheckpoint) {
        aloudCheckpointStore?.clear?.(savedArticleId);
        progressQueue?.replacePosition?.({
          kind: 'position',
          articleId: savedArticleId,
          lastPositionRatio: data.resetProgress === true ? 0 : editingPositionRatio,
          lastAloudSentenceIndex: null,
          lastAloudOffsetSeconds: 0
        }, {
          preserveLatestPositionRatio: data.resetProgress !== true
        });
      }
      if (!mounted || !form.isConnected) return;
      articles = updateArticlesAfterSave(articles, {
        saved, editingId: savedArticleId, resetProgress: data.resetProgress === true
      });
      editingId = null;
      editingBody = '';
      editingPositionRatio = 0;
      renderLibrary();
    } catch (error) {
      if (!mounted || !form.isConnected) return;
      renderInlineError(form, error.message || '保存失败，请重试');
      form.querySelector(':scope > [data-inline-error]').dataset.role = 'form-error';
      submit.disabled = false;
      cancel.disabled = false;
    }
  }

  async function editArticle(id) {
    const requestVersion = ++editRequestVersion;
    setPageError('');
    try {
      const article = await api(`/api/articles/${encodeURIComponent(id)}`);
      if (!mounted || requestVersion !== editRequestVersion) return;
      if (!articles.some(item => item.id === id)) return;
      renderForm(article);
    } catch (error) {
      if (!mounted || requestVersion !== editRequestVersion) return;
      setPageError(error.message || '加载文章失败');
    }
  }

  async function deleteArticle(id, trigger) {
    const article = articles.find(item => item.id === id);
    if (!article) return;
    const confirmed = await requestConfirmation({
      title: '删除文章',
      message: `确定删除《${article.title}》吗？此操作无法撤销。`,
      confirmLabel: '删除',
      danger: true
    });
    if (!confirmed || !mounted || !trigger.isConnected) return;
    invalidateEditRequests();
    trigger.disabled = true;
    try {
      await api(`/api/articles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!mounted) return;
      articles = articles.filter(item => item.id !== id);
      pageError = '';
      renderLibrary();
    } catch (error) {
      if (!mounted) return;
      setPageError(error.message || '删除失败，请重试');
      if (mounted && trigger.isConnected) trigger.disabled = false;
    }
  }

  function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    if (target.disabled) return;
    const id = target.closest('[data-id]')?.dataset.id;
    if (target.dataset.action === 'new') renderForm();
    if (target.dataset.action === 'cancel-form') renderLibrary();
    if (target.dataset.action === 'edit') editArticle(id);
    if (target.dataset.action === 'delete') deleteArticle(id, target);
    if (target.dataset.action === 'open-reader') navigate({ module: 'articles', page: 'reader', id });
    if (target.dataset.action === 'back-library') navigate({ module: 'articles', page: 'library' });
  }

  function onSubmit(event) {
    if (!event.target.matches('[data-role="article-form"]')) return;
    event.preventDefault();
    save(event.target);
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.replaceChildren(element('div', 'pc-empty', '加载中…'));
  if (route.page !== 'library') {
    root.replaceChildren();
    renderPlaceholder();
  } else {
    api('/api/articles').then(result => {
      if (!mounted) return;
      articles = [...result].sort((a, b) => Number(b.created_at) - Number(a.created_at));
      renderLibrary();
    }).catch(error => {
      if (!mounted) return;
      articles = [];
      pageError = error.message || '文章加载失败';
      renderLibrary();
    });
  }

  return () => {
    mounted = false;
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
  };
}
