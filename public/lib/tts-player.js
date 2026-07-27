export function createTtsPlayer({
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  Audio: AudioClass = globalThis.Audio,
  URL: urlApi = globalThis.URL,
  fallback
} = {}) {
  let activeAudio = null;
  let activeUrl = null;
  let activeController = null;
  let generation = 0;
  let rate = fallback?.getRate?.() || 1;
  let sequenceState = null;
  let fallbackCompletionUnsubscribe = null;

  function releaseAudio() {
    activeAudio?.pause?.();
    activeAudio = null;
    if (activeUrl) urlApi?.revokeObjectURL?.(activeUrl);
    activeUrl = null;
  }

  function beginPlayback() {
    generation += 1;
    activeController?.abort?.();
    activeController = null;
    releaseAudio();
    sequenceState = null;
    fallbackCompletionUnsubscribe?.();
    fallbackCompletionUnsubscribe = null;
    fallback?.stop?.();
    return generation;
  }

  async function playPath(path, options, token) {
    if (!fetchImpl || !AudioClass || !urlApi?.createObjectURL) return false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    try {
      const response = await fetchImpl(path, {
        credentials: 'same-origin',
        signal: controller?.signal
      });
      if (!response.ok || token !== generation) return false;
      const objectUrl = urlApi.createObjectURL(await response.blob());
      if (token !== generation) {
        urlApi?.revokeObjectURL?.(objectUrl);
        return false;
      }
      activeUrl = objectUrl;
      const audio = new AudioClass(activeUrl);
      activeAudio = audio;
      audio.playbackRate = clampRate(options.rate ?? rate);
      const result = new Promise(resolve => {
        audio.onplay = () => {
          if (token !== generation || activeAudio !== audio) return;
          options.onStart?.();
          if (options.nextPath) prefetch(options.nextPath);
        };
        audio.onended = () => {
          if (token !== generation || activeAudio !== audio) return resolve(false);
          options.onEnd?.();
          releaseAudio();
          resolve(true);
        };
        audio.onerror = () => {
          if (token === generation && activeAudio === audio) releaseAudio();
          resolve(false);
        };
      });
      await audio.play();
      return await result;
    } catch {
      if (token === generation) releaseAudio();
      return false;
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  function prefetch(path) {
    fetchImpl?.(path, { credentials: 'same-origin' }).catch(() => {});
  }

  async function playPoint(path, text, options = {}) {
    const token = beginPlayback();
    const played = await playPath(path, options, token);
    if (!played && token === generation) fallback?.speakOnce(text, options);
    return played;
  }

  async function startArticle(articleId, sentences, startIndex = 0, options = {}) {
    const texts = Array.isArray(sentences)
      ? sentences.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    if (!texts.length || startIndex < 0 || startIndex >= texts.length) return false;
    const token = beginPlayback();
    sequenceState = { token, index: startIndex, onState: options.onState };
    for (let index = startIndex; index < texts.length; index += 1) {
      if (token !== generation) return false;
      sequenceState.index = index;
      options.onState?.({
        state: 'speaking',
        currentIndex: index,
        rate,
        completion: { reachedEnd: false, coverage: (index - startIndex) / texts.length, counted: false }
      });
      const path = articlePath(articleId, index);
      const played = await playPath(path, {
        rate,
        nextPath: index + 1 < texts.length ? articlePath(articleId, index + 1) : null
      }, token);
      if (!played) {
        if (token !== generation) return false;
        sequenceState = null;
        if (startIndex === 0 && index > 0 && fallback?.subscribe) {
          fallbackCompletionUnsubscribe = fallback.subscribe(state => {
            if (!state?.completion?.reachedEnd) return;
            fallbackCompletionUnsubscribe?.();
            fallbackCompletionUnsubscribe = null;
            options.onState?.({
              ...state,
              completion: { ...state.completion, counted: true },
              completionEvent: {
                reachedEnd: true,
                coverage: 1,
                counted: true
              }
            });
          });
        }
        fallback?.load?.(texts);
        fallback?.setRate?.(rate);
        fallback?.startAt?.(index);
        return false;
      }
    }
    if (token !== generation) return false;
    sequenceState = null;
    const counted = startIndex === 0;
    options.onState?.({
      state: 'idle',
      currentIndex: null,
      rate,
      completion: { reachedEnd: true, coverage: 1, counted },
      completionEvent: counted ? { reachedEnd: true, coverage: 1, counted: true } : null
    });
    return true;
  }

  return {
    isSupported: Boolean(AudioClass || fallback?.isSupported),
    speakWord(wordId, mode, text, options) {
      return playPoint(
        `/api/tts/words/${encodeURIComponent(wordId)}?mode=${encodeURIComponent(mode)}`,
        text,
        options
      );
    },
    speakArticleSentence(articleId, index, text, options = {}) {
      return playPoint(articlePath(articleId, index), text, {
        ...options,
        nextPath: options.nextIndex != null
          ? articlePath(articleId, options.nextIndex)
          : null
      });
    },
    startArticle,
    pause() {
      if (activeAudio && sequenceState) {
        activeAudio.pause?.();
        sequenceState.onState?.({ state: 'paused', currentIndex: sequenceState.index, rate });
      } else {
        fallback?.pause?.();
      }
    },
    resume() {
      if (activeAudio && sequenceState) {
        activeAudio.play?.();
        sequenceState.onState?.({ state: 'speaking', currentIndex: sequenceState.index, rate });
      } else {
        fallback?.resume?.();
      }
    },
    setRate(value) {
      rate = clampRate(value);
      if (activeAudio) activeAudio.playbackRate = rate;
      if (!sequenceState) fallback?.setRate?.(rate);
      return rate;
    },
    getRate() { return rate; },
    stop() {
      const priorSequence = sequenceState;
      generation += 1;
      activeController?.abort?.();
      activeController = null;
      releaseAudio();
      sequenceState = null;
      fallbackCompletionUnsubscribe?.();
      fallbackCompletionUnsubscribe = null;
      fallback?.stop?.();
      priorSequence?.onState?.({
        state: 'idle', currentIndex: null, rate,
        completion: { reachedEnd: false, coverage: 0, counted: false }
      });
    }
  };
}

function articlePath(articleId, index) {
  return `/api/tts/articles/${encodeURIComponent(articleId)}/sentences/${index}`;
}

function clampRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1.5, Math.max(0.5, numeric));
}
