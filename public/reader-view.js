import { findTermMatches, normalizeTerm, splitArticleParagraphs, validateSelection } from './lib/text.js';
import { mountConversionForm } from './pending-view.js';
import { createReadingSession } from './lib/reading-session.js';
import { createMediaSessionBridge } from './lib/media-session.js';
import { createSleepTimer } from './lib/sleep-timer.js';
import { anchoredPanelPosition } from './lib/floating-panel.js';
import {
  loadReaderPreferences,
  readerPreferenceStyles,
  saveReaderPreferences
} from './lib/reader-preferences.js';
import {
  loadTtsPreferences,
  saveTtsPreferences,
  TTS_PROFILE_OPTIONS
} from './lib/tts-preferences.js';
import {
  loadTranslationMode,
  saveTranslationMode,
  TRANSLATION_MODES
} from './lib/translation-preferences.js';
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

function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatFloatingRemaining(milliseconds) {
  const formatted = formatRemaining(milliseconds);
  return Number(formatted.split(':', 1)[0]) >= 100 ? '99m+' : formatted;
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
  play: ['M10 8.5l6 3.5-6 3.5v-7z', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z'],
  pause: ['M8 7v10M16 7v10', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z'],
  previous: ['M6 5v14', 'M18 6l-8 6 8 6V6z'],
  replay: ['M7 7h6a6 6 0 1 1-5.4 8.6', 'M7 3v4h4'],
  timer: ['M12 8v4l3 2', 'M9 3h6', 'M12 5a8 8 0 1 1 0 16 8 8 0 0 1 0-16z'],
  target: ['M12 3v3M12 18v3M3 12h3M18 12h3', 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z'],
  translate: [
    'M4 5h8M8 3v2c0 4-2 7-5 9M4 9c1.5 2.5 3.5 4.2 6 5',
    'M14 21l4-11 4 11M15.5 17h5'
  ],
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
  ]
};

function svgIcon(name, { filled = false } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.dataset.icon = name;
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

function floatingIconButton(action, label, icon) {
  const node = actionButton(action, '', 'pc-floating-speech-action');
  node.append(svgIcon(icon), element('span', 'pc-floating-speech-label', label));
  return node;
}

function assignDataset(node, values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value != null) node.dataset[key] = String(value);
  }
  return node;
}

export function createReaderView({
  root,
  api,
  articleId,
  navigate,
  speech,
  tts = null,
  progressQueue = null,
  progressRuntime = {},
  aloudCheckpointStore = null,
  username = '',
  storage = null,
  mediaRuntime = {}
}) {
  let mounted = true;
  let article = null;
  let paragraphs = [];
  let sentences = [];
  let articleTranslation = null;
  let translationMode = loadTranslationMode(storage);
  let translationBusy = false;
  let articleTranslationGeneration = 0;
  let selectionTranslationGeneration = 0;
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
  let suppressNextSentenceClick = false;
  let progressSubmissionId = 0;
  let lastProgressFailureId = 0;
  let lastProgressSuccessId = 0;
  let selectionTimer = null;
  let speechState = 'idle';
  let activeAloudSentenceIndex = null;
  let activeAloudOffsetSeconds = 0;
  let pointAloudSentenceIndex = null;
  let directSpeechGeneration = 0;
  let directSpeechActive = false;
  let lastAutoFollowedSentenceIndex = null;
  let savedAloudSentenceIndex = null;
  let savedAloudOffsetSeconds = 0;
  let pausedAloudSentenceIndex = null;
  let requestedAloudPending = false;
  let requestedAloudSentenceIndex = null;
  let requestedAloudOffsetSeconds = 0;
  let lastLocalCheckpointAt = 0;
  let lastCheckpointSignature = null;
  let lastQueuedPosition = null;
  let speechToolbarOffscreen = false;
  let speechToolbarObserver = null;
  let startSelectionMode = false;
  let timerPanelTrigger = null;
  let settingsPanelTrigger = null;
  let translationPanelTrigger = null;
  let timerBackgroundState = [];
  let timerControlState = [];
  let readerPreferences = loadReaderPreferences(storage);
  let ttsPreferences = loadTtsPreferences(storage);
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
  let unsubscribeTimer = null;
  const audioController = tts || speech;
  const timerRuntime = {
    now: mediaRuntime.now || runtime.now,
    setInterval: mediaRuntime.setInterval || runtime.setInterval,
    clearInterval: mediaRuntime.clearInterval || runtime.clearInterval
  };
  const timerKey = `pc-aloud-timer:${encodeURIComponent(username)}:${encodeURIComponent(articleId)}`;
  let initiallyExpiredTimer = false;
  let initialTimerExpiryHandled = false;
  try {
    const storedTimer = JSON.parse(storage?.getItem?.(timerKey) || 'null');
    initiallyExpiredTimer = Number.isFinite(storedTimer?.deadline)
      && storedTimer.deadline <= timerRuntime.now();
  } catch {
    initiallyExpiredTimer = false;
  }
  const sleepTimer = createSleepTimer({
    storage,
    key: timerKey,
    now: timerRuntime.now,
    setInterval: timerRuntime.setInterval,
    clearInterval: timerRuntime.clearInterval
  });
  const mediaBridge = createMediaSessionBridge({
    mediaSession: mediaRuntime.mediaSession,
    MediaMetadata: mediaRuntime.MediaMetadata
  });

  function speakDirect(text) {
    const generation = ++directSpeechGeneration;
    directSpeechActive = true;
    try {
      speech.speakOnce(text, {
        onEnd() {
          if (generation === directSpeechGeneration) directSpeechActive = false;
        }
      });
    } catch (error) {
      if (generation === directSpeechGeneration) directSpeechActive = false;
      throw error;
    }
  }

  function stopDirectSpeech() {
    if (!directSpeechActive) return false;
    directSpeechActive = false;
    directSpeechGeneration += 1;
    speech.stop?.();
    return true;
  }

  function speakSentence(sentenceNode) {
    const index = Number(sentenceNode?.dataset.sentenceIndex);
    if (!Number.isInteger(index)) return;
    if (checkSleepTimer()) return;
    if (tts?.speakArticleSentence) {
      bindMediaSession();
      pointAloudSentenceIndex = index;
      tts.speakArticleSentence(articleId, index, sentenceNode.textContent, {
        rate: (tts || speech).getRate?.() || 1,
        profile: ttsPreferences.articleProfile,
        nextIndex: index + 1 < sentences.length ? index + 1 : null
      });
    } else {
      speakDirect(sentenceNode.textContent);
    }
  }

  function startFullReading(index, offsetSeconds = 0) {
    if (checkSleepTimer()) return;
    setStartSelectionMode(false);
    pointAloudSentenceIndex = null;
    requestedAloudPending = true;
    requestedAloudSentenceIndex = index;
    requestedAloudOffsetSeconds = aloudOffset(offsetSeconds);
    bindMediaSession();
    if (tts?.startArticle) {
      tts.startArticle(
        articleId,
        sentences.map(sentence => sentence.text),
        index,
        { offsetSeconds, profile: ttsPreferences.articleProfile }
      );
    } else {
      speech.startAt(index);
    }
    if (requestedAloudPending) {
      saveRequestedAloudCheckpoint(index, offsetSeconds);
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

  function trackProgressResult(result) {
    const submissionId = ++progressSubmissionId;
    Promise.resolve(result).then(sent => {
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

  function submitProgress(item) {
    if (!progressQueue) return;
    trackProgressResult(progressQueue.submit(item));
  }

  function retryProgress() {
    if (!progressQueue) return;
    trackProgressResult(progressQueue.retry());
  }

  function saveProgress({ force = false } = {}) {
    if (!article || !progressQueue) return;
    let activeMs = readingSession.flushActiveMs();
    while (activeMs > 0) {
      const amount = Math.min(60_000, activeMs);
      queueEvent('active_ms', amount);
      activeMs -= amount;
    }
    const aloudPosition = durableAloudPosition();
    const position = {
      kind: 'position',
      articleId,
      lastPositionRatio: currentPositionRatio(),
      lastAloudSentenceIndex: aloudPosition?.sentenceIndex ?? null,
      lastAloudOffsetSeconds: aloudPosition?.offsetSeconds ?? 0
    };
    const unchanged = lastQueuedPosition
      && lastQueuedPosition.articleId === position.articleId
      && lastQueuedPosition.lastPositionRatio === position.lastPositionRatio
      && lastQueuedPosition.lastAloudSentenceIndex === position.lastAloudSentenceIndex
      && lastQueuedPosition.lastAloudOffsetSeconds === position.lastAloudOffsetSeconds;
    if (unchanged && !force) {
      retryProgress();
      return;
    }
    lastQueuedPosition = {
      articleId: position.articleId,
      lastPositionRatio: position.lastPositionRatio,
      lastAloudSentenceIndex: position.lastAloudSentenceIndex,
      lastAloudOffsetSeconds: position.lastAloudOffsetSeconds
    };
    submitProgress(position);
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
    for (const paragraph of paragraphs) {
      const paragraphNode = element('p', 'pc-reader-paragraph');
      for (const sentence of paragraph.sentences) {
        if (sentence.index === pausedAloudSentenceIndex) {
          const marker = element('span', 'pc-aloud-resume-marker', '上次暂停');
          marker.dataset.role = 'aloud-resume-marker';
          marker.setAttribute('aria-hidden', 'true');
          paragraphNode.append(marker);
        }
        paragraphNode.append(renderSentence(sentence, candidates));
      }
      body.append(paragraphNode);
      const translated = translationMode === 'full'
        ? articleTranslation?.paragraphs?.find(item => Number(item.index) === paragraph.index)
        : null;
      if (translated) {
        const translationNode = element(
          'div', 'pc-reader-translation', translated.translation
        );
        translationNode.dataset.role = 'paragraph-translation';
        translationNode.dataset.paragraphIndex = String(paragraph.index);
        body.append(translationNode);
      }
    }
    container.append(body);
  }

  async function loadArticleTranslation(version) {
    try {
      const result = await api(`/api/articles/${encodeURIComponent(articleId)}/translation`);
      if (!isCurrent(version)) return;
      articleTranslation = result?.status === 'fresh' ? result : null;
    } catch {
      if (isCurrent(version)) articleTranslation = null;
    }
    if (isCurrent(version) && translationMode === 'full' && !articleTranslation) {
      translationMode = 'original';
      saveTranslationMode(storage, translationMode);
    }
  }

  function closeTranslationPanel({ restoreFocus = true } = {}) {
    const panel = root.querySelector('[data-role="translation-panel"]');
    if (!panel) return;
    panel.remove();
    if (translationPanelTrigger) translationPanelTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && translationPanelTrigger?.isConnected) translationPanelTrigger.focus();
    translationPanelTrigger = null;
  }

  function fullTranslationModeLabel() {
    if (translationBusy) return '翻译中…';
    return articleTranslation ? '全文译文' : '翻译全文';
  }

  function syncTranslationPanel() {
    const panel = root.querySelector('[data-role="translation-panel"]');
    if (!panel) return;
    for (const choice of panel.querySelectorAll('[data-action="translation-mode"]')) {
      choice.setAttribute('aria-pressed', String(translationMode === choice.dataset.mode));
      choice.disabled = translationBusy;
      if (choice.dataset.mode === 'full') choice.textContent = fullTranslationModeLabel();
    }
    const refresh = panel.querySelector('[data-action="translate-article"]');
    if (refresh) {
      refresh.textContent = translationBusy ? '翻译中…' : '重新翻译全文';
      refresh.disabled = translationBusy;
    }
  }

  function renderTranslationPanel({ focusActive = false } = {}) {
    if (!translationPanelTrigger?.isConnected) return;
    root.querySelector('[data-role="translation-panel"]')?.remove();
    const panel = element('section', 'pc-reader-settings-panel pc-reader-translation-panel');
    panel.dataset.role = 'translation-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '翻译显示');
    const choices = element('div', 'pc-reader-settings-choices');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', '译文显示模式');
    for (const [mode, label] of [
      ['original', '原文'],
      ['sentence', '逐句翻译'],
      ['full', fullTranslationModeLabel()]
    ]) {
      const choice = actionButton('translation-mode', label, 'pc-reader-settings-choice');
      choice.dataset.mode = mode;
      choice.setAttribute('aria-pressed', String(translationMode === mode));
      choice.disabled = translationBusy;
      choices.append(choice);
    }
    panel.append(element('h2', 'pc-reader-settings-title', '翻译'), choices);
    if (articleTranslation && translationMode === 'full') {
      const refresh = actionButton('translate-article', translationBusy ? '翻译中…' : '重新翻译全文');
      refresh.disabled = translationBusy;
      panel.append(refresh);
    }
    root.append(panel);
    positionAnchoredPanel(
      panel,
      translationPanelTrigger,
      '--reader-settings-left',
      '--reader-settings-top'
    );
    if (focusActive) panel.querySelector('[aria-pressed="true"]')?.focus();
  }

  function openTranslationPanel(trigger) {
    setStartSelectionMode(false);
    closeReaderSettings({ restoreFocus: false });
    closeTimerPanel({ restoreFocus: false });
    closeTranslationPanel({ restoreFocus: false });
    translationPanelTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    renderTranslationPanel({ focusActive: true });
  }

  async function translateArticle() {
    if (translationBusy) return false;
    translationBusy = true;
    const generation = ++articleTranslationGeneration;
    syncTranslationPanel();
    try {
      const result = await api(`/api/articles/${encodeURIComponent(articleId)}/translation`, {
        method: 'PUT', body: '{}'
      });
      if (!mounted || generation !== articleTranslationGeneration) return false;
      if (result?.status !== 'fresh') throw new Error('文章翻译暂不可用，请稍后重试');
      articleTranslation = result;
      return true;
    } catch (error) {
      if (mounted && generation === articleTranslationGeneration) {
        renderInlineError(root, error.message || '文章翻译暂不可用，请稍后重试');
      }
      return false;
    } finally {
      if (generation === articleTranslationGeneration) {
        translationBusy = false;
        syncTranslationPanel();
      }
    }
  }

  async function setTranslationMode(mode) {
    if (!TRANSLATION_MODES.includes(mode) || translationBusy) return;
    if (mode === 'full' && !articleTranslation) {
      await translateArticle();
      if (!articleTranslation) return;
    }
    translationMode = mode;
    saveTranslationMode(storage, mode);
    closeTranslationPanel({ restoreFocus: false });
    render();
  }

  async function refreshArticleTranslation() {
    if (!articleTranslation || translationBusy) return;
    if (!await translateArticle()) return;
    translationMode = 'full';
    saveTranslationMode(storage, translationMode);
    closeTranslationPanel({ restoreFocus: false });
    render();
  }

  function applyReaderPreferences() {
    const content = root.querySelector('.pc-reader-content');
    if (!content) return;
    const styles = readerPreferenceStyles(readerPreferences);
    content.style.setProperty('--reader-font-size', styles.fontSize);
    content.style.setProperty('--reader-line-height', styles.lineHeight);
    content.style.setProperty('--reader-max-width', styles.maxWidth);
  }

  function closeReaderSettings({ restoreFocus = true } = {}) {
    const panel = root.querySelector('[data-role="reader-settings-panel"]');
    if (!panel) return;
    panel.remove();
    if (settingsPanelTrigger) settingsPanelTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && settingsPanelTrigger?.isConnected) settingsPanelTrigger.focus();
    settingsPanelTrigger = null;
  }

  function readerSettingGroup({ preference, label, options }) {
    const group = element('fieldset', 'pc-reader-settings-group');
    const legend = element('legend', '', label);
    const choices = element('div', 'pc-reader-settings-choices');
    for (const [value, text] of options) {
      const choice = actionButton('reader-preference', text, 'pc-reader-settings-choice');
      choice.dataset.preference = preference;
      choice.dataset.value = value;
      choice.setAttribute('aria-pressed', String(readerPreferences[preference] === value));
      choices.append(choice);
    }
    group.append(legend, choices);
    return group;
  }

  function openReaderSettings(trigger) {
    setStartSelectionMode(false);
    closeTranslationPanel({ restoreFocus: false });
    closeReaderSettings({ restoreFocus: false });
    settingsPanelTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    const panel = element('section', 'pc-reader-settings-panel');
    panel.dataset.role = 'reader-settings-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '阅读设置');
    const voiceLabel = element('label', 'pc-reader-settings-voice');
    voiceLabel.append(element('span', '', '朗读角色'));
    const voiceSelect = element('select', 'pc-input');
    voiceSelect.dataset.action = 'article-tts-profile';
    for (const [value, label] of Object.entries(TTS_PROFILE_OPTIONS)) {
      const node = element('option', '', label);
      node.value = value;
      node.selected = value === ttsPreferences.articleProfile;
      voiceSelect.append(node);
    }
    voiceLabel.append(voiceSelect);
    panel.append(
      element('h2', 'pc-reader-settings-title', '阅读设置'),
      readerSettingGroup({
        preference: 'fontSize', label: '字号',
        options: [['small', '小'], ['medium', '中'], ['large', '大']]
      }),
      readerSettingGroup({
        preference: 'lineHeight', label: '行距',
        options: [['compact', '紧凑'], ['comfortable', '舒适'], ['loose', '宽松']]
      }),
      readerSettingGroup({
        preference: 'measure', label: '版心',
        options: [['narrow', '窄'], ['medium', '中'], ['wide', '宽']]
      }),
      voiceLabel
    );
    root.append(panel);
    positionAnchoredPanel(panel, trigger, '--reader-settings-left', '--reader-settings-top');
    panel.querySelector('[aria-pressed="true"]')?.focus();
  }

  function updateReaderPreference(target) {
    const { preference, value } = target.dataset;
    if (!Object.hasOwn(readerPreferences, preference)) return;
    const next = { ...readerPreferences, [preference]: value };
    if (!saveReaderPreferences(storage, next)) {
      const styles = readerPreferenceStyles(next);
      const accepted = Object.values(styles).every(Boolean);
      if (!accepted) return;
    }
    readerPreferences = next;
    applyReaderPreferences();
    const panel = target.closest('[data-role="reader-settings-panel"]');
    for (const choice of panel?.querySelectorAll(`[data-preference="${preference}"]`) || []) {
      choice.setAttribute('aria-pressed', String(choice === target));
    }
  }

  function speechToolbar() {
    const audioController = tts || speech;
    const speechAvailable = Boolean(audioController?.isSupported);
    const toolbar = element('section', 'pc-reader-speech');
    toolbar.dataset.role = 'speech-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '文章语音朗读');
    const primary = actionButton('speech-primary', '播放');
    primary.dataset.role = 'speech-primary';
    primary.dataset.speechControl = '';
    primary.disabled = !speechAvailable;
    const previous = labeledIconButton(
      'speech-previous',
      '上一句',
      'previous',
      'pc-btn-ghost pc-speech-replay-action'
    );
    previous.dataset.speechControl = '';
    previous.setAttribute('aria-label', '重播上一句');
    previous.disabled = !speechAvailable;
    const current = labeledIconButton(
      'speech-current',
      '重听',
      'replay',
      'pc-btn-ghost pc-speech-replay-action'
    );
    current.dataset.speechControl = '';
    current.setAttribute('aria-label', '重新朗读当前句');
    current.disabled = !speechAvailable;
    const timer = actionButton('speech-timer', '定时');
    timer.dataset.speechControl = '';
    timer.setAttribute('aria-label', '设置停止朗读定时器');
    timer.setAttribute('aria-expanded', 'false');
    timer.disabled = !speechAvailable;
    const restart = actionButton('speech-restart', '从头开始');
    restart.dataset.role = 'speech-restart';
    restart.dataset.speechControl = '';
    restart.disabled = !speechAvailable;
    restart.hidden = true;
    toolbar.append(primary, previous, current, timer, restart);
    const rateLabel = element('label', 'pc-speech-field');
    rateLabel.append(document.createTextNode('语速'));
    const rate = element('input');
    rate.type = 'range';
    rate.min = '0.5';
    rate.max = '1.5';
    rate.step = '0.25';
    rate.value = String(audioController.getRate?.() || speech.getRate?.() || 1);
    rate.dataset.action = 'speech-rate';
    rate.dataset.speechControl = '';
    rate.setAttribute('aria-label', '朗读语速');
    rate.disabled = !speechAvailable;
    const rateValue = element('output', 'pc-speech-rate-value', `${Number(rate.value)}×`);
    rateValue.dataset.role = 'speech-rate-value';
    rateLabel.append(rate, rateValue);
    toolbar.append(rateLabel);
    const timerRemaining = element('output', 'pc-sleep-timer-remaining');
    timerRemaining.dataset.role = 'sleep-timer-remaining';
    timerRemaining.setAttribute('aria-live', 'polite');
    timerRemaining.hidden = true;
    toolbar.append(timerRemaining);
    const settings = iconButton(
      'reader-settings',
      '阅读设置',
      'settings',
      'pc-btn-ghost pc-reader-settings-trigger'
    );
    settings.setAttribute('aria-expanded', 'false');
    settings.setAttribute('aria-haspopup', 'dialog');
    const translate = iconButton(
      'translation-menu', '翻译', 'translate',
      'pc-btn-ghost pc-reader-translation-trigger'
    );
    translate.setAttribute('aria-expanded', 'false');
    translate.setAttribute('aria-haspopup', 'dialog');
    translate.setAttribute('aria-pressed', String(translationMode !== 'original'));
    toolbar.append(translate, settings);
    const status = element('div', 'pc-speech-status');
    status.dataset.role = 'speech-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(status);
    const fallbackWarning = element(
      'div',
      'pc-speech-fallback-warning',
      '已回退到设备语音；音色由当前设备决定，锁屏后台播放可能受限'
    );
    fallbackWarning.dataset.role = 'speech-fallback-warning';
    fallbackWarning.setAttribute('role', 'status');
    fallbackWarning.hidden = true;
    toolbar.append(fallbackWarning);
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
    const previous = floatingIconButton('speech-floating-previous', '上一句', 'previous');
    previous.classList.add('pc-speech-replay-action');
    previous.dataset.speechControl = '';
    previous.setAttribute('aria-label', '重播上一句');
    const current = floatingIconButton('speech-floating-current', '重听', 'replay');
    current.classList.add('pc-speech-replay-action');
    current.dataset.speechControl = '';
    current.setAttribute('aria-label', '重新朗读当前句');
    const action = speechAction(true);
    const toggle = floatingIconButton('speech-floating-toggle', action.label, action.icon);
    toggle.dataset.role = 'floating-speech-toggle';
    toggle.setAttribute('aria-label', action.ariaLabel);
    toggle.disabled = !Boolean((tts || speech)?.isSupported);
    const timer = floatingIconButton('speech-floating-timer', '定时', 'timer');
    timer.dataset.speechControl = '';
    timer.setAttribute('aria-label', '设置停止朗读定时器');
    timer.setAttribute('aria-expanded', 'false');
    timer.disabled = !Boolean((tts || speech)?.isSupported);
    const rate = actionButton('speech-rate-cycle', '', 'pc-floating-speech-action pc-floating-speech-rate');
    rate.dataset.role = 'floating-speech-rate';
    rate.dataset.speechControl = '';
    rate.disabled = !Boolean((tts || speech)?.isSupported);
    capsule.append(previous, current, toggle, timer, rate);
    return capsule;
  }

  function bottomPanelOpen() {
    return Boolean(root.querySelector(
      '[data-role="selection-action"], [data-role="term-popover"], [data-role="conversion-panel"], [data-role="sleep-timer-panel"]'
    ));
  }

  function setStartSelectionMode(enabled) {
    startSelectionMode = Boolean(enabled);
    root.classList.toggle('pc-reader-start-selecting', startSelectionMode);
    const hint = root.querySelector('[data-role="reader-start-hint"]');
    if (hint) hint.hidden = !startSelectionMode;
    syncSpeechControls();
  }

  function speechAction(selectableStart = false) {
    if (speechState === 'speaking') {
      return { label: '暂停', ariaLabel: '暂停全文朗读', icon: 'pause' };
    }
    if (
      speechState === 'paused' ||
      (speechState === 'idle' && Number.isInteger(savedAloudSentenceIndex))
    ) {
      return { label: '继续', ariaLabel: '继续全文朗读', icon: 'play' };
    }
    if (selectableStart && startSelectionMode) {
      return { label: '取消选择', ariaLabel: '取消选择全文朗读起点', icon: 'close' };
    }
    return selectableStart
      ? { label: '选择起点', ariaLabel: '选择全文朗读起点', icon: 'target' }
      : { label: '播放', ariaLabel: '从头播放全文', icon: 'play' };
  }

  function syncSpeechControls() {
    const timerDialogOpen = Boolean(root.querySelector('[data-role="sleep-timer-panel"]'));
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
      const action = speechAction(true);
      toggle.replaceChildren(
        svgIcon(action.icon),
        element('span', 'pc-floating-speech-label', action.label)
      );
      toggle.setAttribute('aria-label', action.ariaLabel);
    }
    const primary = root.querySelector('[data-role="speech-primary"]');
    if (primary) {
      const action = speechAction();
      primary.textContent = action.label;
      primary.setAttribute('aria-label', action.ariaLabel);
    }
    const restart = root.querySelector('[data-role="speech-restart"]');
    if (restart) {
      restart.hidden = !(
        speechState === 'paused' ||
        (speechState === 'idle' && Number.isInteger(savedAloudSentenceIndex))
      );
    }
    const replayIndex = currentReplayIndex();
    const speechAvailable = Boolean(audioController?.isSupported);
    for (const previous of root.querySelectorAll(
      '[data-action="speech-previous"], [data-action="speech-floating-previous"]'
    )) {
      previous.disabled = !speechAvailable || replayIndex < 1;
    }
    for (const current of root.querySelectorAll(
      '[data-action="speech-current"], [data-action="speech-floating-current"]'
    )) {
      current.disabled = !speechAvailable || !validAloudIndex(replayIndex);
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
    if (timerDialogOpen) {
      for (const control of root.querySelectorAll(
        '[data-role="speech-toolbar"] button, [data-role="speech-toolbar"] input, [data-role="floating-speech"] button'
      )) {
        control.disabled = true;
      }
      if (floating) floating.hidden = true;
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

  function validAloudIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < sentences.length;
  }

  function currentReplayIndex() {
    if (tts?.getSnapshot?.()?.articleId && !ownsAudioControllerPlayback()) return null;
    if (validAloudIndex(activeAloudSentenceIndex)) return activeAloudSentenceIndex;
    if (requestedAloudPending) return null;
    return validAloudIndex(savedAloudSentenceIndex) ? savedAloudSentenceIndex : null;
  }

  function aloudOffset(value) {
    const offset = Number(value);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  }

  function durableAloudPosition() {
    if (requestedAloudPending && validAloudIndex(requestedAloudSentenceIndex)) {
      return {
        sentenceIndex: requestedAloudSentenceIndex,
        offsetSeconds: aloudOffset(requestedAloudOffsetSeconds),
        pending: true
      };
    }
    if (validAloudIndex(activeAloudSentenceIndex)) {
      return {
        sentenceIndex: activeAloudSentenceIndex,
        offsetSeconds: aloudOffset(activeAloudOffsetSeconds),
        pending: false
      };
    }
    if (validAloudIndex(savedAloudSentenceIndex)) {
      return {
        sentenceIndex: savedAloudSentenceIndex,
        offsetSeconds: aloudOffset(savedAloudOffsetSeconds),
        pending: false
      };
    }
    return null;
  }

  function resolveResumeState() {
    const live = tts?.getSnapshot?.();
    if (live?.articleId === articleId && validAloudIndex(live.currentIndex)) {
      return {
        source: 'live',
        position: {
          sentenceIndex: live.currentIndex,
          offsetSeconds: aloudOffset(live.currentTime)
        },
        snapshot: live
      };
    }
    const local = aloudCheckpointStore?.load?.({ articleId, body: article.body });
    if (local && validAloudIndex(local.sentenceIndex)) {
      return {
        source: 'local',
        position: {
          sentenceIndex: local.sentenceIndex,
          offsetSeconds: aloudOffset(local.offsetSeconds)
        }
      };
    }
    const serverIndex = article.progress?.last_aloud_sentence_index;
    const serverOffset = Number(article.progress?.last_aloud_offset_seconds || 0);
    if (validAloudIndex(serverIndex)) {
      return {
        source: 'server',
        position: {
          sentenceIndex: serverIndex,
          offsetSeconds: aloudOffset(serverOffset)
        }
      };
    }
    return {
      source: 'none',
      position: { sentenceIndex: null, offsetSeconds: 0 }
    };
  }

  function setSavedAloudPosition(index, offsetSeconds = 0) {
    const previousIndex = savedAloudSentenceIndex;
    savedAloudSentenceIndex = validAloudIndex(index)
      ? index
      : null;
    savedAloudOffsetSeconds = savedAloudSentenceIndex === null
      ? 0
      : aloudOffset(offsetSeconds);
    if (article?.progress) article.progress.last_aloud_sentence_index = savedAloudSentenceIndex;
    if (article?.progress) article.progress.last_aloud_offset_seconds = savedAloudOffsetSeconds;
    if (previousIndex === savedAloudSentenceIndex) return;
    const previousEntry = root.querySelector('[data-role="aloud-resume-entry"]');
    if (previousEntry) previousEntry.replaceWith(resumeEntry());
  }

  function setPausedAloudPosition(index) {
    const nextIndex = validAloudIndex(index) ? index : null;
    if (pausedAloudSentenceIndex === nextIndex) return;
    pausedAloudSentenceIndex = nextIndex;
    root.querySelector('[data-role="aloud-resume-marker"]')?.remove();
    if (Number.isInteger(pausedAloudSentenceIndex)) {
      const sentence = root.querySelector(`[data-sentence-index="${pausedAloudSentenceIndex}"]`);
      if (sentence) {
        const marker = element('span', 'pc-aloud-resume-marker', '上次暂停');
        marker.dataset.role = 'aloud-resume-marker';
        marker.setAttribute('aria-hidden', 'true');
        sentence.before(marker);
      }
    }
  }

  function saveAloudCheckpoint({ immediate = false, state = speechState } = {}) {
    const position = durableAloudPosition();
    if (!position || !article) return false;
    const { sentenceIndex: index, offsetSeconds } = position;
    const checkpointState = state === 'speaking' ? 'speaking' : 'paused';
    const signature = `${index}:${offsetSeconds}:${checkpointState}`;
    const currentTime = timerRuntime.now();
    if (signature === lastCheckpointSignature) return false;
    if (!immediate && currentTime - lastLocalCheckpointAt < 2_000) return false;

    if (!position.pending) setSavedAloudPosition(index, offsetSeconds);
    aloudCheckpointStore?.save?.({
      articleId,
      body: article.body,
      sentenceIndex: index,
      offsetSeconds,
      state: checkpointState
    });
    lastLocalCheckpointAt = currentTime;
    lastCheckpointSignature = signature;
    saveProgress({ force: immediate });
    return true;
  }

  function saveRequestedAloudCheckpoint(index, offsetSeconds = 0) {
    const position = durableAloudPosition();
    if (
      !position?.pending ||
      position.sentenceIndex !== index ||
      !article
    ) return false;
    const offset = position.offsetSeconds;
    aloudCheckpointStore?.save?.({
      articleId,
      body: article.body,
      sentenceIndex: index,
      offsetSeconds: offset,
      state: 'paused'
    });
    lastLocalCheckpointAt = timerRuntime.now();
    lastCheckpointSignature = `${index}:${offset}:paused`;
    saveProgress({ force: true });
    return true;
  }

  function clearAloudCheckpoint() {
    aloudCheckpointStore?.clear?.(articleId);
    activeAloudSentenceIndex = null;
    activeAloudOffsetSeconds = 0;
    requestedAloudPending = false;
    requestedAloudSentenceIndex = null;
    requestedAloudOffsetSeconds = 0;
    setSavedAloudPosition(null, 0);
    setPausedAloudPosition(null);
    lastCheckpointSignature = null;
    saveProgress();
  }

  function announceSpeechStatus(message) {
    const status = root.querySelector('[data-role="speech-status"]');
    if (status && status.textContent !== message) status.textContent = message;
  }

  function syncTimerControls(timerState = sleepTimer.snapshot()) {
    const formattedRemaining = timerState.active
      ? formatRemaining(timerState.remainingMs)
      : '';
    const floatingFormattedRemaining = timerState.active
      ? formatFloatingRemaining(timerState.remainingMs)
      : '';
    const remaining = root.querySelector('[data-role="sleep-timer-remaining"]');
    if (remaining) {
      if (timerState.expired) {
        remaining.textContent = '定时结束';
        remaining.hidden = false;
      } else if (timerState.active) {
        remaining.textContent = formattedRemaining;
        remaining.hidden = false;
      } else {
        remaining.textContent = '';
        remaining.hidden = true;
      }
    }
    const expanded = Boolean(root.querySelector('[data-role="sleep-timer-panel"]'));
    for (const trigger of root.querySelectorAll(
      '[data-action="speech-timer"], [data-action="speech-floating-timer"]'
    )) {
      trigger.setAttribute('aria-expanded', String(expanded));
      trigger.setAttribute(
        'aria-label',
        timerState.active
          ? `\u8bbe\u7f6e\u505c\u6b62\u6717\u8bfb\u5b9a\u65f6\u5668\uff0c\u5269\u4f59 ${formattedRemaining}`
          : '\u8bbe\u7f6e\u505c\u6b62\u6717\u8bfb\u5b9a\u65f6\u5668'
      );
      if (trigger.dataset.action === 'speech-floating-timer') {
        trigger.replaceChildren(...(timerState.active
          ? [element('span', 'pc-floating-speech-timer-value', floatingFormattedRemaining)]
          : [svgIcon('timer'), element('span', 'pc-floating-speech-label', '定时')]));
      }
    }
  }

  function setTimerDialogState(open, panel = null) {
    if (open) {
      timerBackgroundState = [...root.children]
        .filter(node => node !== panel)
        .map(node => ({
          node,
          inert: node.hasAttribute('inert'),
          ariaHidden: node.getAttribute('aria-hidden')
        }));
      for (const state of timerBackgroundState) {
        state.node.inert = true;
        state.node.setAttribute('inert', '');
        state.node.setAttribute('aria-hidden', 'true');
      }
      timerControlState = [
        ...root.querySelectorAll(
          '[data-role="speech-toolbar"] button, [data-role="speech-toolbar"] input, [data-role="floating-speech"] button'
        )
      ].map(control => ({ control, disabled: control.disabled }));
      for (const state of timerControlState) state.control.disabled = true;
      root.classList.add('pc-reader-timer-open');
      return;
    }
    for (const state of timerBackgroundState) {
      state.node.inert = state.inert;
      if (state.inert) state.node.setAttribute('inert', '');
      else state.node.removeAttribute('inert');
      if (state.ariaHidden == null) state.node.removeAttribute('aria-hidden');
      else state.node.setAttribute('aria-hidden', state.ariaHidden);
    }
    for (const state of timerControlState) state.control.disabled = state.disabled;
    timerBackgroundState = [];
    timerControlState = [];
    root.classList.remove('pc-reader-timer-open');
  }

  function closeTimerPanel({ restoreFocus = true } = {}) {
    const panel = root.querySelector('[data-role="sleep-timer-panel"]');
    if (!panel) return;
    panel.remove();
    setTimerDialogState(false);
    syncSpeechControls();
    syncTimerControls();
    if (restoreFocus && timerPanelTrigger?.isConnected) timerPanelTrigger.focus();
    timerPanelTrigger = null;
  }

  function positionAnchoredPanel(panel, trigger, leftProperty, topProperty) {
    if (!panel || !trigger?.isConnected) return;
    const position = anchoredPanelPosition({
      anchorRect: trigger.getBoundingClientRect?.(),
      panelRect: panel.getBoundingClientRect?.(),
      viewportWidth: window.innerWidth || document.documentElement.clientWidth,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight
    });
    panel.style.setProperty(leftProperty, `${position.left}px`);
    panel.style.setProperty(topProperty, `${position.top}px`);
  }

  function positionOpenPanels() {
    positionAnchoredPanel(
      root.querySelector('[data-role="sleep-timer-panel"]'),
      timerPanelTrigger,
      '--sleep-timer-left',
      '--sleep-timer-top'
    );
    positionAnchoredPanel(
      root.querySelector('[data-role="reader-settings-panel"]'),
      settingsPanelTrigger,
      '--reader-settings-left',
      '--reader-settings-top'
    );
    positionAnchoredPanel(
      root.querySelector('[data-role="translation-panel"]'),
      translationPanelTrigger,
      '--reader-settings-left',
      '--reader-settings-top'
    );
  }

  function openTimerPanel(trigger) {
    closeTranslationPanel({ restoreFocus: false });
    closeReaderSettings({ restoreFocus: false });
    closeTimerPanel({ restoreFocus: false });
    timerPanelTrigger = trigger;
    const panel = element('section', 'pc-sleep-timer-panel');
    panel.dataset.role = 'sleep-timer-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '停止朗读定时器');
    const title = element('h2', 'pc-sleep-timer-title', '停止朗读定时器');
    const presets = element('div', 'pc-sleep-timer-presets');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', '预设时长');
    for (const minutes of [10, 20, 30, 60]) {
      const preset = actionButton('speech-timer-set', `${minutes} 分钟`);
      preset.dataset.minutes = String(minutes);
      presets.append(preset);
    }
    const customLabel = element('label', 'pc-sleep-timer-custom-label', '自定义分钟数');
    const custom = element('input', 'pc-sleep-timer-custom');
    custom.dataset.role = 'sleep-timer-custom';
    custom.name = 'minutes';
    custom.type = 'number';
    custom.min = '1';
    custom.step = '1';
    custom.inputMode = 'numeric';
    custom.setAttribute('aria-describedby', 'pc-sleep-timer-error');
    customLabel.append(custom);
    const customSet = actionButton('speech-timer-set', '设置');
    const error = element('div', 'pc-sleep-timer-error');
    error.id = 'pc-sleep-timer-error';
    error.dataset.role = 'sleep-timer-error';
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'polite');
    const cancel = actionButton('speech-timer-cancel', '取消定时');
    panel.append(title, presets, customLabel, customSet, error, cancel);
    root.append(panel);
    positionAnchoredPanel(panel, trigger, '--sleep-timer-left', '--sleep-timer-top');
    setTimerDialogState(true, panel);
    syncSpeechControls();
    syncTimerControls();
    custom.focus();
  }

  function setSleepTimer(target) {
    const panel = target.closest('[data-role="sleep-timer-panel"]');
    const input = panel?.querySelector('[data-role="sleep-timer-custom"]');
    const error = panel?.querySelector('[data-role="sleep-timer-error"]');
    const minutes = target.dataset.minutes == null ? Number(input?.value) : Number(target.dataset.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      if (error) error.textContent = '请输入大于 0 的正整数分钟数';
      input?.focus();
      return;
    }
    if (!sleepTimer.setMinutes(minutes)) {
      if (error) error.textContent = '无法设置定时器，请重试';
      return;
    }
    closeTimerPanel();
  }

  function ownsAudioControllerPlayback() {
    if (!tts) return true;
    const live = tts.getSnapshot?.();
    if (live?.articleId === articleId) return true;
    return Number.isInteger(pointAloudSentenceIndex) && live?.articleId == null;
  }

  function handleExpiredTimer() {
    const stoppedDirectSpeech = stopDirectSpeech();
    if (ownsAudioControllerPlayback() && (tts || !stoppedDirectSpeech)) {
      audioController.pause?.();
    }
    saveAloudCheckpoint({ immediate: true, state: 'paused' });
    announceSpeechStatus('定时结束，已暂停');
  }

  function checkSleepTimer() {
    if (initiallyExpiredTimer) {
      initiallyExpiredTimer = false;
      handleExpiredTimer();
      initialTimerExpiryHandled = true;
      syncTimerControls({ active: false, deadline: null, remainingMs: 0, expired: true });
      return true;
    }
    return sleepTimer.check().expired;
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

  function applySpeechState(next, {
    checkTimer = true,
    forceCheckpoint = false
  } = {}) {
    const ownsFullArticle = !tts || next?.articleId === articleId;
    const ownsPointPlayback = Boolean(
      tts &&
      Number.isInteger(pointAloudSentenceIndex) &&
      next?.articleId == null &&
      (
        next?.mode === 'once' ||
        next?.state === 'once' ||
        next?.state === 'idle'
      )
    );
    if (tts && !ownsFullArticle && !ownsPointPlayback) return;
    for (const sentence of root.querySelectorAll('[data-sentence-index]')) {
      const speaking = ownsFullArticle && next?.state === 'speaking'
        && Number(sentence.dataset.sentenceIndex) === next.currentIndex;
      sentence.classList.toggle('pc-sentence-speaking', speaking);
    }
    const nextState = next?.state || 'idle';
    const priorState = speechState;
    const priorIndex = activeAloudSentenceIndex;
    speechState = nextState;
    const validPlayerPosition =
      (nextState === 'speaking' || nextState === 'paused') &&
      validAloudIndex(next?.currentIndex) &&
      ownsFullArticle;
    if (validPlayerPosition) {
      requestedAloudPending = false;
      requestedAloudSentenceIndex = null;
      requestedAloudOffsetSeconds = 0;
      activeAloudSentenceIndex = next.currentIndex;
      activeAloudOffsetSeconds = aloudOffset(next.currentTime);
      saveAloudCheckpoint({
        immediate: forceCheckpoint || priorState !== nextState || priorIndex !== next.currentIndex,
        state: nextState
      });
      if (nextState === 'paused') setPausedAloudPosition(next.currentIndex);
      else if (nextState === 'speaking') setPausedAloudPosition(null);
    }
    if (nextState === 'idle' && next?.completion?.reachedEnd) {
      clearAloudCheckpoint();
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
      } else if (nextState === 'idle' && previousSpeechState !== 'idle') {
        if (previousSpeechState === 'once') announcement = '所选内容朗读结束';
        else if (next?.completion?.reachedEnd) announcement = '全文朗读完成';
        else if (fullSpeechActive) announcement = '全文朗读已中断';
        fullSpeechActive = false;
      }
      if (announcement && status.textContent !== announcement) status.textContent = announcement;
      previousSpeechState = nextState;
    }
    if (validPlayerPosition) fullSpeechActive = true;
    if (next?.completionEvent?.counted) {
      if (readingSession.markReadAloudComplete().readAloudCompleted) queueEvent('read_aloud_complete');
    }
    if (nextState === 'speaking' && Number.isInteger(next?.currentIndex)) {
      followSpeakingSentence(next.currentIndex);
    } else if (nextState !== 'speaking') {
      lastAutoFollowedSentenceIndex = null;
    }
    const warning = root.querySelector('[data-role="speech-fallback-warning"]');
    if (warning) warning.hidden = !next?.fallbackActive;
    const audibleIndex = validAloudIndex(activeAloudSentenceIndex)
      ? activeAloudSentenceIndex
      : savedAloudSentenceIndex;
    const mediaIndex = ownsPointPlayback ? null : audibleIndex;
    const mediaSentence = ownsPointPlayback
      ? sentences[pointAloudSentenceIndex]?.text.trim() || ''
      : validAloudIndex(audibleIndex) ? sentences[audibleIndex]?.text.trim() || '' : '';
    if (nextState === 'idle' && next?.completion?.reachedEnd) {
      mediaBridge.cleanup();
    } else {
      mediaBridge.update({
        state: ownsPointPlayback && nextState === 'once' ? 'speaking' : nextState,
        currentIndex: mediaIndex,
        sentenceCount: ownsPointPlayback ? 0 : sentences.length,
        title: article?.title || '',
        author: article?.author || '',
        sentence: mediaSentence
      });
    }
    syncSpeechControls();
    if (checkTimer && article) checkSleepTimer();
  }

  function render() {
    if (fullSpeechActive) {
      setSavedAloudPosition(activeAloudSentenceIndex, activeAloudOffsetSeconds);
      saveProgress();
    }
    clearTransient();
    setStartSelectionMode(false);
    suppressNextSentenceClick = false;
    closeTranslationPanel({ restoreFocus: false });
    root.replaceChildren();
    const header = element('header', 'pc-reader-header');
    header.append(actionButton('back-library', '返回文章库'));
    header.append(element('h1', 'pc-reader-title', article.title));
    if (translationMode === 'full' && articleTranslation) {
      const translatedTitle = element(
        'div', 'pc-reader-translation-title', articleTranslation.titleZh
      );
      translatedTitle.dataset.role = 'article-translation-title';
      header.append(translatedTitle);
    }
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
    applyReaderPreferences();
    if (!tts) speech.load(sentences.map(sentence => sentence.text));
    restorePosition();
    observeSpeechToolbar();
    syncSpeechControls();
    syncTimerControls();
    if (initiallyExpiredTimer) checkSleepTimer();
  }

  async function load() {
    const version = ++loadVersion;
    clearTransient();
    closeSelection();
    try {
      const next = await api(`/api/articles/${encodeURIComponent(articleId)}`);
      if (!isCurrent(version)) return;
      article = next;
      const parsedBody = splitArticleParagraphs(article.body);
      paragraphs = parsedBody.paragraphs;
      sentences = parsedBody.sentences;
      await loadArticleTranslation(version);
      if (!isCurrent(version)) return;
      const resumeState = resolveResumeState();
      setSavedAloudPosition(
        resumeState.position.sentenceIndex,
        resumeState.position.offsetSeconds
      );
      setPausedAloudPosition(
        resumeState.source !== 'live' || resumeState.snapshot?.state === 'paused'
          ? resumeState.position.sentenceIndex
          : null
      );
      if (resumeState.source === 'live') {
        activeAloudSentenceIndex = resumeState.position.sentenceIndex;
        activeAloudOffsetSeconds = resumeState.position.offsetSeconds;
      }
      render();
      if (resumeState.snapshot && !initialTimerExpiryHandled) {
        applySpeechState(resumeState.snapshot, {
          checkTimer: false,
          forceCheckpoint: true
        });
      }
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

  async function translateSelection(panel, button) {
    if (!panel || button.disabled) return;
    button.disabled = true;
    const generation = ++selectionTranslationGeneration;
    panel.querySelector('[data-role="selection-translation"]')?.remove();
    try {
      const result = await api('/api/translations/selection', {
        method: 'POST',
        body: JSON.stringify({
          text: panel.dataset.selectedText || '',
          context: panel.dataset.contextSentence || ''
        })
      });
      if (!mounted || generation !== selectionTranslationGeneration || !panel.isConnected) return;
      const translated = element(
        'div', 'pc-selection-translation', String(result?.translation || '')
      );
      translated.dataset.role = 'selection-translation';
      translated.setAttribute('role', 'status');
      panel.querySelector('[data-role="reader-popover-body"]')?.append(translated);
      positionOpenPanels();
    } catch (error) {
      if (mounted && generation === selectionTranslationGeneration && panel.isConnected) {
        const translated = element(
          'div', 'pc-selection-translation pc-inline-error',
          error.message || '翻译暂不可用，请稍后重试'
        );
        translated.dataset.role = 'selection-translation';
        translated.setAttribute('role', 'alert');
        panel.querySelector('[data-role="reader-popover-body"]')?.append(translated);
      }
    } finally {
      if (mounted && generation === selectionTranslationGeneration && panel.isConnected) {
        button.disabled = false;
      }
    }
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
    body.append(actionButton('translate-selection', '翻译所选内容', 'pc-btn-ghost'));
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
      if (checkSleepTimer()) return;
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
    if (action === 'pronounce') {
      if (checkSleepTimer()) return;
      speakDirect(target.dataset.text);
    }
    if (action === 'pronounce-selection') {
      if (checkSleepTimer()) return;
      speakDirect(target.closest('[data-role="selection-action"]')?.dataset.selectedText || '');
    }
    if (action === 'speech-primary') {
      if (checkSleepTimer()) return;
      if (speechState === 'speaking') {
        audioController.pause();
      } else if (speechState === 'paused') {
        audioController.resume();
      } else if (speechState === 'idle' && Number.isInteger(savedAloudSentenceIndex)) {
        locateSentence(savedAloudSentenceIndex);
        startFullReading(savedAloudSentenceIndex, savedAloudOffsetSeconds);
      } else {
        startFullReading(0);
      }
    }
    if (action === 'speech-previous' || action === 'speech-floating-previous') {
      if (checkSleepTimer()) return;
      const previousIndex = currentReplayIndex() - 1;
      if (previousIndex >= 0 && ownsAudioControllerPlayback()) {
        if (tts) tts.previousSentence?.();
        else speakDirect(sentences[previousIndex].text);
      }
    }
    if (action === 'speech-current' || action === 'speech-floating-current') {
      if (checkSleepTimer()) return;
      const replayIndex = currentReplayIndex();
      if (validAloudIndex(replayIndex) && ownsAudioControllerPlayback()) {
        if (tts) tts.replayCurrentSentence?.();
        else speakDirect(sentences[replayIndex].text);
      }
    }
    if (action === 'speech-timer' || action === 'speech-floating-timer') {
      openTimerPanel(target);
    }
    if (action === 'reader-settings') {
      if (root.querySelector('[data-role="reader-settings-panel"]')) closeReaderSettings();
      else openReaderSettings(target);
    }
    if (action === 'translation-menu') {
      if (root.querySelector('[data-role="translation-panel"]')) closeTranslationPanel();
      else openTranslationPanel(target);
    }
    if (action === 'translation-mode') setTranslationMode(target.dataset.mode);
    if (action === 'reader-preference') updateReaderPreference(target);
    if (action === 'translate-article') refreshArticleTranslation();
    if (action === 'speech-timer-set') {
      setSleepTimer(target);
    }
    if (action === 'speech-timer-cancel') {
      sleepTimer.cancel();
      closeTimerPanel();
    }
    if (action === 'speech-restart') {
      if (checkSleepTimer()) return;
      fullSpeechActive = false;
      clearAloudCheckpoint();
      startFullReading(0);
    }
    if (action === 'speech-jump-resume' && Number.isInteger(savedAloudSentenceIndex)) {
      locateSentence(savedAloudSentenceIndex);
    }
    if (action === 'speech-start-selection') {
      if (checkSleepTimer()) return;
      const panel = target.closest('[data-role="selection-action"]');
      const sentenceIndex = Number(panel?.dataset.sentenceIndex);
      closeSelection();
      if (Number.isInteger(sentenceIndex)) startFullReading(sentenceIndex);
    }
    if (action === 'speech-start-popover') {
      if (checkSleepTimer()) return;
      const panel = target.closest('[data-role="selection-action"], [data-role="term-popover"]');
      const sentenceIndex = Number(panel?.dataset.sentenceIndex);
      if (panel?.dataset.role === 'selection-action') closeSelection();
      else closePopover();
      if (Number.isInteger(sentenceIndex)) startFullReading(sentenceIndex);
    }
    if (action === 'speech-floating-toggle') {
      if (checkSleepTimer()) return;
      if (speechState === 'speaking') {
        audioController.pause();
      } else if (speechState === 'paused') {
        audioController.resume();
      } else if (
        speechState === 'idle' &&
        Number.isInteger(savedAloudSentenceIndex)
      ) {
        startFullReading(savedAloudSentenceIndex, savedAloudOffsetSeconds);
      } else {
        setStartSelectionMode(!startSelectionMode);
      }
    }
    if (action === 'speech-rate-cycle') {
      if (checkSleepTimer()) return;
      const current = Number((tts || speech).getRate?.() || 1);
      const rates = [0.5, 0.75, 1, 1.25, 1.5];
      const currentIndex = rates.indexOf(current);
      const nextRate = rates[(currentIndex + 1 + rates.length) % rates.length];
      (tts || speech).setRate(nextRate);
      syncSpeechControls();
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
    if (action === 'translate-selection') {
      translateSelection(target.closest('[data-role="selection-action"]'), target);
    }
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
    if (event.target.matches('[data-action="article-tts-profile"]')) {
      const next = { ...ttsPreferences, articleProfile: event.target.value };
      if (saveTtsPreferences(storage, next)) ttsPreferences = next;
      return;
    }
    if (event.target.matches('[data-action="speech-rate"]')) {
      readingSession.interact();
      if (checkSleepTimer()) return;
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
      saveAloudCheckpoint({ immediate: true, state: 'paused' });
    }
    saveProgress();
    checkSleepTimer();
  }

  function onPageHide() {
    saveAloudCheckpoint({ immediate: true, state: 'paused' });
    saveProgress();
  }

  function onPageShow() {
    checkSleepTimer();
  }

  function onKeyDown(event) {
    const sentence = event.target.closest?.('[data-sentence-index]');
    if (
      startSelectionMode && event.target === sentence &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      if (checkSleepTimer()) return;
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
    if (root.querySelector('[data-role="sleep-timer-panel"]')) {
      event.preventDefault();
      closeTimerPanel();
      return;
    }
    if (root.querySelector('[data-role="reader-settings-panel"]')) {
      event.preventDefault();
      closeReaderSettings();
      return;
    }
    if (root.querySelector('[data-role="translation-panel"]')) {
      event.preventDefault();
      closeTranslationPanel();
      return;
    }
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
    if (event.target.closest?.('[data-role="translation-panel"]')) return;
    const timerPanel = root.querySelector('[data-role="sleep-timer-panel"]');
    if (
      timerPanel && !timerPanel.contains(event.target)
      && !timerPanelTrigger?.contains?.(event.target)
    ) {
      closeTimerPanel();
      return;
    }
    const settingsPanel = root.querySelector('[data-role="reader-settings-panel"]');
    if (
      settingsPanel && !settingsPanel.contains(event.target)
      && !settingsPanelTrigger?.contains?.(event.target)
    ) {
      closeReaderSettings();
      return;
    }
    const translationPanel = root.querySelector('[data-role="translation-panel"]');
    if (
      translationPanel && !translationPanel.contains(event.target)
      && !translationPanelTrigger?.contains?.(event.target)
    ) {
      closeTranslationPanel();
      return;
    }
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
  window.addEventListener('resize', positionOpenPanels);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibilityChange);
  function bindMediaSession() {
    mediaBridge.bind({
      play: () => {
        if (!checkSleepTimer() && ownsAudioControllerPlayback()) audioController.resume();
      },
      pause: () => {
        if (ownsAudioControllerPlayback()) audioController.pause();
      },
      previous: () => {
        if (!checkSleepTimer() && ownsAudioControllerPlayback()) tts?.previousSentence?.();
      },
      current: () => {
        if (checkSleepTimer()) return;
        if (!ownsAudioControllerPlayback()) return;
        if (tts && validAloudIndex(pointAloudSentenceIndex)) {
          const index = pointAloudSentenceIndex;
          tts.speakArticleSentence(
            articleId,
            index,
            sentences[index].text.trim(),
            {
              rate: audioController.getRate?.() || 1,
              profile: ttsPreferences.articleProfile,
              nextIndex: index + 1 < sentences.length ? index + 1 : null
            }
          );
          return;
        }
        tts?.replayCurrentSentence?.();
      },
      next: () => {
        if (!checkSleepTimer() && ownsAudioControllerPlayback()) tts?.nextSentence?.();
      }
    });
  }
  bindMediaSession();
  unsubscribeTimer = sleepTimer.subscribe(timerState => {
    if (!timerState.expired) {
      syncTimerControls(timerState);
      return;
    }
    handleExpiredTimer();
    syncTimerControls(timerState);
  });
  unsubscribeSpeech = audioController.subscribe?.(applySpeechState) || null;
  progressTimer = runtime.setInterval(saveProgress, 15_000);
  root.replaceChildren(element('div', 'pc-empty', '加载中…'));
  load();

  return () => {
    if (!mounted) return;
    saveAloudCheckpoint({ immediate: true, state: 'paused' });
    saveProgress();
    mounted = false;
    articleTranslationGeneration += 1;
    selectionTranslationGeneration += 1;
    closeTimerPanel({ restoreFocus: false });
    closeReaderSettings({ restoreFocus: false });
    closeTranslationPanel({ restoreFocus: false });
    document.removeEventListener('selectionchange', onSelectionChange);
    if (selectionTimer !== null) runtime.clearTimeout(selectionTimer);
    selectionTimer = null;
    setStartSelectionMode(false);
    closeSelection();
    loadVersion += 1;
    clearTransient();
    unsubscribeSpeech?.();
    unsubscribeSpeech = null;
    unsubscribeTimer?.();
    unsubscribeTimer = null;
    sleepTimer.cleanup();
    mediaBridge.cleanup();
    speechToolbarObserver?.disconnect?.();
    speechToolbarObserver = null;
    const stoppedDirectSpeech = stopDirectSpeech();
    if (ownsAudioControllerPlayback() && (tts || !stoppedDirectSpeech)) {
      audioController.stop?.();
    }
    for (const sentence of root.querySelectorAll('.pc-sentence-speaking')) sentence.classList.remove('pc-sentence-speaking');
    root.removeEventListener('click', onClick);
    root.removeEventListener('click', onSentenceClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', positionOpenPanels);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    runtime.clearInterval(progressTimer);
    progressTimer = null;
  };
}
