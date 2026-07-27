import { distinctForms, maskWordForms, primaryWord } from './lib/word-display.js';
import { renderInlineError, showToast } from './lib/dom.js';

const STATE_LABELS = ['新卡', '学习中', '复习中', '重新学习'];
const REVIEW_LABELS = ['忘记', '困难', '良好', '简单'];

export function sortWordTestQueue(words) {
  return [...words].sort((a, b) =>
    Number(a.due_at || 0) - Number(b.due_at || 0)
    || Number(a.created_at || 0) - Number(b.created_at || 0)
  );
}

export function isRevealKey(key) {
  return key === 'Enter' || key === ' ';
}

export function shouldRevealTestCard(key, nestedAction = '') {
  return isRevealKey(key) && nestedAction !== 'play' && nestedAction !== 'judge';
}

export function createWordsView({
  root,
  api,
  speech,
  tts = null,
  page = 'library',
  deleteUndoMs = 4000
}) {
  let mounted = true;
  let words = [];
  let total = 0;
  let currentPage = 1;
  let pageSize = 24;
  let tags = [];
  let reviewWords = [];
  let revealed = false;
  let editingId = null;
  let expandedId = null;
  let relations = [];
  let relationTargets = [];
  let usage = null;
  let stats = null;
  const reviewAttempts = new Map();
  let filters = { keyword: '', tag: '', state: '', due: false };
  const player = tts || {
    isSupported: speech?.isSupported,
    speakWord: (_id, _mode, text, options) => speech?.speakOnce(text, options),
    stop: () => speech?.stop?.()
  };

  function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  }

  function stateLabel(value) {
    return STATE_LABELS[Number(value)] || STATE_LABELS[0];
  }

  function tagChoices(selected = []) {
    const ids = new Set(selected.map(tag => tag.id || tag));
    if (!tags.length) return '<span class="pc-muted">可先在筛选栏旁新建标签</span>';
    return tags.map(tag => `<label class="pc-tag-choice">
      <input type="checkbox" name="tagIds" value="${escapeHtml(tag.id)}" ${ids.has(tag.id) ? 'checked' : ''}>
      ${escapeHtml(tag.name)}
    </label>`).join('');
  }

  function wordForm(word = null) {
    return `<div class="pc-form${word ? ' open' : ''}" id="pc-word-form">
      <div class="pc-full pc-conversion-title" data-role="word-form-title">${word ? '编辑单词' : '添加新词'}</div>
      <div><label for="f-en">单词（原形）</label><input id="f-en" value="${escapeHtml(word ? primaryWord(word) : '')}" placeholder="confirm"></div>
      <div><label for="f-zh">中文含义</label><input id="f-zh" value="${escapeHtml(word?.zh || '')}" placeholder="确认"></div>
      <div class="pc-full"><label for="f-stress">重音标注</label><input id="f-stress" value="${escapeHtml(word?.stress || '')}" placeholder="con-FIRM"></div>
      <div class="pc-full"><label for="f-example">例句</label><textarea id="f-example" rows="2">${escapeHtml(word?.example || '')}</textarea></div>
      <fieldset class="pc-full pc-tag-field"><legend>标签</legend>${tagChoices(word?.tags || [])}</fieldset>
      <div class="pc-form-actions"><button class="pc-btn-ghost" data-action="cancel-form">取消</button><button class="pc-btn-primary" data-action="submit-form">${word ? '保存修改' : '添加'}</button></div>
    </div>`;
  }

  function filterToolbar() {
    return `<form class="pc-library-filters" data-role="word-filters">
      <input name="keyword" value="${escapeHtml(filters.keyword)}" placeholder="搜索单词、释义" aria-label="关键词">
      <select name="tag" aria-label="标签"><option value="">全部标签</option>${tags.map(tag =>
        `<option value="${escapeHtml(tag.id)}" ${filters.tag === tag.id ? 'selected' : ''}>${escapeHtml(tag.name)}</option>`
      ).join('')}</select>
      <select name="state" aria-label="FSRS 状态"><option value="">全部状态</option>${STATE_LABELS.map((label, index) =>
        `<option value="${index}" ${filters.state === String(index) ? 'selected' : ''}>${label}</option>`
      ).join('')}</select>
      <label class="pc-slow-toggle"><input type="checkbox" name="due" ${filters.due ? 'checked' : ''}> 仅到期</label>
      <button class="pc-btn-ghost">筛选</button>
      <button type="button" class="pc-addbtn" data-action="toggle-form">+ 添加新词</button>
    </form>`;
  }

  function tagsHtml(word) {
    return (word.tags || []).length
      ? `<div class="pc-word-tags">${word.tags.map(tag => `<span>${escapeHtml(tag.name)}</span>`).join('')}</div>`
      : '';
  }

  function relationPanel(word) {
    if (expandedId !== String(word.id)) return '';
    return `<div class="pc-relation-panel">
      <h4>词间关系</h4>
      ${relations.length ? relations.map(relation =>
        `<div class="pc-relation-row"><b>${escapeHtml(relation.target_lemma)}</b><span>${escapeHtml(relation.relation_type)}</span><span>${escapeHtml(relation.note || '')}</span><button data-action="delete-relation" data-id="${escapeHtml(relation.id)}">删除</button></div>`
      ).join('') : '<div class="pc-muted">尚未添加关系</div>'}
      <form data-role="relation-form" data-word-id="${escapeHtml(word.id)}">
        <input name="targetKeyword" placeholder="搜索关联词">
        <button type="button" class="pc-btn-ghost" data-action="search-relation-targets">搜索</button>
        <select name="targetWordId" aria-label="关联词">${relationTargets.filter(item => item.id !== word.id).map(item =>
          `<option value="${escapeHtml(item.id)}">${escapeHtml(primaryWord(item))}</option>`
        ).join('')}</select>
        <select name="relationType" aria-label="关系类型">
          <option value="family">同词族</option><option value="derivative">派生</option>
          <option value="synonym">同义</option><option value="antonym">反义</option>
          <option value="confusable">易混</option><option value="other">其他</option>
        </select>
        <input name="note" placeholder="备注（可选）">
        <button class="pc-btn-ghost">添加关系</button>
      </form>
    </div>`;
  }

  function wordCard(word) {
    const forms = distinctForms(word);
    return `<article class="pc-card" data-id="${escapeHtml(word.id)}">
      <div class="pc-card-top"><div>
        <div class="pc-word">${escapeHtml(primaryWord(word))}</div>
        ${forms.length ? `<div class="pc-word-forms">词形：${forms.map(escapeHtml).join(' · ')}</div>` : ''}
        <div class="pc-zh">${escapeHtml(word.zh)}</div>${tagsHtml(word)}
      </div><div class="pc-card-top-actions">
        <button class="pc-edit" data-action="detail" data-id="${escapeHtml(word.id)}">详情</button>
        <button class="pc-edit" data-action="edit" data-id="${escapeHtml(word.id)}" aria-label="编辑 ${escapeHtml(primaryWord(word))}">编辑</button>
        <button class="pc-del" data-action="del" data-id="${escapeHtml(word.id)}" aria-label="删除 ${escapeHtml(primaryWord(word))}">×</button>
      </div></div>
      ${word.example ? `<div class="pc-example">${escapeHtml(word.example)}</div>` : ''}
      <div class="pc-card-footer"><div class="pc-controls">
        <button class="pc-play" data-action="play" data-mode="word" data-id="${escapeHtml(word.id)}" data-text="${escapeHtml(primaryWord(word))}" aria-label="朗读单词">▶</button>
        ${word.example ? `<button class="pc-play" data-action="play" data-mode="example" data-id="${escapeHtml(word.id)}" data-text="${escapeHtml(word.example)}" aria-label="朗读例句">例</button>` : ''}
        <button class="pc-play" data-action="play" data-mode="spell" data-id="${escapeHtml(word.id)}" data-text="${escapeHtml(primaryWord(word).split('').join('. '))}" aria-label="拼读单词">拼</button>
      </div><span class="pc-state-badge">${stateLabel(word.state)} · ${Number(word.reps || 0)} 次</span></div>
      ${relationPanel(word)}
    </article>`;
  }

  function libraryBody() {
    const editing = words.find(word => String(word.id) === editingId);
    return `<div class="pc-header"><div class="pc-eyebrow">PHONETIC CARDS · 词库</div><div class="pc-title">词库</div><div class="pc-sub">共 <b>${total}</b> 个完整词条</div></div>
      ${filterToolbar()}${wordForm(editing)}
      ${words.length ? `<div class="pc-grid">${words.map(wordCard).join('')}</div>` : '<div class="pc-empty">没有符合条件的词条。</div>'}
      <div class="pc-pagination">
        <button data-action="page-prev" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${currentPage} 页</span>
        <button data-action="page-next" ${currentPage * pageSize >= total ? 'disabled' : ''}>下一页</button>
      </div>`;
  }

  function reviewBody() {
    const word = sortWordTestQueue(reviewWords)[0];
    if (!word) {
      return '<div class="pc-header"><div class="pc-eyebrow">FSRS · 复习</div><div class="pc-title">复习</div></div><div class="pc-empty">当前没有到期词卡。</div>';
    }
    return `<div class="pc-header"><div class="pc-eyebrow">FSRS · 复习</div><div class="pc-title">复习</div><div class="pc-sub">本轮还有 <b>${reviewWords.length}</b> 张，单次最多 20 张</div></div>
      <div class="pc-test-wrap"><div class="pc-testcard" data-action="reveal" tabindex="0">
        <div class="pc-zh">${escapeHtml(word.zh)}</div>
        ${word.example ? `<div class="pc-example">${escapeHtml(maskWordForms(word.example, word))}</div>` : ''}
        <button class="pc-play" data-action="play" data-mode="word" data-id="${escapeHtml(word.id)}" data-text="${escapeHtml(primaryWord(word))}">▶</button>
        ${revealed ? `<div class="pc-reveal"><div class="pc-word">${escapeHtml(primaryWord(word))}</div>
          <div class="pc-judge">${REVIEW_LABELS.map((label, index) =>
            `<button data-action="judge" data-id="${escapeHtml(word.id)}" data-rating="${index + 1}">${label}</button>`
          ).join('')}</div></div>` : '<div class="pc-hint-tap">点击卡片或按 Enter / 空格揭示答案</div>'}
      </div></div>`;
  }

  function settingsBody() {
    const used = Number(usage?.usedChars || 0);
    const budget = Number(usage?.budget || 450000);
    return `<div class="pc-header"><div class="pc-eyebrow">PHONETIC CARDS · 设置</div><div class="pc-title">设置</div></div>
      <section class="pc-settings-card"><h3>导出词库</h3><div class="pc-export-actions">
        <a class="pc-btn-ghost" href="/api/export?format=markdown">Markdown</a>
        <a class="pc-btn-ghost" href="/api/export?format=csv">CSV</a>
        <a class="pc-btn-ghost" href="/api/export?format=json">JSON</a>
      </div></section>
      <section class="pc-settings-card"><h3>Azure TTS 月度用量</h3>
        <p>${used.toLocaleString()} / ${budget.toLocaleString()} 字符</p>
        <progress max="${budget}" value="${Math.min(used, budget)}"></progress>
        <p class="pc-muted">${usage?.configured ? 'Azure 与 R2 已配置；失败时自动使用浏览器语音。' : 'Azure 未配置，当前使用浏览器语音。'}</p>
      </section>
      <section class="pc-settings-card"><h3>FSRS 状态</h3>
        <p>总计 ${Number(stats?.total || 0)} · 到期 ${Number(stats?.due || 0)} · 新卡 ${Number(stats?.new || 0)} · 学习中 ${Number(stats?.learning || 0)} · 复习中 ${Number(stats?.review || 0)}</p>
      </section>
      <section class="pc-settings-card"><h3>标签</h3>
        <form data-role="tag-form" class="pc-export-actions"><input name="name" maxlength="50" required placeholder="新标签名称"><button class="pc-btn-ghost">新建标签</button></form>
        <div class="pc-word-tags">${tags.map(tag => `<span>${escapeHtml(tag.name)} · ${Number(tag.word_count || 0)} <button data-action="delete-tag" data-id="${escapeHtml(tag.id)}" aria-label="删除标签 ${escapeHtml(tag.name)}">×</button></span>`).join('')}</div>
      </section>`;
  }

  function render() {
    if (!mounted) return;
    root.innerHTML = page === 'review'
      ? reviewBody()
      : page === 'settings'
        ? settingsBody()
        : libraryBody();
    if (!player.isSupported) {
      const notice = document.createElement('div');
      notice.className = 'pc-speech-unavailable';
      notice.dataset.role = 'speech-unavailable';
      notice.setAttribute('role', 'status');
      notice.textContent = '当前浏览器不支持语音朗读，其他功能仍可正常使用。';
      root.querySelector('.pc-header')?.after(notice);
      for (const button of root.querySelectorAll('[data-action="play"]')) button.disabled = true;
    }
  }

  async function loadLibrary() {
    const query = new URLSearchParams();
    if (currentPage !== 1) query.set('page', String(currentPage));
    if (pageSize !== 24) query.set('pageSize', String(pageSize));
    if (filters.keyword) query.set('keyword', filters.keyword);
    if (filters.tag) query.set('tag', filters.tag);
    if (filters.state !== '') query.set('state', filters.state);
    if (filters.due) query.set('due', '1');
    try {
      const [wordResult, tagResult] = await Promise.all([
        api(query.size ? `/api/words?${query}` : '/api/words'),
        Promise.resolve(api('/api/tags')).catch(() => ({ tags: [] }))
      ]);
      if (!mounted) return;
      const normalized = Array.isArray(wordResult)
        ? { words: wordResult, total: wordResult.length, page: 1, pageSize: wordResult.length || 24 }
        : wordResult;
      words = normalized.words || [];
      total = Number(normalized.total || 0);
      currentPage = Number(normalized.page || 1);
      pageSize = Number(normalized.pageSize || 24);
      tags = tagResult?.tags || [];
      render();
    } catch (error) {
      if (mounted) renderInlineError(root, error.message || '词库加载失败');
    }
  }

  async function loadReview() {
    try {
      const result = await api('/api/reviews/due?limit=20');
      if (!mounted) return;
      reviewWords = result.words || [];
      render();
    } catch (error) {
      if (mounted) renderInlineError(root, error.message || '复习卡加载失败');
    }
  }

  async function loadSettings() {
    try {
      const [usageResult, statsResult, tagResult] = await Promise.all([
        api('/api/tts/usage'),
        api('/api/word-stats'),
        api('/api/tags')
      ]);
      usage = usageResult;
      stats = statsResult?.stats || statsResult;
      tags = tagResult?.tags || [];
      if (mounted) render();
    } catch (error) {
      if (mounted) renderInlineError(root, error.message || '设置加载失败');
    }
  }

  function formData() {
    return {
      lemma: root.querySelector('#f-en')?.value || '',
      en: root.querySelector('#f-en')?.value || '',
      zh: root.querySelector('#f-zh')?.value || '',
      stress: root.querySelector('#f-stress')?.value || '',
      example: root.querySelector('#f-example')?.value || '',
      tagIds: [...root.querySelectorAll('input[name="tagIds"]:checked')].map(input => input.value)
    };
  }

  async function saveWord() {
    const form = root.querySelector('#pc-word-form');
    const data = formData();
    if (!data.lemma.trim() || !data.zh.trim()) {
      renderInlineError(form, '请至少填写单词和中文含义');
      return;
    }
    try {
      const saved = await api(editingId ? `/api/words/${encodeURIComponent(editingId)}` : '/api/words', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(data)
      });
      if (editingId) {
        const index = words.findIndex(word => String(word.id) === editingId);
        if (index >= 0) words[index] = { ...words[index], ...saved };
      } else {
        words.unshift(saved);
        total += 1;
      }
      editingId = null;
      render();
    } catch (error) {
      if (mounted) renderInlineError(form, error.message || '保存失败');
    }
  }

  async function deleteWord(id) {
    const index = words.findIndex(word => String(word.id) === id);
    if (index < 0) return;
    const [removed] = words.splice(index, 1);
    total -= 1;
    render();
    const toast = showToast({ message: '已删除', actionLabel: '撤销', duration: deleteUndoMs });
    if ((await toast.closed) === 'action') {
      words.splice(index, 0, removed);
      total += 1;
      render();
      return;
    }
    try {
      await api(`/api/words/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      words.splice(index, 0, removed);
      total += 1;
      render();
      if (mounted) renderInlineError(root, error.message || '删除失败');
    }
  }

  async function review(id, rating, button) {
    for (const item of root.querySelectorAll('[data-action="judge"]')) item.disabled = true;
    const word = reviewWords.find(item => String(item.id) === id);
    const attempt = reviewAttempts.get(id) || {
      reviewId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      version: Number(word?.version || 0),
      rating
    };
    reviewAttempts.set(id, attempt);
    try {
      await api(`/api/words/${encodeURIComponent(id)}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          reviewId: attempt.reviewId,
          rating: attempt.rating,
          version: attempt.version
        })
      });
      reviewAttempts.delete(id);
      reviewWords = reviewWords.filter(word => String(word.id) !== id);
      revealed = false;
      render();
    } catch (error) {
      if (error?.code === 'REVIEW_CONFLICT') {
        reviewAttempts.delete(id);
        await loadReview();
        return;
      }
      if (mounted) {
        renderInlineError(root, error.message || '复习提交失败');
        for (const item of root.querySelectorAll('[data-action="judge"]')) {
          item.disabled = Number(item.dataset.rating) !== attempt.rating;
        }
      }
    }
  }

  async function toggleDetails(id) {
    if (expandedId === id) {
      expandedId = null;
      relations = [];
      relationTargets = [];
      render();
      return;
    }
    expandedId = id;
    try {
      const [relationResult, targetResult] = await Promise.all([
        api(`/api/words/${encodeURIComponent(id)}/relations`),
        api('/api/words?pageSize=100&sort=word')
      ]);
      relations = relationResult.relations || [];
      relationTargets = targetResult.words || [];
      render();
    } catch (error) {
      renderInlineError(root, error.message || '关系加载失败');
    }
  }

  async function onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'toggle-form') {
      editingId = null;
      render();
      root.querySelector('#pc-word-form')?.classList.add('open');
      root.querySelector('#f-en')?.focus();
    }
    if (action === 'cancel-form') { editingId = null; render(); }
    if (action === 'submit-form') saveWord();
    if (action === 'edit') { editingId = target.dataset.id; render(); }
    if (action === 'del') deleteWord(target.dataset.id);
    if (action === 'detail') toggleDetails(target.dataset.id);
    if (action === 'page-prev' && currentPage > 1) { currentPage -= 1; loadLibrary(); }
    if (action === 'page-next') { currentPage += 1; loadLibrary(); }
    if (action === 'play') {
      event.stopPropagation();
      player.speakWord(target.dataset.id, target.dataset.mode, target.dataset.text, {
        rate: speech?.getRate?.() || 1
      });
    }
    if (action === 'reveal' && !event.target.closest('[data-action="play"], [data-action="judge"]')) {
      revealed = true;
      render();
    }
    if (action === 'judge') {
      event.stopPropagation();
      review(target.dataset.id, Number(target.dataset.rating), target);
    }
    if (action === 'delete-relation') {
      await api(`/api/words/${encodeURIComponent(expandedId)}/relations/${encodeURIComponent(target.dataset.id)}`, { method: 'DELETE' });
      toggleDetails(expandedId);
    }
    if (action === 'delete-tag') {
      await api(`/api/tags/${encodeURIComponent(target.dataset.id)}`, { method: 'DELETE' });
      await loadSettings();
    }
    if (action === 'search-relation-targets') {
      const form = target.closest('[data-role="relation-form"]');
      const keyword = form?.elements.targetKeyword.value.trim() || '';
      const result = await api(`/api/words?pageSize=100&sort=word&keyword=${encodeURIComponent(keyword)}`);
      relationTargets = result.words || [];
      render();
    }
  }

  async function onSubmit(event) {
    if (event.target.matches('[data-role="word-filters"]')) {
      event.preventDefault();
      const data = new FormData(event.target);
      filters = {
        keyword: String(data.get('keyword') || '').trim(),
        tag: String(data.get('tag') || ''),
        state: String(data.get('state') || ''),
        due: data.get('due') === 'on'
      };
      currentPage = 1;
      loadLibrary();
    }
    if (event.target.matches('[data-role="relation-form"]')) {
      event.preventDefault();
      const data = new FormData(event.target);
      if (!data.get('targetWordId')) return;
      await api(`/api/words/${encodeURIComponent(event.target.dataset.wordId)}/relations`, {
        method: 'POST',
        body: JSON.stringify({
          targetWordId: data.get('targetWordId'),
          relationType: data.get('relationType'),
          note: data.get('note')
        })
      });
      expandedId = null;
      toggleDetails(event.target.dataset.wordId);
    }
    if (event.target.matches('[data-role="tag-form"]')) {
      event.preventDefault();
      const data = new FormData(event.target);
      await api('/api/tags', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name') })
      });
      await loadSettings();
    }
  }

  function onKeydown(event) {
    const card = event.target.closest('[data-action="reveal"]');
    const nested = event.target.closest('[data-action]')?.dataset.action;
    if (!card || !shouldRevealTestCard(event.key, nested)) return;
    event.preventDefault();
    revealed = true;
    render();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKeydown);
  root.innerHTML = '<div class="pc-empty">加载中…</div>';
  if (page === 'review') loadReview();
  else if (page === 'settings') loadSettings();
  else loadLibrary();

  return () => {
    mounted = false;
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('keydown', onKeydown);
    player.stop?.();
  };
}
