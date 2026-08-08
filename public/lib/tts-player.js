export function createTtsPlayer({
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  Audio: AudioClass = globalThis.Audio,
  URL: urlApi = globalThis.URL,
  fallback
} = {}) {
  const audio = createAudio(AudioClass);
  const nativeHlsSupported = Boolean(
    audio?.canPlayType?.('application/vnd.apple.mpegurl')
  );
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
  let backgroundMode = 'sentence';

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
      fallbackActive,
      backgroundMode
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
    if (pause && (activeUrl || audio?.src)) audio?.pause?.();
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
    backgroundMode = 'sentence';
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
    backgroundMode = 'web-speech';
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

    backgroundMode = 'sentence';

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

    const objectUrl = await fetchObjectUrl(
      articlePath(session.articleId, index, session.profile), token
    );
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
        prefetch(articlePath(session.articleId, index + 1, session.profile));
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

  async function playHlsArticle(session, index, {
    offsetSeconds = 0,
    mediaRetryCount = 0,
    eligibleFromStart = null
  } = {}) {
    if (!session || articleSession !== session) return false;
    const token = generation;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    backgroundMode = 'hls';
    pendingIndex = index;
    state = 'loading';
    mode = 'article';
    articleId = session.articleId;
    publish();

    let response;
    let payload;
    try {
      let cursor = null;
      for (let requestCount = 0; requestCount < 1000; requestCount += 1) {
        const params = new URLSearchParams();
        if (session.profile) params.set('profile', session.profile);
        if (cursor != null) params.set('cursor', String(cursor));
        const query = params.size ? `?${params}` : '';
        response = await fetchImpl?.(
          `/api/tts/articles/${encodeURIComponent(session.articleId)}/hls/prepare${query}`,
          { credentials: 'same-origin', signal: controller?.signal }
        );
        if (!response?.ok || token !== generation || articleSession !== session) {
          throw new Error('HLS preparation failed');
        }
        payload = await response.json();
        if (payload?.ready !== false) break;
        if (!Number.isSafeInteger(payload.nextCursor) || payload.nextCursor < 1) {
          throw new Error('HLS preparation cursor is invalid');
        }
        cursor = payload.nextCursor;
      }
      if (payload?.ready === false) throw new Error('HLS preparation did not finish');
    } catch {
      if (activeController === controller) activeController = null;
      if (token !== generation || articleSession !== session) return false;
      backgroundMode = 'sentence';
      return playArticleIndex(index, { offsetSeconds });
    }
    if (activeController === controller) activeController = null;

    const timeline = normalizeHlsTimeline(payload?.sentences, session.texts.length);
    if (!timeline || !payload?.playlistUrl) {
      backgroundMode = 'sentence';
      return playArticleIndex(index, { offsetSeconds });
    }
    session.hls = {
      timeline,
      totalDuration: Number(payload.durationSeconds) || timeline.at(-1).endSeconds,
      lastGlobalTime: 0,
      eligibleFromStart: eligibleFromStart || new Set(),
      seekPending: true,
      retryCount: mediaRetryCount,
      playlistUrl: String(payload.playlistUrl)
    };

    let metadataResolve;
    const metadata = new Promise(resolve => {
      metadataResolve = resolve;
      activeMetadataResolve = resolve;
    });
    const handlePlayRejection = error => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      if (error?.name !== 'NotAllowedError') {
        audio.onerror?.();
        return;
      }
      session.heldIndex = null;
      session.heldOffsetSeconds = 0;
      pendingIndex = null;
      state = 'paused';
      syncHlsPosition(session, { countCompletion: false });
    };
    session.hls.handlePlayRejection = handlePlayRejection;
    audio.onloadedmetadata = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      const targetIndex = index;
      const sentence = session.hls.timeline[targetIndex];
      const requested = Math.max(
        0,
        Number(
          offsetSeconds
        ) || 0
      );
      const sentenceOffset = requested > sentence.durationSeconds ? 0 : requested;
      const target = sentence.startSeconds + sentenceOffset;
      if (sentenceOffset <= 0.001) session.hls.eligibleFromStart.add(sentence.index);
      session.hls.controlSeekIndex = targetIndex;
      audio.currentTime = target;
      session.hls.lastGlobalTime = target;
      session.hls.seekPending = true;
      currentTime = sentenceOffset;
      duration = sentence.durationSeconds;
      publish();
      if (activeMetadataResolve === metadataResolve) activeMetadataResolve = null;
      metadataResolve(true);
    };
    audio.ondurationchange = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      syncHlsPosition(session, { countCompletion: false, makeAudible: false });
    };
    audio.ontimeupdate = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      syncHlsPosition(session, { countCompletion: !session.hls.seekPending });
    };
    audio.onseeking = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      session.hls.seekPending = true;
    };
    audio.onseeked = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      const destination = hlsSentenceAt(session.hls.timeline, mediaTime(audio.currentTime));
      if (!Number.isInteger(session.hls.controlSeekIndex) && destination) {
        session.hls.eligibleFromStart.delete(destination.index);
      }
      session.hls.controlSeekIndex = null;
      session.hls.lastGlobalTime = mediaTime(audio.currentTime);
      session.hls.seekPending = false;
      syncHlsPosition(session, { countCompletion: false });
    };
    audio.onplay = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      if (!session.playIntent) {
        audio.pause?.();
        state = 'paused';
        publish();
        return;
      }
      pendingIndex = null;
      session.heldIndex = null;
      session.heldOffsetSeconds = 0;
      session.hls.seekPending = false;
      session.hls.controlSeekIndex = null;
      state = 'speaking';
      syncHlsPosition(session, { countCompletion: false });
    };
    audio.onpause = () => {
      if (
        token !== generation || articleSession !== session || !session.hls
        || audio.ended === true || state !== 'speaking'
      ) return;
      state = 'paused';
      syncHlsPosition(session, { countCompletion: false });
    };
    audio.onended = () => {
      if (token !== generation || articleSession !== session || !session.hls) return;
      syncHlsPosition(session, { countCompletion: true });
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
      if (token !== generation || articleSession !== session || !session.hls) return;
      syncHlsPosition(session, { countCompletion: false });
      if (session.hls.retryCount < 1) {
        const resumeIndex = currentIndex;
        const resumeOffsetSeconds = currentTime;
        const eligible = new Set(session.hls.eligibleFromStart);
        invalidateMedia();
        session.hls = null;
        void playHlsArticle(session, resumeIndex, {
          offsetSeconds: resumeOffsetSeconds,
          mediaRetryCount: 1,
          eligibleFromStart: eligible
        });
        return;
      }
      session.heldIndex = currentIndex;
      session.heldOffsetSeconds = currentTime;
      session.hls = null;
      session.preferHls = false;
      backgroundMode = 'sentence';
      state = 'paused';
      publish();
    };
    audio.src = session.hls.playlistUrl;

    const ready = await metadata;
    if (!ready || token !== generation || articleSession !== session) return false;
    if (!session.playIntent) {
      pendingIndex = null;
      state = 'paused';
      publish();
      return false;
    }
    try {
      await audio.play();
      return true;
    } catch (error) {
      handlePlayRejection(error);
      return false;
    }
  }

  function syncHlsPosition(session, {
    countCompletion = false,
    makeAudible = true
  } = {}) {
    if (!session?.hls?.timeline?.length) return false;
    const globalTime = Math.max(0, mediaTime(audio.currentTime));
    const previousTime = session.hls.lastGlobalTime;
    if (countCompletion && globalTime >= previousTime) {
      for (const sentence of session.hls.timeline) {
        if (sentence.endSeconds > previousTime && sentence.endSeconds <= globalTime) {
          if (session.hls.eligibleFromStart.has(sentence.index)) {
            session.completed.add(sentence.index);
          }
          const nextSentence = session.hls.timeline[sentence.index + 1];
          if (nextSentence) session.hls.eligibleFromStart.add(nextSentence.index);
        }
      }
    }
    session.hls.lastGlobalTime = globalTime;
    const sentence = hlsSentenceAt(session.hls.timeline, globalTime);
    if (!sentence) return false;
    if (makeAudible) currentIndex = sentence.index;
    currentTime = Math.max(0, Math.min(sentence.durationSeconds, globalTime - sentence.startSeconds));
    duration = sentence.durationSeconds;
    updateCompletion(false);
    publish();
    return true;
  }

  function seekHls(index) {
    const session = articleSession;
    const sentence = session?.hls?.timeline?.[index];
    if (!session || !sentence) return false;
    session.playIntent = true;
    session.hls.eligibleFromStart.add(sentence.index);
    session.hls.controlSeekIndex = sentence.index;
    session.hls.seekPending = true;
    session.hls.lastGlobalTime = sentence.startSeconds;
    audio.currentTime = sentence.startSeconds;
    currentIndex = sentence.index;
    currentTime = 0;
    duration = sentence.durationSeconds;
    state = 'speaking';
    publish();
    audio.play?.().catch?.(error => session.hls?.handlePlayRejection?.(error));
    return true;
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
      profile: options.profile || '',
      preferHls: nativeHlsSupported && Boolean(fetchImpl),
      resolve: resolveSession,
      legacyUnsubscribe: null
    };
    const session = articleSession;
    const unsubscribe = typeof options.onState === 'function'
      ? subscribeWithoutInitial(options.onState)
      : null;
    if (nativeHlsSupported && fetchImpl) {
      void playHlsArticle(session, nextIndex, { offsetSeconds: options.offsetSeconds });
    } else {
      void playArticleIndex(nextIndex, { offsetSeconds: options.offsetSeconds });
    }
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
      const profile = options?.profile
        ? `&profile=${encodeURIComponent(options.profile)}`
        : '';
      return playPoint(
        `/api/tts/words/${encodeURIComponent(wordId)}?mode=${encodeURIComponent(wordMode)}${profile}`,
        text,
        options
      );
    },
    speakArticleSentence(nextArticleId, index, text, options = {}) {
      return playPoint(articlePath(nextArticleId, index, options.profile), text, {
        ...options,
        nextPath: options.nextIndex != null
          ? articlePath(nextArticleId, options.nextIndex, options.profile)
          : null
      });
    },
    startArticle,
    previousSentence() {
      if (!articleSession || !Number.isInteger(currentIndex) || currentIndex === 0) {
        return false;
      }
      if (articleSession.hls) return seekHls(currentIndex - 1);
      articleSession.playIntent = true;
      void playArticleIndex(currentIndex - 1);
      return true;
    },
    replayCurrentSentence() {
      if (!articleSession || !Number.isInteger(currentIndex)) return false;
      if (articleSession.hls) return seekHls(currentIndex);
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
      if (articleSession.hls) return seekHls(currentIndex + 1);
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
      if (articleSession?.hls && mode === 'article') {
        state = 'paused';
        syncHlsPosition(articleSession, { countCompletion: false });
        return;
      }
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
          const heldIndex = articleSession.heldIndex;
          const heldOptions = { offsetSeconds: articleSession.heldOffsetSeconds };
          if (articleSession.preferHls) void playHlsArticle(articleSession, heldIndex, heldOptions);
          else void playArticleIndex(heldIndex, heldOptions);
          return;
        }
      }
      audio.play?.().catch?.(error => {
        if (articleSession?.hls) articleSession.hls.handlePlayRejection?.(error);
      });
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
    syncMediaPosition() {
      if (!articleSession?.hls) return false;
      return syncHlsPosition(articleSession, { countCompletion: true });
    },
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
      backgroundMode = 'sentence';
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

function normalizeHlsTimeline(value, sentenceCount) {
  if (!Array.isArray(value) || value.length !== sentenceCount) return null;
  const timeline = [];
  let previousEnd = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const startSeconds = Number(item?.startSeconds);
    const durationSeconds = Number(item?.durationSeconds);
    if (
      item?.index !== index || !Number.isFinite(startSeconds) || startSeconds < 0
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0
      || Math.abs(startSeconds - previousEnd) > 0.01
    ) return null;
    const sentence = {
      index,
      startSeconds,
      durationSeconds,
      endSeconds: startSeconds + durationSeconds
    };
    timeline.push(sentence);
    previousEnd = sentence.endSeconds;
  }
  return timeline;
}

function hlsSentenceAt(timeline, value) {
  if (!timeline?.length) return null;
  const time = Math.max(0, Number(value) || 0);
  let low = 0;
  let high = timeline.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle].startSeconds <= time) low = middle + 1;
    else high = middle - 1;
  }
  return timeline[Math.max(0, Math.min(timeline.length - 1, high))];
}

function articlePath(articleId, index, profile = '') {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  return `/api/tts/articles/${encodeURIComponent(articleId)}/sentences/${index}${query}`;
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
