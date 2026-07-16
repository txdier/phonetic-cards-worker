import { renderInlineError, requestConfirmation } from './lib/dom.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(action, text, className = 'pc-btn-ghost') {
  const node = element('button', className, text);
  node.type = 'button';
  node.dataset.action = action;
  return node;
}

function field(form, name, labelText, value = '', options = {}) {
  const wrap = element('div', options.full ? 'pc-full' : '');
  const label = element('label', '', labelText);
  const control = options.multiline ? document.createElement('textarea') : document.createElement('input');
  control.name = name;
  control.id = `conversion-${name}`;
  control.value = value || '';
  control.required = Boolean(options.required);
  if (options.multiline) control.rows = 3;
  label.htmlFor = control.id;
  wrap.append(label, control);
  form.append(wrap);
}

export function mountConversionForm({
  host, term, api, onSuccess, onCancel, onBusyChange = () => {}, isCurrent = () => true
}) {
  let active = true;
  let submitting = false;
  let lastPayload = null;
  const panel = element('section', 'pc-conversion-panel');
  panel.dataset.role = 'conversion-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `加入记词本：${term.display_text}`);
  const form = element('form', 'pc-form pc-conversion-form open');
  form.dataset.role = 'conversion-form';
  form.noValidate = true;
  form.append(element('h3', 'pc-full pc-conversion-title', `加入记词本：${term.display_text}`));
  field(form, 'zh', '中文释义（必填）', '', { required: true });
  field(form, 'lemma', '词元 / 原形（可选）', term.normalized_text || term.display_text);
  field(form, 'example', '例句（可编辑）', term.context_sentence || '', { multiline: true, full: true });
  field(form, 'stress', '重音（可选）', '');
  const conflict = element('div', 'pc-conversion-conflict pc-full');
  conflict.dataset.role = 'conversion-conflict';
  conflict.hidden = true;
  const actions = element('div', 'pc-form-actions');
  const cancel = button('cancel-conversion', '取消');
  actions.append(cancel);
  const save = button('submit-conversion', '转换', 'pc-btn-primary');
  save.type = 'submit';
  actions.append(save);
  form.append(conflict, actions);
  panel.append(form);
  host.replaceChildren(panel);

  function current() {
    return active && isCurrent() && panel.isConnected;
  }

  function payload() {
    return {
      zh: form.elements.zh.value.trim(),
      lemma: form.elements.lemma.value.trim(),
      example: form.elements.example.value,
      stress: form.elements.stress.value.trim()
    };
  }

  function showError(message) {
    renderInlineError(form, message || '转换失败，请重试');
    form.querySelector(':scope > [data-inline-error]').dataset.role = 'conversion-error';
  }

  function setSubmitting(value) {
    submitting = Boolean(value);
    for (const control of form.querySelectorAll('button')) control.disabled = submitting;
  }

  function renderConflict(matches) {
    conflict.replaceChildren(element('p', '', '检测到相同词元。合并会追加中文释义并保留旧例句；也可创建独立卡片。'));
    for (const candidate of matches) {
      const row = element('div', 'pc-conflict-candidate');
      row.append(element('strong', '', candidate.lemma || candidate.en));
      row.append(element('span', '', candidate.zh || ''));
      if (candidate.example) row.append(element('span', 'pc-example', candidate.example));
      const merge = button('merge-candidate', '合并到此卡片', 'pc-btn-primary');
      merge.dataset.wordId = candidate.id;
      row.append(merge);
      conflict.append(row);
    }
    conflict.append(button('create-separate', '创建独立卡片'));
    conflict.hidden = false;
  }

  async function send(strategy, targetWordId) {
    if (submitting) return;
    lastPayload = lastPayload || payload();
    if (!lastPayload.zh) {
      form.elements.zh.setAttribute('aria-invalid', 'true');
      showError('中文释义不能为空');
      return;
    }
    setSubmitting(true);
    onBusyChange(true);
    form.querySelector(':scope > [data-inline-error]')?.remove();
    const body = { ...lastPayload };
    if (strategy) body.strategy = strategy;
    if (targetWordId) body.targetWordId = targetWordId;
    try {
      const word = await api(`/api/marked-terms/${encodeURIComponent(term.id)}/add-to-word`, {
        method: 'POST', body: JSON.stringify(body)
      });
      if (!current()) return;
      onBusyChange(false);
      onSuccess?.(word, term);
      active = false;
    } catch (requestError) {
      if (!current()) return;
      if (requestError.status === 409 && requestError.code === 'LEMMA_EXISTS') {
        renderConflict(Array.isArray(requestError.data?.matches) ? requestError.data.matches : []);
      } else {
        showError(requestError.message);
      }
    } finally {
      if (isCurrent()) onBusyChange(false);
      if (current()) {
        setSubmitting(false);
      }
    }
  }

  function onSubmit(event) {
    if (event.target !== form) return;
    event.preventDefault();
    lastPayload = payload();
    conflict.hidden = true;
    send();
  }

  function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !panel.contains(target)) return;
    if (target.dataset.action === 'cancel-conversion') {
      if (submitting) return;
      active = false;
      onCancel?.();
    }
    if (target.dataset.action === 'merge-candidate') {
      lastPayload = payload();
      send('merge', target.dataset.wordId);
    }
    if (target.dataset.action === 'create-separate') {
      lastPayload = payload();
      send('new');
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (submitting) return;
    active = false;
    onCancel?.();
  }

  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('click', onClick);
  panel.addEventListener('keydown', onKeyDown);
  form.elements.zh.focus();
  return () => {
    active = false;
    panel.removeEventListener('submit', onSubmit);
    panel.removeEventListener('click', onClick);
    panel.removeEventListener('keydown', onKeyDown);
  };
}

export function createPendingView({ root, api }) {
  let mounted = true;
  let terms = [];
  let pageError = '';
  let conversionCleanup = null;
  let mutationBusy = false;
  let conversionTrigger = null;

  function setMutationBusy(value) {
    mutationBusy = Boolean(value);
    for (const control of root.querySelectorAll('[data-action="convert"], [data-action="delete-global"]')) {
      control.disabled = mutationBusy;
    }
  }

  function render() {
    conversionCleanup?.();
    conversionCleanup = null;
    root.replaceChildren();
    const header = element('div', 'pc-header');
    header.append(element('div', 'pc-eyebrow', 'ARTICLE PRACTICE · 待整理'));
    header.append(element('h1', 'pc-title', '待整理标记'));
    header.append(element('div', 'pc-sub', '把文章中明确标记的词语整理成记词卡片。'));
    root.append(header);
    if (pageError) {
      renderInlineError(root, pageError);
    }
    if (!terms.length) {
      root.append(element('div', 'pc-empty', pageError ? '暂时无法加载待整理标记。' : '没有待整理标记。'));
      return;
    }
    const list = element('div', 'pc-pending-list');
    for (const term of terms) {
      const row = element('article', 'pc-card pc-pending-row');
      row.dataset.termId = term.id;
      row.append(element('h2', 'pc-pending-term', term.display_text));
      const meta = element('div', 'pc-article-meta');
      meta.append(element('span', '', term.kind === 'phrase' ? '短语' : '单词'));
      meta.append(element('span', '', `${Number(term.source_count) || 0} 个来源`));
      row.append(meta);
      const actions = element('div', 'pc-article-actions');
      actions.append(button('convert', '加入记词本', 'pc-btn-primary'));
      const remove = button('delete-global', '取消标记');
      remove.classList.add('pc-danger');
      actions.append(remove);
      row.append(actions);
      list.append(row);
    }
    const formHost = element('div', 'pc-conversion-host');
    formHost.dataset.role = 'conversion-host';
    root.append(list, formHost);
  }

  function openConversion(term, trigger) {
    if (mutationBusy) return;
    const host = root.querySelector('[data-role="conversion-host"]');
    if (!host) return;
    conversionTrigger = trigger;
    conversionCleanup?.();
    conversionCleanup = mountConversionForm({
      host, term, api, isCurrent: () => mounted, onBusyChange: setMutationBusy,
      onCancel: () => {
        host.replaceChildren();
        if (conversionTrigger?.isConnected) conversionTrigger.focus();
      },
      onSuccess: () => {
        terms = terms.filter(item => item.id !== term.id);
        render();
      }
    });
  }

  async function deleteGlobal(term) {
    if (mutationBusy) return;
    const sourceCount = Number(term.source_count) || 0;
    const confirmed = await requestConfirmation({
      title: '取消全部文章标记',
      message: `确定取消“${term.display_text}”的全部文章标记吗？该词共有 ${sourceCount} 个来源，取消后将全部清除。`,
      confirmLabel: '全部清除',
      danger: true
    });
    if (!confirmed || !mounted || mutationBusy) return;
    setMutationBusy(true);
    try {
      await api(`/api/marked-terms/${encodeURIComponent(term.id)}`, { method: 'DELETE' });
      if (!mounted) return;
      terms = terms.filter(item => item.id !== term.id);
      pageError = '';
      mutationBusy = false;
      render();
    } catch (error) {
      if (!mounted) return;
      pageError = error.message || '取消标记失败';
      mutationBusy = false;
      render();
    }
  }

  function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    const id = target.closest('[data-term-id]')?.dataset.termId;
    const term = terms.find(item => item.id === id);
    if (!term) return;
    if (target.dataset.action === 'convert') openConversion(term, target);
    if (target.dataset.action === 'delete-global') deleteGlobal(term);
  }

  root.addEventListener('click', onClick);
  root.replaceChildren(element('div', 'pc-empty', '加载中…'));
  api('/api/marked-terms').then(result => {
    if (!mounted) return;
    terms = [...result].sort((left, right) => Number(right.created_at) - Number(left.created_at));
    render();
  }).catch(error => {
    if (!mounted) return;
    pageError = error.message || '待整理标记加载失败';
    render();
  });

  return () => {
    mounted = false;
    conversionCleanup?.();
    root.removeEventListener('click', onClick);
  };
}
