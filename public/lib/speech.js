function clampRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1.5, Math.max(0.5, numeric));
}

function emptyCompletion() {
  return { reachedEnd: false, coverage: 0, counted: false };
}

export function createSpeechController({ speechSynthesis, Utterance } = {}) {
  const isSupported = Boolean(speechSynthesis && typeof Utterance === 'function');
  const subscribers = new Set();
  let voices = [];
  let sentences = [];
  let rate = 1;
  let state = 'idle';
  let currentIndex = null;
  let activeUtterance = null;
  let activeOnceEnd = null;
  let generation = 0;
  let enginePaused = false;
  let session = null;
  let completion = emptyCompletion();

  const loadVoices = () => {
    voices = isSupported && typeof speechSynthesis.getVoices === 'function'
      ? speechSynthesis.getVoices() || []
      : [];
  };

  function snapshot(completionEvent = null) {
    return {
      state,
      currentIndex,
      rate,
      completion: { ...completion },
      completionEvent
    };
  }

  function publish(completionEvent = null) {
    const next = snapshot(completionEvent);
    for (const subscriber of subscribers) subscriber(next);
  }

  function invalidateActive() {
    generation += 1;
    activeUtterance = null;
  }

  function settleActiveOnce() {
    const onEnd = activeOnceEnd;
    activeOnceEnd = null;
    onEnd?.();
  }

  function cancelEngine() {
    if (!isSupported) return;
    speechSynthesis.cancel?.();
    if (enginePaused || speechSynthesis.paused === true) speechSynthesis.resume?.();
    enginePaused = false;
  }

  function selectVoice() {
    return voices.find(item => /^en-US$/i.test(item.lang || ''))
      || voices.find(item => /^en(?:-|$)/i.test(item.lang || ''))
      || null;
  }

  function makeUtterance(text, utteranceRate = rate) {
    const utterance = new Utterance(text);
    const voice = selectVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'en-US';
    utterance.rate = clampRate(utteranceRate);
    return utterance;
  }

  function updateCompletion(reachedEnd = false) {
    const total = sentences.length;
    const coverage = total ? session.completed.size / total : 0;
    completion = {
      reachedEnd,
      coverage,
      counted: reachedEnd && coverage >= 0.8
    };
  }

  function finishSessionAtEnd() {
    updateCompletion(true);
    const event = completion.counted ? { ...completion } : null;
    state = 'idle';
    currentIndex = null;
    activeUtterance = null;
    session = null;
    publish(event);
  }

  function speakCurrent() {
    if (!isSupported || !session || currentIndex == null || !sentences[currentIndex]) return;
    const token = ++generation;
    const index = currentIndex;
    const utterance = makeUtterance(sentences[index]);
    activeUtterance = utterance;
    utterance.onstart = () => {
      if (token !== generation || utterance !== activeUtterance) return;
      state = 'speaking';
      publish();
    };
    utterance.onend = () => {
      if (token !== generation || utterance !== activeUtterance || !session) return;
      activeUtterance = null;
      session.completed.add(index);
      updateCompletion(false);
      if (index === sentences.length - 1) {
        finishSessionAtEnd();
        return;
      }
      currentIndex = index + 1;
      speakCurrent();
    };
    utterance.onerror = () => {
      if (token !== generation || utterance !== activeUtterance) return;
      invalidateActive();
      state = 'idle';
      currentIndex = null;
      session = null;
      publish();
    };
    speechSynthesis.speak(utterance);
  }

  loadVoices();
  if (isSupported) speechSynthesis.addEventListener?.('voiceschanged', loadVoices);

  return {
    isSupported,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(snapshot());
      return () => subscribers.delete(subscriber);
    },
    speakOnce(text, options = {}) {
      settleActiveOnce();
      invalidateActive();
      cancelEngine();
      session = null;
      currentIndex = null;
      completion = emptyCompletion();
      if (!isSupported || !String(text || '').trim()) {
        state = 'idle';
        options.onEnd?.();
        publish();
        return;
      }
      const token = ++generation;
      const utterance = makeUtterance(String(text), options.rate ?? rate);
      activeUtterance = utterance;
      activeOnceEnd = options.onEnd || null;
      utterance.onstart = () => {
        if (token !== generation || utterance !== activeUtterance) return;
        state = 'once';
        options.onStart?.();
        publish();
      };
      const finish = () => {
        if (token !== generation || utterance !== activeUtterance) return;
        activeUtterance = null;
        state = 'idle';
        settleActiveOnce();
        publish();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      speechSynthesis.speak(utterance);
    },
    load(nextSentences) {
      settleActiveOnce();
      invalidateActive();
      cancelEngine();
      sentences = Array.isArray(nextSentences)
        ? nextSentences.map(value => String(value ?? '').trim()).filter(Boolean)
        : [];
      session = null;
      currentIndex = null;
      state = 'idle';
      completion = emptyCompletion();
      publish();
    },
    startAt(index = 0) {
      if (!isSupported || !sentences.length) return;
      const nextIndex = Number(index);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= sentences.length) return;
      settleActiveOnce();
      invalidateActive();
      cancelEngine();
      session = { completed: new Set() };
      completion = emptyCompletion();
      currentIndex = nextIndex;
      state = 'speaking';
      speakCurrent();
    },
    pause() {
      if (!isSupported || state !== 'speaking') return;
      speechSynthesis.pause?.();
      enginePaused = true;
      state = 'paused';
      publish();
    },
    resume() {
      if (!isSupported || state !== 'paused') return;
      speechSynthesis.resume?.();
      enginePaused = false;
      state = 'speaking';
      publish();
    },
    stop() {
      settleActiveOnce();
      invalidateActive();
      cancelEngine();
      session = null;
      currentIndex = null;
      state = 'idle';
      completion = emptyCompletion();
      publish();
    },
    setRate(value) {
      const nextRate = clampRate(value);
      if (nextRate === rate) return rate;
      rate = nextRate;
      if (isSupported && session && currentIndex != null && (state === 'speaking' || state === 'paused')) {
        invalidateActive();
        cancelEngine();
        state = 'speaking';
        speakCurrent();
      } else {
        publish();
      }
      return rate;
    },
    getRate() { return rate; },
    getCompletion() { return { ...completion }; },
    cleanup() {
      this.stop();
      subscribers.clear();
      if (isSupported) speechSynthesis.removeEventListener?.('voiceschanged', loadVoices);
    }
  };
}
