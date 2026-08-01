export function createTtsPlayer({
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  Audio: AudioClass = globalThis.Audio,
  URL: urlApi = globalThis.URL,
  fallback
} = {}) {
  const audio = createAudio(AudioClass);
  const subscribers = new Set();
  let articleSession = null;
  let state = 'idle';
  let mode = 'idle';
  let articleId = null;
  let currentIndex = null;
  let pendingIndex = null;
  let currentTime = 0;
  let duration = 0;
  let rate = fallback?.getRate?.() || 1;
  let completion = emptyCompletion();
  let fallbackActive = false;
  let activeUrl = null;
  let activeController = null;
  let fallbackUnsubscribe = null;
  let activeOperationResolve = null;
  let activeMetadataResolve = null;
  let generation = 0;

  function snapshot(completionEvent = null) {
    return {
      state,
      mode,
      articleId,
      currentIndex,
      pendingIndex,
      currentTime,
      duration,
      rate,
      completion: { ...completion },
      completionEvent,
      fallbackActive
    };
  }

  function publish(completionEvent = null) {
    const next = snapshot(completionEvent);
    for (const subscriber of subscribers) subscriber(next);
  }

  function releaseUrl() {
    if (activeUrl) urlApi?.revokeObjectURL?.(activeUrl);
    activeUrl = null;
  }

  function settleActiveOperation(result) {
    const resolve = activeOperationResolve;
    activeOperationResolve = null;
    resolve?.(result);
  }

  function settleMetadata(result) {
    const resolve = activeMetadataResolve;
    activeMetadataResolve = null;
    resolve?.(result);
  }

  function stopFallback() {
    fallbackUnsubscribe?.();
    fallbackUnsubscribe = null;
    fallback?.stop?.();
    fallbackActive = false;
  }

  function invalidateMedia({ pause = true } = {}) {
    generation += 1;
    activeController?.abort?.();
    activeController = null;
    settleMetadata(false);
    settleActiveOperation(false);
    if (pause && activeUrl) audio?.pause?.();
    releaseUrl();
    return generation;
  }

  function endArticleSession(result) {
    articleSession?.resolve?.(result);
  }

  function abandonArticleSession() {
    articleSession?.legacyUnsubscribe?.();
    endArticleSession(false);
    articleSession = null;
  }

  function resetForPoint() {
    abandonArticleSession();
    stopFallback();
    const token = invalidateMedia();
    articleId = null;
    currentIndex = null;
    pendingIndex = null;
    currentTime = 0;
    duration = 0;
    completion = emptyCompletion();
    mode = 'once';
    state = 'loading';
    publish();
    return token;
  }

  async function fetchObjectUrl(path, token) {
    if (!fetchImpl || !audio || !urlApi?.createObjectURL) return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    try {
      const response = await fetchImpl(path, {
        credentials: 'same-origin',
        signal: controller?.signal
      });
      if (!response.ok || token !== generation) return null;
      const blob = await response.blob();
      if (token !== generation) return null;
      const objectUrl = urlApi.createObjectURL(blob);
      if (token !== generation) {
        urlApi?.revokeObjectURL?.(objectUrl);
        return null;
      }
      return objectUrl;
    } catch {
      return null;
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  function prefetch(path) {
    fetchImpl?.(path, { credentials: 'same-origin' }).catch(() => {});
  }

  async function playPoint(path, text, options = {}) {
    const token = resetForPoint();
    const objectUrl = await fetchObjectUrl(path, token);
    if (!objectUrl) {
      if (token === generation) {
        state = 'idle';
        fallbackActive = true;
        publish();
        fallback?.speakOnce?.(text, options);
      }
      return false;
    }

    activeUrl = objectUrl;
    audio.playbackRate = clampRate(options.rate ?? rate);
    const result = new Promise(resolve => {
      activeOperationResolve = resolve;
      audio.onplay = () => {
        if (token !== generation) return;
        state = 'once';
        options.onStart?.();
        publish();
        if (options.nextPath) prefetch(options.nextPath);
      };
      audio.onpause = () => {
        if (token !== generation || state !== 'once') return;
        state = 'paused';
        currentTime = mediaTime(audio.currentTime);
        publish();
      };
      audio.ontimeupdate = () => {
        if (token !== generation) return;
        currentTime = mediaTime(audio.currentTime);
        publish();
      };
      audio.ondurationchange = () => {
        if (token !== generation) return;
        duration = mediaTime(audio.duration);
        publish();
      };
      audio.onloadedmetadata = audio.ondurationchange;
      audio.onended = () => {
        if (token !== generation) return;
        currentTime = mediaTime(audio.currentTime);
        duration = mediaTime(audio.duration);
        releaseUrl();
        state = 'idle';
        mode = 'idle';
        options.onEnd?.();
        publish();
        settleActiveOperation(true);
      };
      audio.onerror = () => {
        if (token !== generation) return;
        releaseUrl();
        state = 'idle';
        publish();
        settleActiveOperation(false);
      };
    });
    audio.src = objectUrl;
    try {
      await audio.play();
    } catch {
      if (token === generation) audio.onerror?.();
    }
    const played = await result;
    if (!played && token === generation) {
      fallbackActive = true;
      publish();
      fallback?.speakOnce?.(text, options);
    }
    return played;
  }

  function updateCompletion(reachedEnd) {
    const total = articleSession?.texts.length || 0;
    const coverage = total ? articleSession.completed.size / total : 0;
    completion = {
      reachedEnd,
      coverage,
      counted: Boolean(
        reachedEnd &&
        articleSession?.startIndex === 0 &&
        coverage >= 0.8
      )
    };
  }

  function bridgeFallback(index) {
    if (!articleSession) return;
    const session = articleSession;
    fallbackActive = true;
    pendingIndex = null;
    state = 'idle';
    releaseUrl();
    publish();

    fallbackUnsubscribe?.();
    fallbackUnsubscribe = fallback?.subscribe?.(next => {
      if (!articleSession || articleSession !== session || !fallbackActive) return;
      const reachedEndBefore = completion.reachedEnd;
      state = next?.state || 'idle';
      if (Number.isInteger(next?.currentIndex)) currentIndex = next.currentIndex;
      const nextCompletion = next?.completion || emptyCompletion();
      const total = session.texts.length;
      const fallbackCoverage = Number.isFinite(nextCompletion.coverage)
        ? nextCompletion.coverage
        : 0;
      const fallbackCompleted = Math.min(
        total - index,
        Math.max(0, Math.round(fallbackCoverage * total))
      );
      for (let offset = 0; offset < fallbackCompleted; offset += 1) {
        session.completed.add(index + offset);
      }
      completion = {
        reachedEnd: Boolean(nextCompletion.reachedEnd),
        coverage: total ? session.completed.size / total : 0,
        counted: Boolean(
          nextCompletion.reachedEnd &&
          session.startIndex === 0 &&
          total > 0 &&
          session.completed.size / total >= 0.8
        )
      };
      const completedNow = completion.reachedEnd && !reachedEndBefore;
      const completionEvent = completedNow && completion.counted && !session.completionPublished
        ? { ...completion }
        : null;
      if (completionEvent) session.completionPublished = true;
      publish(completionEvent);
      if (completion.reachedEnd) {
        session.legacyUnsubscribe?.();
        session.legacyUnsubscribe = null;
      }
    }) || null;
    fallback?.load?.(session.texts);
    fallback?.setRate?.(rate);
    fallback?.startAt?.(index);
  }

  async function playArticleIndex(index, { offsetSeconds = 0 } = {}) {
    const session = articleSession;
    if (!session || index < 0 || index >= session.texts.length) return false;

    if (fallbackActive) stopFallback();
    session.heldIndex = index;
    session.heldOffsetSeconds = Math.max(0, Number(offsetSeconds) || 0);
    const token = invalidateMedia();
    if (articleSession !== session) return false;
    session.token = token;
    pendingIndex = index;
    state = 'loading';
    mode = 'article';
    articleId = session.articleId;
    currentTime = 0;
    duration = 0;
    updateCompletion(false);
    publish();

    const objectUrl = await fetchObjectUrl(articlePath(session.articleId, index), token);
    if (!objectUrl) {
      if (token === generation && articleSession === session) {
        if (!session.playIntent) {
          pendingIndex = null;
          state = 'paused';
          publish();
          return false;
        }
        pendingIndex = null;
        bridgeFallback(index);
        endArticleSession(false);
      }
      return false;
    }

    activeUrl = objectUrl;
    audio.playbackRate = rate;
    let metadataResolve;
    const metadata = new Promise(resolve => {
      metadataResolve = resolve;
      activeMetadataResolve = resolve;
    });

    const publishMediaPosition = () => {
      currentTime = mediaTime(audio.currentTime);
      duration = mediaTime(audio.duration);
      publish();
    };
    audio.onloadedmetadata = () => {
      if (token !== generation || articleSession !== session) return;
      duration = mediaTime(audio.duration);
      const requestedOffset = Math.max(0, Number(offsetSeconds) || 0);
      audio.currentTime = duration > 0 && requestedOffset > duration
        ? 0
        : Math.min(requestedOffset, duration);
      currentTime = mediaTime(audio.currentTime);
      publish();
      if (activeMetadataResolve === metadataResolve) activeMetadataResolve = null;
      metadataResolve(true);
    };
    audio.ondurationchange = () => {
      if (token !== generation || articleSession !== session) return;
      duration = mediaTime(audio.duration);
      publish();
    };
    audio.ontimeupdate = () => {
      if (token !== generation || articleSession !== session) return;
      publishMediaPosition();
    };
    audio.onplay = () => {
      if (token !== generation || articleSession !== session) return;
      if (!session.playIntent) {
        audio.pause?.();
        pendingIndex = null;
        state = 'paused';
        publishMediaPosition();
        return;
      }
      if (pendingIndex === index) {
        currentIndex = pendingIndex;
        pendingIndex = null;
      } else if (currentIndex !== index) {
        return;
      }
      session.heldIndex = null;
      session.heldOffsetSeconds = 0;
      state = 'speaking';
      publishMediaPosition();
      if (index + 1 < session.texts.length) {
        prefetch(articlePath(session.articleId, index + 1));
      }
    };
    audio.onpause = () => {
      if (
        token !== generation ||
        articleSession !== session ||
        currentIndex !== index ||
        audio.ended === true ||
        state !== 'speaking'
      ) return;
      state = 'paused';
      publishMediaPosition();
    };
    audio.onended = () => {
      if (
        token !== generation ||
        articleSession !== session ||
        currentIndex !== index ||
        pendingIndex != null
      ) return;
      releaseUrl();
      session.completed.add(index);
      const nextIndex = index + 1 < session.texts.length ? index + 1 : null;
      session.heldIndex = nextIndex;
      session.heldOffsetSeconds = 0;
      updateCompletion(false);
      publish();
      if (nextIndex != null) {
        if (session.playIntent) {
          void playArticleIndex(nextIndex);
        } else {
          state = 'paused';
          publish();
        }
        return;
      }
      updateCompletion(true);
      state = 'idle';
      const completionEvent = completion.counted && !session.completionPublished
        ? { ...completion }
        : null;
      if (completionEvent) session.completionPublished = true;
      publish(completionEvent);
      endArticleSession(true);
    };
    audio.onerror = () => {
      if (token !== generation || articleSession !== session) return;
      settleMetadata(false);
      pendingIndex = null;
      bridgeFallback(index);
      endArticleSession(false);
    };
    audio.src = objectUrl;

    if (Math.max(0, Number(offsetSeconds) || 0) > 0) {
      const ready = await metadata;
      if (!ready || token !== generation || articleSession !== session) return false;
    } else {
      audio.currentTime = 0;
      currentTime = 0;
      settleMetadata(true);
    }

    if (!session.playIntent) {
      pendingIndex = null;
      state = 'paused';
      publish();
      return false;
    }
    try {
      await audio.play();
      return true;
    } catch {
      if (token === generation && articleSession === session) audio.onerror?.();
      return false;
    }
  }

  async function startArticle(nextArticleId, sentences, startIndex = 0, options = {}) {
    const texts = Array.isArray(sentences)
      ? sentences.map(value => String(value ?? '').trim()).filter(Boolean)
      : [];
    const nextIndex = Number(startIndex);
    if (!texts.length || !Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= texts.length) {
      return false;
    }

    abandonArticleSession();
    stopFallback();
    invalidateMedia();
    currentIndex = null;
    pendingIndex = null;
    currentTime = 0;
    duration = 0;
    completion = emptyCompletion();
    state = 'loading';
    mode = 'article';
    articleId = nextArticleId;
    let resolveSession;
    const result = new Promise(resolve => { resolveSession = resolve; });
    articleSession = {
      texts,
      articleId: nextArticleId,
      startIndex: nextIndex,
      completed: new Set(),
      token: generation,
      completionPublished: false,
      playIntent: true,
      heldIndex: nextIndex,
      heldOffsetSeconds: Math.max(0, Number(options.offsetSeconds) || 0),
      resolve: resolveSession,
      legacyUnsubscribe: null
    };
    const session = articleSession;
    const unsubscribe = typeof options.onState === 'function'
      ? subscribeWithoutInitial(options.onState)
      : null;
    void playArticleIndex(nextIndex, { offsetSeconds: options.offsetSeconds });
    const completed = await result;
    if (completed || !fallbackActive || completion.reachedEnd || articleSession !== session) {
      unsubscribe?.();
    } else {
      session.legacyUnsubscribe = unsubscribe;
    }
    return completed;
  }

  function subscribeWithoutInitial(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  return {
    isSupported: Boolean(audio || fallback?.isSupported),
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      subscribers.add(listener);
      listener(snapshot());
      return () => subscribers.delete(listener);
    },
    getSnapshot() {
      return snapshot();
    },
    speakWord(wordId, wordMode, text, options) {
      return playPoint(
        `/api/tts/words/${encodeURIComponent(wordId)}?mode=${encodeURIComponent(wordMode)}`,
        text,
        options
      );
    },
    speakArticleSentence(nextArticleId, index, text, options = {}) {
      return playPoint(articlePath(nextArticleId, index), text, {
        ...options,
        nextPath: options.nextIndex != null
          ? articlePath(nextArticleId, options.nextIndex)
          : null
      });
    },
    startArticle,
    previousSentence() {
      if (!articleSession || !Number.isInteger(currentIndex) || currentIndex === 0) {
        return false;
      }
      articleSession.playIntent = true;
      void playArticleIndex(currentIndex - 1);
      return true;
    },
    replayCurrentSentence() {
      if (!articleSession || !Number.isInteger(currentIndex)) return false;
      articleSession.playIntent = true;
      void playArticleIndex(currentIndex);
      return true;
    },
    nextSentence() {
      if (
        !articleSession ||
        !Number.isInteger(currentIndex) ||
        currentIndex >= articleSession.texts.length - 1
      ) return false;
      articleSession.playIntent = true;
      void playArticleIndex(currentIndex + 1);
      return true;
    },
    pause() {
      if (fallbackActive) {
        if (articleSession) articleSession.playIntent = false;
        fallback?.pause?.();
        return;
      }
      if (!audio) return;
      if (articleSession && mode === 'article') articleSession.playIntent = false;
      if (state === 'loading' && articleSession) {
        if (Number.isInteger(pendingIndex)) articleSession.heldIndex = pendingIndex;
        invalidateMedia();
        pendingIndex = null;
        state = 'paused';
        publish();
        return;
      }
      if (state !== 'speaking' && state !== 'once') return;
      audio.pause?.();
      currentTime = mediaTime(audio.currentTime);
      state = 'paused';
      publish();
    },
    resume() {
      if (fallbackActive) {
        if (articleSession) articleSession.playIntent = true;
        fallback?.resume?.();
        return;
      }
      if (!audio || state !== 'paused') return;
      if (articleSession && mode === 'article') {
        articleSession.playIntent = true;
        if (Number.isInteger(articleSession.heldIndex)) {
          void playArticleIndex(articleSession.heldIndex, {
            offsetSeconds: articleSession.heldOffsetSeconds
          });
          return;
        }
      }
      audio.play?.().catch?.(() => {});
    },
    setRate(value) {
      const nextRate = clampRate(value);
      if (nextRate === rate) return rate;
      rate = nextRate;
      if (audio) audio.playbackRate = rate;
      if (fallbackActive) fallback?.setRate?.(rate);
      publish();
      return rate;
    },
    getRate() { return rate; },
    stop() {
      abandonArticleSession();
      invalidateMedia();
      stopFallback();
      state = 'idle';
      mode = 'idle';
      articleId = null;
      currentIndex = null;
      pendingIndex = null;
      currentTime = 0;
      duration = 0;
      completion = emptyCompletion();
      publish();
    }
  };
}

function createAudio(AudioClass) {
  if (typeof AudioClass !== 'function') return null;
  try {
    return new AudioClass();
  } catch {
    return null;
  }
}

function emptyCompletion() {
  return { reachedEnd: false, coverage: 0, counted: false };
}

function articlePath(articleId, index) {
  return `/api/tts/articles/${encodeURIComponent(articleId)}/sentences/${index}`;
}

function clampRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1.5, Math.max(0.5, numeric));
}

function mediaTime(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}
