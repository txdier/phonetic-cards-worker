function setAction(mediaSession, name, handler) {
  try {
    mediaSession?.setActionHandler?.(name, handler);
    return true;
  } catch {
    return false;
  }
}

function setPlaybackState(mediaSession, state) {
  if (!mediaSession) return;
  try {
    mediaSession.playbackState = state === 'speaking'
      ? 'playing'
      : state === 'paused'
        ? 'paused'
        : 'none';
  } catch {
    // Media Session can be unavailable or reject writes in some browsers.
  }
}

function setMetadata(mediaSession, MediaMetadata, { title, author, sentence }) {
  if (!mediaSession || typeof MediaMetadata !== 'function') return;
  try {
    mediaSession.metadata = new MediaMetadata({
      title,
      artist: author,
      album: sentence
    });
  } catch {
    // Metadata is optional and must not affect in-page controls.
  }
}

export function createMediaSessionBridge({ mediaSession, MediaMetadata } = {}) {
  const callbacks = {};
  const registeredActions = new Set();

  function applyAction(name, callback) {
    const handler = typeof callback === 'function' ? callback : null;
    if (setAction(mediaSession, name, handler)) registeredActions.add(name);
  }

  function updateSentenceActions(currentIndex, sentenceCount) {
    const hasCurrentSentence = Number.isInteger(currentIndex) && currentIndex >= 0
      && Number.isInteger(sentenceCount) && sentenceCount > 0
      && currentIndex < sentenceCount;
    applyAction(
      'previoustrack',
      hasCurrentSentence && currentIndex > 0 ? callbacks.previous : null
    );
    applyAction(
      'nexttrack',
      hasCurrentSentence && currentIndex < sentenceCount - 1 ? callbacks.next : null
    );
  }

  return {
    bind({ play, pause, previous, current, next } = {}) {
      Object.assign(callbacks, { play, pause, previous, current, next });
      applyAction('play', callbacks.play);
      applyAction('pause', callbacks.pause);
      applyAction('previoustrack', callbacks.previous);
      applyAction('seekbackward', callbacks.current);
      applyAction('nexttrack', callbacks.next);
    },

    update({ state, currentIndex, sentenceCount, title, author, sentence } = {}) {
      applyAction('play', callbacks.play);
      applyAction('pause', callbacks.pause);
      applyAction('seekbackward', callbacks.current);
      updateSentenceActions(currentIndex, sentenceCount);
      setPlaybackState(mediaSession, state);
      setMetadata(mediaSession, MediaMetadata, { title, author, sentence });
    },

    cleanup() {
      for (const name of registeredActions) setAction(mediaSession, name, null);
      registeredActions.clear();
      if (mediaSession) {
        try {
          mediaSession.metadata = null;
          mediaSession.playbackState = 'none';
        } catch {
          // Cleanup should stay safe when Media Session is partially supported.
        }
      }
    }
  };
}
