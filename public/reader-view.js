import { findTermMatches, normalizeTerm, splitSentences, validateSelection } from './lib/text.js';
import { mountConversionForm } from './pending-view.js';
import { createReadingSession } from './lib/reading-session.js';
import { renderInlineError, showToast } from './lib/dom.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(action, text, className = 'pc-btn-ghost') {
  const node = element('button', className, text);
  node.type = 'button';
  node.dataset.action = action;
  return node;
}

function wordCandidates(words) {
  const candidates = [];
  for (const word of words || []) {
    const seen = new Set();
    const add = normalizedText => {
      const normalized = normalizeTerm(normalizedText);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push({ id: word.id, normalizedText: normalized, status: 'word', payload: word });
    };
    add(word.lemma || word.en);
    add(word.en);
    for (const form of word.forms || []) add(form.normalized_form || form.form);
  }
  return candidates;
}

function highlightCandidates(article) {
  return [
    ...(article.pending_terms || []).map(term => ({
      id: term.id,
      normalizedText: term.normalized_text,
      status: 'pending',
      payload: term
    })),
    ...wordCandidates(article.words)
  ];
}

function sentenceNodeFor(node, root) {
  let current = node?.nodeType === 3 ? node.parentElement : node;
  while (current && current !== root) {
    if (current.dataset?.sentenceIndex != null) return current;
    current = current.parentElement;
  }
  return null;
}

function localMarking(article, termId) {
  return (article.markings || []).find(marking => marking.marked_term_id === termId) || null;
}

function localWordMarking(article, wordId) {
  return (article.markings || []).find(marking => marking.word_id === wordId) || null;
}

const POPOVER_ICONS = {
  close: ['M6 6l12 12M18 6L6 18'],
  bookmark: ['M6 3h12v18l-6-4.5L6 21V3z'],
  check: ['M5 13l4 4L19 7'],
  volume: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7'],
  play: ['M10 8.5l6 3.5-6 3.5v-7z', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z']
};

function svgIcon(name, { filled = false } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', filled ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  for (const definition of POPOVER_ICONS[name] || []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

function iconButton(action, label, icon, className = 'pc-popover-icon-button', filled = false) {
  const node = actionButton(action, '', className);
  node.setAttribute('aria-label', label);
  node.append(svgIcon(icon, { filled }));
  return node;
}

function labeledIconButton(action, label, icon, className = 'pc-btn-ghost') {
  const node = actionButton(action, '', className);
  node.append(svgIcon(icon), document.createTextNode(label));
  return node;
}

function assignDataset(node, values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value != null) node.dataset[key] = String(value);
  }
  return node;
}

export function createReaderView({
  root, api, articleId, navigate, speech, tts = null, progressQueue = null, progressRuntime = {}
}) {
  let mounted = true;
  let article = null;
  let sentences = [];
  let loadVersion = 0;
  let conversionCleanup = null;
  let conversionBusy = false;
  let conversionGeneration = 0;
  let unsubscribeSpeech = null;
  let restoringPosition = false;
  let positionRestored = false;
  let popoverTrigger = null;
  let previousSpeechState = null;
  let fullSpeechActive = false;
  let manualSpeechStop = false;
  let suppressNextSentenceClick = false;
  let progressSubmissionId = 0;
  let lastProgressFailureId = 0;
  let lastProgressSuccessId = 0;
  let selectionTimer = null;
  let speechState = 'idle';
  let activeAloudSentenceIndex = null;
  let lastAutoFollowedSentenceIndex = null;
  let savedAloudSentenceIndex = null;
  let speechToolbarOffscreen = false;
  let speechToolbarObserver = null;
  let startSelectionMode = false;
  const runtime = {
    now: progressRuntime.now || (() => Date.now()),
    randomUUID: progressRuntime.randomUUID || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`),
    setInterval: progressRuntime.setInterval || ((callback, delay) => window.setInterval(callback, delay)),
    clearInterval: progressRuntime.clearInterval || (timer => window.clearInterval(timer)),
    setTimeout: progressRuntime.setTimeout || ((callback, delay) => window.setTimeout(callback, delay)),
    clearTimeout: progressRuntime.clearTimeout || (timer => window.clearTimeout(timer)),
    requestAnimationFrame: progressRuntime.requestAnimationFrame || (callback => window.requestAnimationFrame?.(callback) || window.setTimeout(callback, 0)),
    prefersReducedMotion: progressRuntime.prefersReducedMotion || (
      () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    ),
    createIntersectionObserver: progressRuntime.createIntersectionObserver || (
      typeof globalThis.IntersectionObserver === 'function'
        ? ((callback, options) => new globalThis.IntersectionObserver(callback, options))
        : null
    )
  };
  const readingSession = createReadingSession({ now: runtime.now });
  readingSession.setVisible(document.visibilityState !== 'hidden');
  let progressTimer = null;

  function speakSentence(sentenceNode) {
    const index = Number(sentenceNode?.dataset.sentenceIndex);
    if (!Number.isInteger(index)) return;
    if (tts?.speakArticleSentence) {
      tts.speakArticleSentence(articleId, index, sentenceNode.textContent, {
        rate: (tts || speech).getRate?.() || 1,
        nextIndex: index + 1 < sentences.length ? index + 1 : null
      });
    } else {
      speech.speakOnce(sentenceNode.textContent);
    }
  }

  function startFullReading(index) {
    setStartSelectionMode(false);
    if (tts?.startArticle) {
      tts.startArticle(
        articleId,
        sentences.map(sentence => sentence.text),
        index,
        { onState: applySpeechState }
      );
    } else {
      speech.startAt(index);
    }
  }

  function currentPositionRatio() {
    const height = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
    const maximum = Math.max(0, height - (window.innerHeight || 0));
    return maximum ? Math.max(0, Math.min(1, (window.scrollY || 0) / maximum)) : 0;
  }

  function queueEvent(type, amount = 1) {
    if (!progressQueue) return;
    submitProgress({
      kind: 'event', articleId,
      event: { id: runtime.randomUUID(), type, amount }
    });
  }

  function submitProgress(item) {
    if (!progressQueue) return;
    const submissionId = ++progressSubmissionId;
    Promise.resolve(progressQueue.submit(item)).then(sent => {
      if (!mounted) return;
      if (sent === false) {
        if (submissionId < lastProgressSuccessId) return;
        lastProgressFailureId = Math.max(lastProgressFailureId, submissionId);
        showError('阅读进度已暂存，将在网络恢复后自动重试。', 'progress');
      } else {
        lastProgressSuccessId = Math.max(lastProgressSuccessId, submissionId);
        clearProgressError(submissionId);
      }
    }).catch(() => {
      if (!mounted) return;
      if (submissionId < lastProgressSuccessId) return;
      lastProgressFailureId = Math.max(lastProgressFailureId, submissionId);
      showError('阅读进度已暂存，将在网络恢复后自动重试。', 'progress');
    });
  }

  function saveProgress() {
    if (!article || !progressQueue) return;
    let activeMs = readingSession.flushActiveMs();
    while (activeMs > 0) {
      const amount = Math.min(60_000, activeMs);
      queueEvent('active_ms', amount);
      activeMs -= amount;
    }
    const currentAloudIndex = fullSpeechActive && Number.isInteger(activeAloudSentenceIndex)
      ? activeAloudSentenceIndex
      : savedAloudSentenceIndex;
    submitProgress({
      kind: 'position',
      articleId,
      lastPositionRatio: currentPositionRatio(),
      lastAloudSentenceIndex: currentAloudIndex
    });
  }

  function restorePosition() {
    if (positionRestored || !article) return;
    positionRestored = true;
    const ratio = Math.max(0, Math.min(1, Number(article.progress?.last_position_ratio) || 0));
    restoringPosition = true;
    readingSession.updatePosition(ratio);
    runtime.requestAnimationFrame(() => {
      if (!mounted) return;
      const height = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
      const maximum = Math.max(0, height - (window.innerHeight || 0));
      window.scrollTo?.({ top: maximum * ratio, behavior: 'auto' });
      runtime.requestAnimationFrame(() => { restoringPosition = false; });
    });
  }

  function isCurrent(version = loadVersion) {
    return mounted && version === loadVersion;
  }

  function clearTransient() {
    conversionGeneration += 1;
    conversionCleanup?.();
    conversionCleanup = null;
    conversionBusy = false;
  }

  function showError(message, kind = 'operation') {
    const current = root.querySelector('[data-role="reader-error"]');
    if (kind === 'progress' && current?.dataset.errorKind === 'operation') return;
    renderInlineError(root, message || '操作失败，请重试');
    const target = root.querySelector(':scope > [data-inline-error]');
    target.dataset.role = 'reader-error';
    target.dataset.errorKind = kind;
  }

  function clearProgressError(submissionId) {
    if (submissionId < lastProgressFailureId) return;
    const target = root.querySelector('[data-role="reader-error"]');
    if (target?.dataset.errorKind === 'progress') target.remove();
  }

  function renderSentence(sentence, candidates) {
    const sentenceNode = element('span', 'pc-reader-sentence');
    sentenceNode.dataset.sentenceIndex = String(sentence.index);
    sentenceNode.tabIndex = 0;
    sentenceNode.setAttribute('role', 'button');
    const matches = findTermMatches(sentence.text, candidates);
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) sentenceNode.append(document.createTextNode(sentence.text.slice(offset, match.start)));
      const term = actionButton('term', match.text, `pc-term pc-term-${match.status}`);
      term.dataset.termId = match.id;
      term.dataset.termStatus = match.status;
      term.dataset.normalizedText = normalizeTerm(match.normalizedText);
      sentenceNode.append(term);
      offset = match.end;
    }
    if (offset < sentence.text.length) sentenceNode.append(document.createTextNode(sentence.text.slice(offset)));
    sentenceNode.setAttribute('aria-label', `朗读本句：${sentence.text.trim()}`);
    return sentenceNode;
  }

  function renderBody(container) {
    const body = element('div', 'pc-reader-text');
    body.dataset.role = 'reader-text';
    const candidates = highlightCandidates(article);
    for (const sentence of sentences) {
      if (sentence.index === savedAloudSentenceIndex) {
        const marker = element('span', 'pc-aloud-resume-marker', '上次暂停');
        marker.dataset.role = 'aloud-resume-marker';
        marker.setAttribute('aria-hidden', 'true');
        body.append(marker);
      }
      body.append(renderSentence(sentence, candidates));
    }
    container.append(body);
  }

  function speechToolbar() {
    const audioController = tts || speech;
    const speechAvailable = Boolean(audioController?.isSupported);
    const toolbar = element('section', 'pc-reader-speech');
    toolbar.dataset.role = 'speech-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '文章语音朗读');
    for (const [action, label] of [
      ['speech-play', '播放'], ['speech-pause', '暂停'], ['speech-resume', '继续'], ['speech-stop', '停止']
    ]) {
      const button = actionButton(action, label);
      button.dataset.speechControl = '';
      button.disabled = !speechAvailable;
      toolbar.append(button);
    }
    const rateLabel = element('label', 'pc-speech-field');
    rateLabel.append(document.createTextNode('语速'));
    const rate = element('input');
    rate.type = 'range';
    rate.min = '0.5';
    rate.max = '1.5';
    rate.step = '0.5';
    rate.value = String(audioController.getRate?.() || speech.getRate?.() || 1);
    rate.dataset.action = 'speech-rate';
    rate.dataset.speechControl = '';
    rate.setAttribute('aria-label', '朗读语速');
    rate.disabled = !speechAvailable;
    const rateValue = element('output', 'pc-speech-rate-value', `${Number(rate.value)}×`);
    rateValue.dataset.role = 'speech-rate-value';
    rateLabel.append(rate, rateValue);
    toolbar.append(rateLabel);
    const status = element('div', 'pc-speech-status');
    status.dataset.role = 'speech-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(status);
    if (!speechAvailable) {
      const unavailable = element('div', 'pc-speech-unavailable', '当前浏览器不支持语音朗读，文章阅读和标记仍可正常使用。');
      unavailable.dataset.role = 'speech-unavailable';
      unavailable.setAttribute('role', 'status');
      toolbar.append(unavailable);
    }
    return toolbar;
  }

  function resumeEntry() {
    const host = element('section', 'pc-aloud-resume-entry');
    host.dataset.role = 'aloud-resume-entry';
    host.hidden = !Number.isInteger(savedAloudSentenceIndex);
    if (host.hidden) return host;
    const sentence = sentences[savedAloudSentenceIndex];
    const snippet = sentence?.text.trim() || '';
    host.append(
      element('span', 'pc-aloud-resume-copy',
        `上次朗读：第 ${savedAloudSentenceIndex + 1} 句 “${snippet}”`),
      actionButton('speech-jump-resume', '跳转')
    );
    return host;
  }

  function floatingSpeechControls() {
    const capsule = element('section', 'pc-floating-speech');
    capsule.dataset.role = 'floating-speech';
    capsule.setAttribute('role', 'group');
    capsule.setAttribute('aria-label', '悬浮朗读控制');
    capsule.hidden = true;
    const action = floatingSpeechAction();
    const toggle = actionButton('speech-floating-toggle', action.label, 'pc-floating-speech-action');
    toggle.dataset.role = 'floating-speech-toggle';
    toggle.setAttribute('aria-label', action.ariaLabel);
    const rate = actionButton('speech-rate-cycle', '1×', 'pc-floating-speech-action');
    rate.dataset.role = 'floating-speech-rate';
    rate.setAttribute('aria-label', '切换朗读语速，当前 1 倍');
    capsule.append(toggle, element('span', 'pc-floating-speech-divider'), rate);
    return capsule;
  }

  function bottomPanelOpen() {
    return Boolean(root.querySelector(
      '[data-role="selection-action"], [data-role="term-popover"], [data-role="conversion-panel"]'
    ));
  }

  function setStartSelectionMode(enabled) {
    startSelectionMode = Boolean(enabled);
    root.classList.toggle('pc-reader-start-selecting', startSelectionMode);
    const hint = root.querySelector('[data-role="reader-start-hint"]');
    if (hint) hint.hidden = !startSelectionMode;
    syncSpeechControls();
  }

  function floatingSpeechAction() {
    if (speechState === 'speaking') {
      return { label: '暂停', ariaLabel: '暂停全文朗读' };
    }
    if (speechState === 'paused' || Number.isInteger(savedAloudSentenceIndex)) {
      return { label: '继续', ariaLabel: '继续全文朗读' };
    }
    if (startSelectionMode) {
      return { label: '取消选择', ariaLabel: '取消选择全文朗读起点' };
    }
    return { label: '选择起点', ariaLabel: '选择全文朗读起点' };
  }

  function syncSpeechControls() {
    const rate = Number((tts || speech).getRate?.() || speech.getRate?.() || 1);
    const topRate = root.querySelector('[data-action="speech-rate"]');
    const topOutput = root.querySelector('[data-role="speech-rate-value"]');
    if (topRate) topRate.value = String(rate);
    if (topOutput) topOutput.textContent = `${rate}×`;
    const floatingRate = root.querySelector('[data-role="floating-speech-rate"]');
    if (floatingRate) {
      floatingRate.textContent = `${rate}×`;
      floatingRate.setAttribute('aria-label', `切换朗读语速，当前 ${rate} 倍`);
    }
    const toggle = root.querySelector('[data-role="floating-speech-toggle"]');
    if (toggle) {
      const action = floatingSpeechAction();
      toggle.textContent = action.label;
      toggle.setAttribute('aria-label', action.ariaLabel);
    }
    const floating = root.querySelector('[data-role="floating-speech"]');
    if (floating) {
      const hasAvailableAction =
        speechState === 'speaking' ||
        speechState === 'paused' ||
        speechState === 'idle';
      floating.hidden = !(
        speechToolbarOffscreen &&
        hasAvailableAction &&
        !bottomPanelOpen()
      );
    }
  }

  function observeSpeechToolbar() {
    speechToolbarObserver?.disconnect?.();
    speechToolbarObserver = null;
    const toolbar = root.querySelector('[data-role="speech-toolbar"]');
    if (!toolbar) return;
    if (runtime.createIntersectionObserver) {
      speechToolbarObserver = runtime.createIntersectionObserver(entries => {
        if (!mounted) return;
        speechToolbarOffscreen = !entries[entries.length - 1]?.isIntersecting;
        syncSpeechControls();
      }, { threshold: 0 });
      speechToolbarObserver.observe(toolbar);
    } else {
      speechToolbarOffscreen = toolbar.getBoundingClientRect().bottom <= 0;
    }
  }

  function setSavedAloudIndex(index) {
    savedAloudSentenceIndex = Number.isInteger(index) && index >= 0 && index < sentences.length
      ? index
      : null;
    if (article?.progress) article.progress.last_aloud_sentence_index = savedAloudSentenceIndex;
    const previousEntry = root.querySelector('[data-role="aloud-resume-entry"]');
    if (previousEntry) previousEntry.replaceWith(resumeEntry());
    root.querySelector('[data-role="aloud-resume-marker"]')?.remove();
    if (Number.isInteger(savedAloudSentenceIndex)) {
      const sentence = root.querySelector(`[data-sentence-index="${savedAloudSentenceIndex}"]`);
      if (sentence) {
        const marker = element('span', 'pc-aloud-resume-marker', '上次暂停');
        marker.dataset.role = 'aloud-resume-marker';
        marker.setAttribute('aria-hidden', 'true');
        sentence.before(marker);
      }
    }
  }

  function locateSentence(index) {
    const sentence = root.querySelector(`[data-sentence-index="${index}"]`);
    if (!sentence) return;
    sentence.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    sentence.focus?.({ preventScroll: true });
  }

  function followSpeakingSentence(index) {
    if (!Number.isInteger(index) || index === lastAutoFollowedSentenceIndex) return;
    lastAutoFollowedSentenceIndex = index;
    runtime.requestAnimationFrame(() => {
      if (!mounted || speechState !== 'speaking' || activeAloudSentenceIndex !== index) return;
      const sentence = root.querySelector(`[data-sentence-index="${index}"]`);
      if (!sentence) return;
      const rect = sentence.getBoundingClientRect();
      const viewportHeight = window.innerHeight || 0;
      const safeTop = viewportHeight * 0.15;
      const safeBottom = viewportHeight * 0.78;
      if (rect.top >= safeTop && rect.bottom <= safeBottom) return;
      const top = Math.max(
        0,
        (window.scrollY || 0) + rect.top - (viewportHeight * 0.32)
      );
      window.scrollTo?.({
        top,
        behavior: runtime.prefersReducedMotion() ? 'auto' : 'smooth'
      });
    });
  }

  function applySpeechState(next) {
    for (const sentence of root.querySelectorAll('[data-sentence-index]')) {
      const speaking = next?.state === 'speaking'
        && Number(sentence.dataset.sentenceIndex) === next.currentIndex;
      sentence.classList.toggle('pc-sentence-speaking', speaking);
    }
    const nextState = next?.state || 'idle';
    speechState = nextState;
    if (
      (nextState === 'speaking' || nextState === 'paused') &&
      Number.isInteger(next?.currentIndex)
    ) {
      activeAloudSentenceIndex = next.currentIndex;
    }
    if (nextState === 'paused') {
      fullSpeechActive = true;
      setSavedAloudIndex(activeAloudSentenceIndex);
      saveProgress();
    } else if (nextState === 'idle' && next?.completion?.reachedEnd) {
      setSavedAloudIndex(null);
      activeAloudSentenceIndex = null;
      saveProgress();
    }
    const status = root.querySelector('[data-role="speech-status"]');
    if (previousSpeechState == null) {
      previousSpeechState = nextState;
    } else if (status) {
      let announcement = '';
      if (nextState === 'once' && previousSpeechState !== 'once') {
        fullSpeechActive = false;
        announcement = '正在朗读所选内容';
      } else if (nextState === 'paused' && previousSpeechState !== 'paused') {
        announcement = '全文朗读已暂停';
      } else if (nextState === 'speaking') {
        if (previousSpeechState === 'paused') announcement = '继续全文朗读';
        else if (!fullSpeechActive) announcement = '开始全文朗读';
        fullSpeechActive = true;
        manualSpeechStop = false;
      } else if (nextState === 'idle' && previousSpeechState !== 'idle') {
        if (previousSpeechState === 'once') announcement = '所选内容朗读结束';
        else if (next?.completion?.reachedEnd) announcement = '全文朗读完成';
        else if (manualSpeechStop) announcement = '全文朗读已停止';
        else if (fullSpeechActive) announcement = '全文朗读已中断';
        fullSpeechActive = false;
        manualSpeechStop = false;
      }
      if (announcement && status.textContent !== announcement) status.textContent = announcement;
      previousSpeechState = nextState;
    }
    if (next?.completionEvent?.counted) {
      if (readingSession.markReadAloudComplete().readAloudCompleted) queueEvent('read_aloud_complete');
    }
    if (nextState === 'speaking' && Number.isInteger(next?.currentIndex)) {
      followSpeakingSentence(next.currentIndex);
    } else if (nextState !== 'speaking') {
      lastAutoFollowedSentenceIndex = null;
    }
    syncSpeechControls();
  }

  function render() {
    if (fullSpeechActive) {
      setSavedAloudIndex(activeAloudSentenceIndex);
      saveProgress();
    }
    clearTransient();
    setStartSelectionMode(false);
    suppressNextSentenceClick = false;
    root.replaceChildren();
    const header = element('header', 'pc-reader-header');
    header.append(actionButton('back-library', '返回文章库'));
    header.append(element('h1', 'pc-reader-title', article.title));
    const meta = element('div', 'pc-article-meta');
    if (article.author) meta.append(element('span', '', `作者：${article.author}`));
    if (article.source) meta.append(element('span', '', `来源：${article.source}`));
    header.append(meta);
    header.append(speechToolbar());
    header.append(resumeEntry());
    const content = element('article', 'pc-reader-content');
    const startHint = element(
      'div',
      'pc-reader-start-hint',
      '请选择开始全文朗读的句子'
    );
    startHint.dataset.role = 'reader-start-hint';
    startHint.setAttribute('role', 'status');
    startHint.hidden = !startSelectionMode;
    content.append(startHint);
    renderBody(content);
    const selectionHost = element('div', 'pc-selection-host');
    selectionHost.dataset.role = 'selection-host';
    const popoverHost = element('div', 'pc-popover-host');
    popoverHost.dataset.role = 'popover-host';
    root.append(header, content, selectionHost, popoverHost, floatingSpeechControls());
    (tts || speech).stop?.();
    speech.load(sentences.map(sentence => sentence.text));
    restorePosition();
    observeSpeechToolbar();
    syncSpeechControls();
  }

  async function load() {
    const version = ++loadVersion;
    clearTransient();
    closeSelection();
    try {
      const next = await api(`/api/articles/${encodeURIComponent(articleId)}`);
      if (!isCurrent(version)) return;
      article = next;
      sentences = splitSentences(article.body);
      const loadedAloudIndex = article.progress?.last_aloud_sentence_index;
      setSavedAloudIndex(
        Number.isInteger(loadedAloudIndex) && loadedAloudIndex < sentences.length
          ? loadedAloudIndex
          : null
      );
      render();
    } catch (error) {
      if (!isCurrent(version)) return;
      root.replaceChildren(element('div', 'pc-page-error', error.message || '文章加载失败'));
    }
  }

  function triggerContext(trigger, fallback = {}) {
    const sentence = sentenceNodeFor(trigger, root);
    const rect = trigger?.getBoundingClientRect?.() || fallback.rect || null;
    return {
      sentenceIndex: sentence ? Number(sentence.dataset.sentenceIndex) : fallback.sentenceIndex,
      contextSentence: sentence?.textContent || fallback.contextSentence || '',
      speechText: trigger?.textContent || fallback.speechText || '',
      displayText: trigger?.textContent || fallback.displayText || '',
      rect
    };
  }

  function placePopover(panel, rect) {
    if (!rect || !Number.isFinite(rect.left)) return;
    const top = Number.isFinite(rect.bottom) ? rect.bottom : Number.isFinite(rect.top) ? rect.top : 0;
    panel.dataset.anchorLeft = String(rect.left);
    panel.dataset.anchorTop = String(top);
    panel.style.setProperty('--popover-left', `${rect.left}px`);
    panel.style.setProperty('--popover-top', `${top}px`);
  }

  function buildReaderPopover({
    role, ariaLabel, displayText, marked, termState, closeAction, bookmarkAction, bookmarkData,
    pronounceAction, startReadingAction = 'speech-start-popover', sentenceIndex, speechText, contextSentence, normalizedText,
    headDetails = [], body, rect
  }) {
    const className = role === 'selection-action'
      ? 'pc-reader-popover pc-selection-action'
      : 'pc-reader-popover pc-term-popover';
    const panel = element('section', className);
    panel.dataset.role = role;
    panel.dataset.termState = termState;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', ariaLabel);
    assignDataset(panel, { sentenceIndex, speechText, contextSentence, normalizedText, selectedText: displayText });
    if (termState === 'marked' || termState === 'saved') {
      const ribbon = element('span', 'pc-reader-popover-ribbon');
      ribbon.dataset.role = 'reader-popover-ribbon';
      ribbon.setAttribute('aria-hidden', 'true');
      panel.append(ribbon);
    }

    const close = iconButton(closeAction, '关闭', 'close', 'pc-popover-icon-button pc-reader-popover-close');
    const head = element('header', 'pc-reader-popover-head');
    head.dataset.role = 'reader-popover-head';
    const wordBlock = element('div', 'pc-reader-popover-word-block');
    const wordRow = element('div', 'pc-reader-popover-word-row');
    const word = element('strong', 'pc-reader-popover-word', displayText);
    word.dataset.role = 'reader-popover-word';
    const bookmark = iconButton(
      bookmarkAction,
      marked ? '取消本篇标记' : '标记生词',
      'bookmark',
      `pc-popover-icon-button pc-reader-popover-bookmark${marked ? ' active' : ''}`,
      marked
    );
    bookmark.dataset.role = 'reader-popover-bookmark';
    bookmark.setAttribute('aria-pressed', String(Boolean(marked)));
    assignDataset(bookmark, bookmarkData);
    wordRow.append(word, bookmark);
    wordBlock.append(wordRow, ...headDetails);
    head.append(wordBlock);

    const bodyNode = body || element('div');
    bodyNode.classList.add('pc-reader-popover-body');
    bodyNode.dataset.role = 'reader-popover-body';
    const tools = element('div', 'pc-selection-reading pc-reader-popover-tools');
    tools.dataset.role = 'reader-popover-tools';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', '朗读工具');
    const pronounce = labeledIconButton(pronounceAction, '发音', 'volume');
    pronounce.dataset.text = speechText;
    pronounce.dataset.speechControl = '';
    pronounce.disabled = !speech.isSupported;
    const readFromSentence = labeledIconButton(startReadingAction, '从本句开始全文朗读', 'play');
    readFromSentence.dataset.speechControl = '';
    readFromSentence.disabled = !speech.isSupported || !Number.isInteger(Number(sentenceIndex));
    tools.append(pronounce, readFromSentence);

    panel.append(
      close,
      head,
      element('div', 'pc-reader-popover-divider'),
      bodyNode,
      element('div', 'pc-reader-popover-divider'),
      tools
    );
    placePopover(panel, rect);
    return panel;
  }

  function readerStatus(state, mainText, subText) {
    const status = element('div', `pc-reader-popover-status pc-reader-popover-status-${state}`);
    status.dataset.role = 'reader-popover-status';
    status.append(svgIcon(state === 'unmarked' ? 'bookmark' : 'check'));
    const copy = element('div');
    copy.append(
      element('div', 'pc-reader-popover-status-main', mainText),
      element('div', 'pc-reader-popover-status-sub', subText)
    );
    status.append(copy);
    return status;
  }

  function renderLookup(buttonNode, word) {
    const host = root.querySelector('[data-role="popover-host"]');
    if (!host) return;
    clearTransient();
    host.replaceChildren();
    const context = triggerContext(buttonNode);
    const marking = localWordMarking(article, word.id);
    const lemma = word.lemma || word.en || '';
    const headDetails = [];
    if (lemma) headDetails.push(element('div', 'pc-lookup-lemma', lemma));
    const forms = (word.forms || []).map(form => form.form).filter(Boolean);
    if (forms.length) headDetails.push(element('div', 'pc-word-forms', `词形：${forms.join(' · ')}`));
    const body = element('div');
    body.append(readerStatus('saved', '已加入记词本', '可在词库中复习'));
    body.append(element('div', 'pc-lookup-meaning', word.zh || ''));
    if (word.example) body.append(element('div', 'pc-example', word.example));
    if (word.stress) body.append(element('div', 'pc-stress-note', word.stress));
    const panel = buildReaderPopover({
      role: 'term-popover',
      ariaLabel: `${context.displayText} 的词卡信息`,
      displayText: context.displayText,
      marked: Boolean(marking),
      termState: 'saved',
      closeAction: 'close-popover',
      bookmarkAction: marking ? 'unmark-local' : 'mark-popover',
      bookmarkData: { markingId: marking?.id },
      pronounceAction: 'pronounce',
      sentenceIndex: context.sentenceIndex,
      speechText: context.speechText,
      contextSentence: context.contextSentence,
      normalizedText: normalizeTerm(lemma || context.displayText),
      headDetails,
      body,
      rect: context.rect
    });
    host.append(panel);
    syncSpeechControls();
    panel.querySelector('[data-role="reader-popover-bookmark"]')?.focus();
  }

  function openConversion(term) {
    const host = root.querySelector('[data-role="popover-host"]');
    if (!host) return;
    const marking = localMarking(article, term.id);
    const conversionTerm = { ...term, context_sentence: marking?.context_sentence || term.context_sentence || '' };
    clearTransient();
    const generation = conversionGeneration;
    conversionCleanup = mountConversionForm({
      host,
      term: conversionTerm,
      api,
      isCurrent: () => mounted && generation === conversionGeneration,
      onBusyChange: value => {
        if (generation === conversionGeneration) conversionBusy = Boolean(value);
      },
      onCancel: closePopover,
      onSuccess: () => { load(); }
    });
    syncSpeechControls();
  }

  function renderPending(term, suppliedContext = null) {
    const host = root.querySelector('[data-role="popover-host"]');
    if (!host) return;
    clearTransient();
    host.replaceChildren();
    const marking = localMarking(article, term.id);
    const context = suppliedContext || triggerContext(popoverTrigger, {
      displayText: term.display_text,
      speechText: term.display_text
    });
    const body = element('div');
    body.append(readerStatus('marked', '已标记 · 待整理', '尚未加入记词本'));
    const actions = element('div', 'pc-popover-actions pc-reader-popover-actions');
    const convert = actionButton('convert-pending', '加入记词本', 'pc-btn-primary');
    convert.dataset.termId = term.id;
    actions.append(convert);
    if (marking) {
      const unmark = actionButton('unmark-local', '取消本篇标记', 'pc-btn-ghost pc-popover-secondary-action');
      unmark.dataset.markingId = marking.id;
      actions.append(unmark);
    }
    body.append(actions);
    const panel = buildReaderPopover({
      role: 'term-popover',
      ariaLabel: `${context.displayText || term.display_text} 的待整理操作`,
      displayText: context.displayText || term.display_text,
      marked: true,
      termState: 'marked',
      closeAction: 'close-popover',
      bookmarkAction: 'unmark-local',
      bookmarkData: { markingId: marking?.id },
      pronounceAction: 'pronounce',
      sentenceIndex: context.sentenceIndex,
      speechText: context.speechText || term.display_text,
      contextSentence: context.contextSentence,
      normalizedText: term.normalized_text,
      body,
      rect: context.rect
    });
    host.append(panel);
    syncSpeechControls();
    panel.querySelector('[data-role="reader-popover-bookmark"]')?.focus();
  }

  function handleTerm(node) {
    popoverTrigger = node;
    if (node.dataset.termStatus === 'word') {
      const word = (article.words || []).find(item => item.id === node.dataset.termId);
      if (word) renderLookup(node, word);
      return;
    }
    const term = (article.pending_terms || []).find(item => item.id === node.dataset.termId);
    if (term) renderPending(term);
  }

  function closePopover() {
    clearTransient();
    root.querySelector('[data-role="popover-host"]')?.replaceChildren();
    syncSpeechControls();
    if (popoverTrigger?.isConnected) popoverTrigger.focus();
  }

  function clearSelectionPanel() {
    root.querySelector('[data-role="selection-host"]')?.replaceChildren();
    suppressNextSentenceClick = false;
    syncSpeechControls();
  }

  function closeSelection() {
    clearSelectionPanel();
    window.getSelection?.()?.removeAllRanges?.();
  }

  function handleSelection() {
    if (!article) return;
    const selection = window.getSelection?.();
    if (!selection || !selection.rangeCount || !selection.toString()) return;
    const startNode = sentenceNodeFor(selection.anchorNode, root);
    const endNode = sentenceNodeFor(selection.focusNode, root);
    const result = validateSelection({
      text: selection.toString(),
      startSentence: startNode ? Number(startNode.dataset.sentenceIndex) : null,
      endSentence: endNode ? Number(endNode.dataset.sentenceIndex) : null
    });
    const host = root.querySelector('[data-role="selection-host"]');
    if (!host) return;
    host.replaceChildren();
    suppressNextSentenceClick = false;
    if (!result.ok || !startNode) {
      const messages = {
        'cross-sentence': '一次只能选择同一句中的文本',
        'no-letters': '请选择包含英文字母的文本',
        'empty-after-trim': '所选内容去除标点后为空',
        'invalid-sentence': '请在文章句子内选择文本'
      };
      showToast({ message: messages[result.reason] || '无法处理这段选中文本', duration: 1800 });
      return;
    }
    const rangeRect = selection.getRangeAt(0)?.getBoundingClientRect?.();
    const body = element('div');
    body.append(readerStatus('unmarked', '未标记', '标记后进入待整理'));
    body.append(actionButton('mark-selection', '标记为生词', 'pc-btn-primary pc-reader-popover-primary-action'));
    const panel = buildReaderPopover({
      role: 'selection-action',
      ariaLabel: `${result.displayText} 的选中文本操作`,
      displayText: result.displayText,
      marked: false,
      termState: 'unmarked',
      closeAction: 'close-selection',
      bookmarkAction: 'mark-selection',
      pronounceAction: 'pronounce-selection',
      startReadingAction: 'speech-start-selection',
      sentenceIndex: Number(startNode.dataset.sentenceIndex),
      speechText: result.displayText,
      contextSentence: startNode.textContent,
      normalizedText: result.normalizedText,
      body,
      rect: rangeRect
    });
    host.append(panel);
    suppressNextSentenceClick = true;
    syncSpeechControls();
  }

  async function markSelection(panel, trigger) {
    if (!panel) return;
    const hasAnchor = panel.dataset.anchorLeft != null && panel.dataset.anchorTop != null;
    const popoverContext = {
      sentenceIndex: Number(panel.dataset.sentenceIndex),
      displayText: panel.dataset.selectedText,
      speechText: panel.dataset.speechText || panel.dataset.selectedText,
      contextSentence: panel.dataset.contextSentence,
      rect: hasAnchor ? {
        left: Number(panel.dataset.anchorLeft),
        bottom: Number(panel.dataset.anchorTop)
      } : null
    };
    trigger.disabled = true;
    try {
      const marking = await api(`/api/articles/${encodeURIComponent(articleId)}/markings`, {
        method: 'POST',
        body: JSON.stringify({
          selectedText: panel.dataset.selectedText,
          normalizedText: panel.dataset.normalizedText,
          contextSentence: panel.dataset.contextSentence
        })
      });
      if (!mounted) return;
      const termId = marking.marked_term_id;
      if (!termId) {
        await load();
        return;
      }
      if (!(article.pending_terms || []).some(term => term.id === termId)) {
        article.pending_terms.push({
          id: termId,
          display_text: marking.selected_text,
          normalized_text: marking.normalized_text,
          kind: /\s/.test(marking.normalized_text) ? 'phrase' : 'word',
          created_at: marking.created_at
        });
      }
      if (!(article.markings || []).some(item => item.id === marking.id)) article.markings.push(marking);
      window.getSelection?.()?.removeAllRanges?.();
      render();
      const renderedSentence = root.querySelector(`[data-sentence-index="${popoverContext.sentenceIndex}"]`);
      popoverTrigger = [...(renderedSentence?.querySelectorAll('.pc-term-pending') || [])]
        .find(node => node.dataset.termId === termId) || null;
      const term = (article.pending_terms || []).find(item => item.id === termId);
      if (term) renderPending(term, popoverContext);
    } catch (error) {
      showError(error.message);
      if (mounted && trigger.isConnected) trigger.disabled = false;
    }
  }

  async function unmarkLocal(markingId, trigger) {
    trigger.disabled = true;
    try {
      await api(`/api/articles/${encodeURIComponent(articleId)}/markings/${encodeURIComponent(markingId)}`, { method: 'DELETE' });
      if (!mounted) return;
      await load();
    } catch (error) {
      if (mounted) showError(error.message);
      if (mounted && trigger.isConnected) trigger.disabled = false;
    }
  }

  function onClick(event) {
    const chosenSentence = event.target.closest?.(
      '[data-role="reader-text"] [data-sentence-index]'
    );
    if (startSelectionMode && chosenSentence && root.contains(chosenSentence)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = Number(chosenSentence.dataset.sentenceIndex);
      setStartSelectionMode(false);
      if (Number.isInteger(index)) startFullReading(index);
      return;
    }
    if (suppressNextSentenceClick && event.target.closest('[data-role="reader-text"]')) {
      suppressNextSentenceClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    readingSession.interact();
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'back-library') navigate({ module: 'articles', page: 'library' });
    if (action === 'term') handleTerm(target);
    if (action === 'pronounce') speech.speakOnce(target.dataset.text);
    if (action === 'pronounce-selection') {
      speech.speakOnce(target.closest('[data-role="selection-action"]')?.dataset.selectedText || '');
    }
    if (action === 'speech-play') {
      startFullReading(0);
    }
    if (action === 'speech-jump-resume' && Number.isInteger(savedAloudSentenceIndex)) {
      locateSentence(savedAloudSentenceIndex);
    }
    if (action === 'speech-start-selection') {
      const panel = target.closest('[data-role="selection-action"]');
      const sentenceIndex = Number(panel?.dataset.sentenceIndex);
      closeSelection();
      if (Number.isInteger(sentenceIndex)) startFullReading(sentenceIndex);
    }
    if (action === 'speech-start-popover') {
      const panel = target.closest('[data-role="selection-action"], [data-role="term-popover"]');
      const sentenceIndex = Number(panel?.dataset.sentenceIndex);
      if (panel?.dataset.role === 'selection-action') closeSelection();
      else closePopover();
      if (Number.isInteger(sentenceIndex)) startFullReading(sentenceIndex);
    }
    if (action === 'speech-pause') (tts || speech).pause();
    if (action === 'speech-resume') {
      if (speechState === 'paused') (tts || speech).resume();
      else if (speechState === 'idle' && Number.isInteger(savedAloudSentenceIndex)) {
        locateSentence(savedAloudSentenceIndex);
        startFullReading(savedAloudSentenceIndex);
      }
    }
    if (action === 'speech-floating-toggle') {
      if (speechState === 'speaking') {
        (tts || speech).pause();
      } else if (speechState === 'paused') {
        (tts || speech).resume();
      } else if (Number.isInteger(savedAloudSentenceIndex)) {
        startFullReading(savedAloudSentenceIndex);
      } else {
        setStartSelectionMode(!startSelectionMode);
      }
    }
    if (action === 'speech-rate-cycle') {
      const current = Number((tts || speech).getRate?.() || 1);
      const nextRate = current < 1 ? 1 : current < 1.5 ? 1.5 : 0.5;
      (tts || speech).setRate(nextRate);
      syncSpeechControls();
    }
    if (action === 'speech-stop') {
      manualSpeechStop = true;
      setSavedAloudIndex(activeAloudSentenceIndex);
      saveProgress();
      (tts || speech).stop();
    }
    if (action === 'close-popover') {
      closePopover();
    }
    if (action === 'close-selection') closeSelection();
    if (action === 'convert-pending') {
      const term = (article.pending_terms || []).find(item => item.id === target.dataset.termId);
      if (term) openConversion(term);
    }
    if (action === 'unmark-local') unmarkLocal(target.dataset.markingId, target);
    if (action === 'mark-selection') markSelection(target.closest('[data-role="selection-action"]'), target);
    if (action === 'mark-popover') markSelection(target.closest('[data-role="term-popover"]'), target);
  }

  function onSentenceClick(event) {
    if (event.target.closest('[data-action], button, input, select, label')) return;
    const panel = root.querySelector('[data-role="selection-action"]');
    if (panel?.contains(event.target)) return;
    const termPanel = root.querySelector('[data-role="term-popover"], [data-role="conversion-panel"]');
    if (termPanel) {
      if (!conversionBusy) closePopover();
      return;
    }
    const sentence = event.target.closest('[data-sentence-index]');
    if (panel && event.target.closest('[data-role="reader-text"]')) {
      closeSelection();
      return;
    }
    if (panel) return;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    if (sentence && root.contains(sentence)) speakSentence(sentence);
  }

  function onInput(event) {
    if (event.target.matches('[data-action="speech-rate"]')) {
      readingSession.interact();
      const appliedRate = (tts || speech).setRate(event.target.value);
      const displayedRate = Number.isFinite(Number(appliedRate)) ? Number(appliedRate) : Number(event.target.value);
      runtime.requestAnimationFrame(syncSpeechControls);
      const output = root.querySelector('[data-role="speech-rate-value"]');
      if (output) output.textContent = `${displayedRate}×`;
    }
  }

  function onPointerUp(event) {
    if (!event.target.closest('[data-role="reader-text"]')) return;
    readingSession.interact();
    handleSelection();
  }

  function onSelectionChange() {
    if (selectionTimer !== null) runtime.clearTimeout(selectionTimer);
    selectionTimer = runtime.setTimeout(() => {
      selectionTimer = null;
      if (!mounted) return;
      const selection = window.getSelection?.();
      if (
        !selection || selection.isCollapsed || !selection.rangeCount
        || !selection.toString().trim()
      ) {
        clearSelectionPanel();
        return;
      }
      const startNode = sentenceNodeFor(selection.anchorNode, root);
      const endNode = sentenceNodeFor(selection.focusNode, root);
      if (!startNode || !endNode || startNode !== endNode) {
        clearSelectionPanel();
        return;
      }
      readingSession.interact();
      handleSelection();
    }, 150);
  }

  function onScroll() {
    if (!article || restoringPosition) return;
    readingSession.interact();
    const result = readingSession.updatePosition(currentPositionRatio());
    if (result.readCompleted) queueEvent('read_complete');
    if (!runtime.createIntersectionObserver) {
      const toolbar = root.querySelector('[data-role="speech-toolbar"]');
      speechToolbarOffscreen = Boolean(toolbar && toolbar.getBoundingClientRect().bottom <= 0);
      syncSpeechControls();
    }
  }

  function onVisibilityChange() {
    readingSession.setVisible(document.visibilityState !== 'hidden');
    if (document.visibilityState === 'hidden' && fullSpeechActive) {
      setSavedAloudIndex(activeAloudSentenceIndex);
    }
    saveProgress();
  }

  function onKeyDown(event) {
    const sentence = event.target.closest?.('[data-sentence-index]');
    if (
      startSelectionMode && event.target === sentence &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      const index = Number(sentence.dataset.sentenceIndex);
      setStartSelectionMode(false);
      if (Number.isInteger(index)) startFullReading(index);
      return;
    }
    if (event.key === 'Escape' && startSelectionMode) {
      event.preventDefault();
      setStartSelectionMode(false);
      return;
    }
    if (event.target === sentence && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      readingSession.interact();
      speakSentence(sentence);
      return;
    }
    if (event.key !== 'Escape') return;
    if (root.querySelector('[data-role="selection-action"]')) {
      event.preventDefault();
      closeSelection();
      return;
    }
    if (conversionBusy && root.querySelector('[data-role="conversion-panel"]')) {
      event.preventDefault();
      return;
    }
    if (!root.querySelector('[data-role="term-popover"], [data-role="conversion-panel"]')) return;
    event.preventDefault();
    closePopover();
  }

  function onDocumentClick(event) {
    const panel = root.querySelector('[data-role="selection-action"], [data-role="term-popover"], [data-role="conversion-panel"]');
    if (
      !panel || panel.contains(event.target) || popoverTrigger?.contains?.(event.target)
      || event.target.closest?.('[data-action="convert-pending"]')
    ) return;
    if (panel.dataset.role === 'selection-action') {
      closeSelection();
      return;
    }
    if (panel.dataset.role === 'conversion-panel' && conversionBusy) return;
    closePopover();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('click', onSentenceClick);
  root.addEventListener('input', onInput);
  root.addEventListener('pointerup', onPointerUp);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  unsubscribeSpeech = speech.subscribe?.(applySpeechState) || null;
  progressTimer = runtime.setInterval(saveProgress, 15_000);
  root.replaceChildren(element('div', 'pc-empty', '加载中…'));
  load();

  return () => {
    if (fullSpeechActive) setSavedAloudIndex(activeAloudSentenceIndex);
    saveProgress();
    mounted = false;
    document.removeEventListener('selectionchange', onSelectionChange);
    if (selectionTimer !== null) runtime.clearTimeout(selectionTimer);
    selectionTimer = null;
    setStartSelectionMode(false);
    closeSelection();
    loadVersion += 1;
    clearTransient();
    unsubscribeSpeech?.();
    unsubscribeSpeech = null;
    speechToolbarObserver?.disconnect?.();
    speechToolbarObserver = null;
    (tts || speech).stop?.();
    for (const sentence of root.querySelectorAll('.pc-sentence-speaking')) sentence.classList.remove('pc-sentence-speaking');
    root.removeEventListener('click', onClick);
    root.removeEventListener('click', onSentenceClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    runtime.clearInterval(progressTimer);
    progressTimer = null;
  };
}
