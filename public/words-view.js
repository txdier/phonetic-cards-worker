import { distinctForms, maskWordForms, primaryWord } from './lib/word-display.js';

export function sortWordTestQueue(words) {
  return [...words].sort((a, b) => a.familiarity - b.familiarity || b.created_at - a.created_at);
}

export function nextFamiliarity(current, remembered) {
  return remembered ? Math.min(4, current + 1) : 0;
}

export function isRevealKey(key) {
  return key === 'Enter' || key === ' ';
}

export function shouldRevealTestCard(key, nestedAction = '') {
  return isRevealKey(key) && nestedAction !== 'play' && nestedAction !== 'judge';
}

export function createWordsView({ root, api, speech }) {
  let words = [];
  let mode = 'learn';
  let slowMode = false;
  let testIndex = 0;
  let testRevealed = false;
  let mounted = true;

  const escapeHtml = value => {
    const element = document.createElement('div');
    element.textContent = value || '';
    return element.innerHTML;
  };

  function parseStress(raw) {
    if (!raw) return null;
    return raw.split('-').map(part => ({
      text: part,
      stressed: part === part.toUpperCase() && /[A-Z]/.test(part)
    }));
  }

  function renderStressWord(en, stressRaw) {
    const parsed = parseStress(stressRaw);
    if (!parsed) return escapeHtml(en);
    return parsed.map(part => part.stressed
      ? `<span class="stress">${escapeHtml(part.text.toLowerCase())}</span>`
      : escapeHtml(part.text.toLowerCase())).join('');
  }

  function renderWordForms(word) {
    const forms = distinctForms(word).map(escapeHtml);
    return forms.length ? `<div class="pc-word-forms">词形：${forms.join(' · ')}</div>` : '';
  }

  function playIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  }

  function familiarityDots(value) {
    let html = '<div class="pc-familiarity" aria-label="熟悉度">';
    for (let index = 0; index < 4; index += 1) {
      html += `<div class="pc-dot${index < value ? ' on' : ''}"></div>`;
    }
    return `${html}</div>`;
  }

  function dueCount() {
    return words.filter(word => word.familiarity < 3).length;
  }

  function testQueue() {
    return sortWordTestQueue(words);
  }

  async function addWord(data) {
    try {
      const created = await api('/api/words', {
        method: 'POST', body: JSON.stringify(data)
      });
      words.unshift(created);
      render();
    } catch {
      alert('保存失败，请检查网络后重试');
    }
  }

  async function deleteWord(id) {
    const previous = words;
    words = words.filter(word => String(word.id) !== id);
    render();
    try {
      await api(`/api/words/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      words = previous;
      render();
    }
  }

  async function judgeWord(id, remembered) {
    const word = words.find(item => String(item.id) === id);
    if (!word) return;
    word.familiarity = nextFamiliarity(word.familiarity, remembered);
    testRevealed = false;
    render();
    try {
      await api(`/api/words/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ familiarity: word.familiarity })
      });
    } catch { /* familiarity remains best effort, matching the original behavior */ }
  }

  function header() {
    return `<div class="pc-header"><div class="pc-eyebrow">PHONETIC CARDS · 语音卡片</div><div class="pc-title">记词本</div><div class="pc-sub">共 <b>${words.length}</b> 词 · <b>${dueCount()}</b> 个待巩固</div></div>
      <div class="pc-toolbar"><div class="pc-tabs" aria-label="学习模式">
        <button class="pc-tab ${mode === 'learn' ? 'active' : ''}" data-action="mode" data-mode="learn">学习模式</button>
        <button class="pc-tab ${mode === 'test' ? 'active' : ''}" data-action="mode" data-mode="test">自测模式</button>
      </div><div class="pc-toolbar-right">
        <label class="pc-slow-toggle"><input type="checkbox" data-action="slow" ${slowMode ? 'checked' : ''}> 慢速朗读</label>
        <button class="pc-addbtn" data-action="toggle-form">+ 添加新词</button>
      </div></div>
      <div class="pc-form" id="pc-word-form"><div><label for="f-en">单词（拼写）</label><input id="f-en" placeholder="confirm"></div>
        <div><label for="f-zh">中文含义</label><input id="f-zh" placeholder="确认"></div>
        <div class="pc-full"><label for="f-stress">重音标注（可选，大写标重音）</label><input id="f-stress" placeholder="con-FIRM"></div>
        <div class="pc-full"><label for="f-example">例句（可选）</label><textarea id="f-example" rows="2"></textarea></div>
        <div class="pc-form-actions"><button class="pc-btn-ghost" data-action="cancel-form">取消</button><button class="pc-btn-primary" data-action="submit-form">添加</button></div>
      </div>`;
  }

  function learnBody() {
    return `<div class="pc-grid">${words.map(word => `<div class="pc-card" data-id="${word.id}"><div class="pc-card-top"><div>
      <div class="pc-word">${renderStressWord(primaryWord(word), word.stress)}</div>${renderWordForms(word)}<div class="pc-zh">${escapeHtml(word.zh)}</div></div>
      <button class="pc-del" data-action="del" data-id="${word.id}" aria-label="删除 ${escapeHtml(primaryWord(word))}">×</button></div>
      ${word.example ? `<div class="pc-example">${escapeHtml(word.example)}</div>` : ''}
      <div class="pc-card-footer"><div class="pc-controls"><button class="pc-play" data-action="play" data-text="${escapeHtml(primaryWord(word))}" data-id="${word.id}" aria-label="朗读单词">${playIcon()}</button>
      ${word.example ? `<button class="pc-play" data-action="play" data-text="${escapeHtml(word.example)}" data-id="${word.id}-ex" aria-label="朗读例句">${playIcon()}</button>` : ''}<div class="pc-wave" id="wave-${word.id}"><span></span><span></span><span></span><span></span></div></div>${familiarityDots(word.familiarity)}</div></div>`).join('')}</div>`;
  }

  function testBody() {
    const queue = testQueue();
    if (testIndex >= queue.length) testIndex = 0;
    const word = queue[testIndex];
    if (!word) return '<div class="pc-empty">暂无生词可自测。</div>';
    return `<div class="pc-test-wrap"><div class="pc-testcard" data-action="reveal" tabindex="0"><div class="pc-zh">${escapeHtml(word.zh)}</div>
      ${word.example ? `<div class="pc-example">${escapeHtml(maskWordForms(word.example, word))}</div>` : ''}
      <div class="pc-controls pc-controls-center"><button class="pc-play" data-action="play" data-text="${escapeHtml(primaryWord(word))}" data-id="${word.id}" aria-label="朗读单词">${playIcon()}</button><div class="pc-wave" id="wave-${word.id}"><span></span><span></span><span></span><span></span></div></div>
      ${testRevealed ? `<div class="pc-reveal"><div class="pc-word">${renderStressWord(primaryWord(word), word.stress)}</div>${renderWordForms(word)}<div class="pc-judge"><button class="yes" data-action="judge" data-id="${word.id}" data-ok="1">记得 ✓</button><button class="no" data-action="judge" data-id="${word.id}" data-ok="0">没想起来</button></div></div>` : '<div class="pc-hint-tap">点击卡片查看拼写</div>'}</div><div class="pc-test-count">第 ${testIndex + 1} / ${queue.length} 个</div></div>`;
  }

  function render() {
    if (!mounted) return;
    root.innerHTML = header() + (words.length === 0
      ? '<div class="pc-empty">还没有生词。点击“添加新词”记下第一个吧。</div>'
      : mode === 'learn' ? learnBody() : testBody());
    if (!speech.isSupported) {
      const unavailable = document.createElement('div');
      unavailable.className = 'pc-speech-unavailable';
      unavailable.dataset.role = 'speech-unavailable';
      unavailable.setAttribute('role', 'status');
      unavailable.textContent = '当前浏览器不支持语音朗读，其他功能仍可正常使用。';
      root.querySelector('.pc-header')?.after(unavailable);
      for (const button of root.querySelectorAll('[data-action="play"]')) button.disabled = true;
      const slow = root.querySelector('[data-action="slow"]');
      if (slow) slow.disabled = true;
    }
  }

  function onClick(event) {
    const actionNode = event.target.closest('[data-action]');
    if (!actionNode || !root.contains(actionNode)) return;
    const action = actionNode.dataset.action;
    if (action === 'mode') { mode = actionNode.dataset.mode; testRevealed = false; testIndex = 0; render(); }
    if (action === 'toggle-form') root.querySelector('#pc-word-form')?.classList.toggle('open');
    if (action === 'cancel-form') root.querySelector('#pc-word-form')?.classList.remove('open');
    if (action === 'submit-form') {
      const data = {
        en: root.querySelector('#f-en').value,
        zh: root.querySelector('#f-zh').value,
        stress: root.querySelector('#f-stress').value,
        example: root.querySelector('#f-example').value
      };
      if (!data.en.trim() || !data.zh.trim()) { alert('请至少填写单词和中文含义'); return; }
      addWord(data);
      root.querySelector('#pc-word-form').classList.remove('open');
    }
    if (action === 'del') { event.stopPropagation(); deleteWord(actionNode.dataset.id); }
    if (action === 'play') {
      event.stopPropagation();
      const wave = root.querySelector(`#wave-${CSS.escape(actionNode.dataset.id)}`) || actionNode.parentElement.querySelector('.pc-wave');
      speech.speakOnce(actionNode.dataset.text, {
        rate: slowMode ? 0.5 : speech.getRate?.() || 1,
        onStart: () => wave?.classList.add('playing'),
        onEnd: () => wave?.classList.remove('playing')
      });
    }
    if (action === 'reveal' && !event.target.closest('[data-action="play"], [data-action="judge"]')) { testRevealed = true; render(); }
    if (action === 'judge') { event.stopPropagation(); judgeWord(actionNode.dataset.id, actionNode.dataset.ok === '1'); }
  }

  function onChange(event) {
    if (event.target.matches('[data-action="slow"]')) slowMode = event.target.checked;
  }

  function onKeydown(event) {
    const card = event.target.closest('[data-action="reveal"]');
    const nestedAction = event.target.closest('[data-action]')?.dataset.action;
    if (!card || !root.contains(card) || !shouldRevealTestCard(event.key, nestedAction)) return;
    event.preventDefault();
    testRevealed = true;
    render();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKeydown);
  root.innerHTML = '<div class="pc-empty">加载中…</div>';
  api('/api/words').then(result => { words = result; render(); }).catch(() => { words = []; render(); });

  return () => {
    mounted = false;
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKeydown);
    speech.stop?.();
  };
}
