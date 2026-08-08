# iOS HLS Background Read-Aloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make full-article read-aloud continue across sentence boundaries on an iOS 18.6 locked-screen PWA, while fixing the floating timer icon's dead touch area.

**Architecture:** Add a pure Packed Audio/HLS module and an authenticated TTS HLS API that prepares every sentence, derives an exact MP3 timeline, and exposes a native VOD playlist. Extend the existing single-element TTS player to select native HLS through `canPlayType`, map global media time back to sentence state, and retain the current per-sentence player as fallback. Fix the timer control at the button hit-target boundary and cover it with DOM behavior tests.

**Tech Stack:** Cloudflare Workers JavaScript, R2, D1, Azure TTS REST, RFC 8216 Packed Audio, browser `HTMLAudioElement`, Node test runner, JSDOM.

## Global Constraints

- Target iOS version: iOS 18.6 installed PWA.
- HLS activation uses `audio.canPlayType('application/vnd.apple.mpegurl')`, never UA sniffing.
- Existing Azure profiles, dialogue role selection, R2 audio cache, TTS budget, checkpoint schema, Web Speech fallback, and 80% completion rule remain compatible.
- HLS preparation must finish before playback; a partial playlist is never returned.
- Packed Audio MP3 segments start with the RFC 8216 ID3 `PRIV` transport timestamp.
- Non-native-HLS platforms retain the existing per-sentence implementation.
- Production changes follow failing-test-first TDD.

---

### Task 1: Packed Audio primitives

**Files:**
- Create: `src/hls-audio.js`
- Create: `tests/hls-audio.test.js`

**Interfaces:**
- Produces: `parseMp3Duration(bytes: Uint8Array): { durationSeconds: number, sampleRate: number, samples: number }`
- Produces: `createTransportTimestampTag(ticks: number | bigint): Uint8Array`
- Produces: `prependTransportTimestamp(bytes: Uint8Array, ticks: number | bigint): Uint8Array`
- Produces: `createMediaPlaylist({ segments }): string`, where each segment contains `durationSeconds`, `url`, and `startTicks`.

- [ ] **Step 1: Write failing MP3 parser tests**

Build deterministic MPEG-2 Layer III frames with 24 kHz sample rate and 48 kbit/s bitrate. Assert that two 576-sample frames produce `1152 / 24000` seconds and malformed data throws an error whose code is `INVALID_MP3`.

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `node --test tests/hls-audio.test.js`

Expected: FAIL because `src/hls-audio.js` does not exist.

- [ ] **Step 3: Implement the minimal frame parser**

Skip an optional ID3v2 header, scan complete Layer III frames, use the MPEG version-specific bitrate/sample-rate tables, sum samples, and reject data with no valid complete frame.

- [ ] **Step 4: Write and verify failing ID3/playlist tests**

Assert the tag begins with `ID3`, contains a `PRIV` frame and the owner string `com.apple.streaming.transportStreamTimestamp`, stores an eight-byte big-endian 33-bit timestamp, and that the playlist contains accurate `EXTINF`, integer `TARGETDURATION`, fingerprinted URLs, and `ENDLIST`.

- [ ] **Step 5: Implement ID3 and playlist generation, then verify GREEN**

Run: `node --test tests/hls-audio.test.js`

Expected: PASS.

### Task 2: Authenticated article HLS API

**Files:**
- Create: `src/tts-hls-api.js`
- Create: `tests/tts-hls-api.test.js`
- Modify: `src/index.js`
- Modify: `src/tts-api.js`

**Interfaces:**
- Consumes: `handleTtsApi(request, env, path, userId, runtime)` for existing sentence cache/generation behavior.
- Consumes: Task 1 MP3 and playlist helpers.
- Produces: `handleTtsHlsApi(request, env, path, userId, runtime = {})`.
- Produces: `articleHlsFingerprint({ body, profile }): Promise<string>` for consistent prepare/manifest/segment validation.

- [ ] **Step 1: Write failing prepare API test**

Seed a two-sentence article and cached valid MP3 frames. Call `/api/tts/articles/a1/hls/prepare?profile=aria-narration`; assert status 200, an HLS playlist URL, two exact timeline entries, and total duration.

- [ ] **Step 2: Run the prepare test and verify RED**

Run: `node --test tests/tts-hls-api.test.js`

Expected: FAIL because the handler is missing.

- [ ] **Step 3: Implement bounded preparation**

Read the owned article, validate the existing profile allowlist, process at most 20 sentences per cursor request with concurrency three, reject preparation when any response is non-200, and return `202` with the next cursor until every segment exists. The final request reads the prepared cache, parses durations, and returns JSON containing the article fingerprint and sentence boundaries.

- [ ] **Step 4: Write failing playlist and segment tests**

Assert the playlist rejects a stale fingerprint with 409, emits a VOD playlist with timestamped segment URLs, and the segment endpoint validates ownership/index/fingerprint before returning an MP3 prefixed with the correct ID3 timestamp.

- [ ] **Step 5: Implement playlist and segment responses**

Use `private, no-cache` for playlists and `private, max-age=31536000, immutable` for fingerprinted segments. Preserve the existing TTS response error code when preparation fails.

- [ ] **Step 6: Route the endpoints and verify GREEN**

Add HLS route matching before the existing sentence TTS route in `src/index.js`.

Run: `node --test tests/hls-audio.test.js tests/tts-api.test.js tests/tts-hls-api.test.js`

Expected: PASS.

### Task 3: Native HLS playback state machine

**Files:**
- Modify: `public/lib/tts-player.js`
- Modify: `tests/tts-player.test.js`

**Interfaces:**
- Consumes: `GET /api/tts/articles/:id/hls/prepare?profile=...` returning `{ playlistUrl, sentences, durationSeconds }`.
- Preserves: existing public TTS controller methods and snapshot fields.
- Adds snapshot field: `backgroundMode`, equal to `'hls'`, `'sentence'`, or `'web-speech'`.

- [ ] **Step 1: Write failing native capability and start tests**

Give the controlled audio fake a `canPlayType()` returning `'maybe'`. Assert `startArticle()` requests only the prepare URL, assigns the returned playlist URL directly to `audio.src`, waits for metadata, seeks to `startSeconds + offsetSeconds`, and uses one audio element.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `node --test --test-name-pattern="native HLS" tests/tts-player.test.js`

Expected: FAIL because the player still requests sentence blobs.

- [ ] **Step 3: Implement HLS session setup and time mapping**

Keep per-sentence playback functions intact. Add HLS preparation/session state, direct `src` assignment, metadata seeking, binary/linear boundary mapping, foreground resynchronization hooks exposed through a `syncMediaPosition()` method, and snapshot publication.

- [ ] **Step 4: Write failing seek/control/coverage tests**

Assert previous/current/next seek to exact sentence boundaries, background time jumps remap the current index, manual seeks do not count skipped sentences, natural forward boundary crossings do count them, and natural end retains the 80% rule.

- [ ] **Step 5: Implement HLS controls and completion accounting**

Track the last observed media time and an explicit control-seek flag. Only uninterrupted forward crossings add completed sentence indexes. Reset or retain play intent using the current state machine semantics.

- [ ] **Step 6: Write failing fallback tests and implement one retry**

Preparation failure must enter the existing sentence path. A native media error retries the playlist once from the mapped checkpoint; a second failure publishes a paused/fallback-capable state without losing the checkpoint.

- [ ] **Step 7: Verify player GREEN and regression safety**

Run: `node --test tests/tts-player.test.js tests/speech.test.js tests/media-session.test.js`

Expected: PASS.

### Task 4: Reader integration and timer hit target

**Files:**
- Modify: `public/reader-view.js`
- Modify: `public/styles.css`
- Modify: `public/mobile-fixes.css`
- Modify: `tests/reader-pending-dom.test.js`
- Modify: `tests/mobile-fixes.test.js`

**Interfaces:**
- Consumes: player snapshot `backgroundMode` and `syncMediaPosition()`.
- Preserves: current sleep timer dialog, focus restoration, `aria-expanded`, and all existing toolbar labels.

- [ ] **Step 1: Write failing reader status/resynchronization tests**

Assert HLS loading announces “正在准备后台朗读”, HLS fallback announces “后台连续播放暂不可用，已切换为普通朗读”, and `visibilitychange`/`pageshow` call `syncMediaPosition()` before checkpointing.

- [ ] **Step 2: Verify RED and implement minimal reader integration**

Run the matching `reader-pending-dom` tests, then update `applySpeechState`, visibility, and pageshow handlers without altering other reader flows.

- [ ] **Step 3: Write a failing timer-icon behavior test**

Dispatch a bubbling pointer/click sequence from `[data-action="speech-floating-timer"] [data-icon="timer"]`; assert exactly one `[data-role="sleep-timer-panel"]`, `aria-expanded="true"`, and correct focus restoration after close. Repeat after the icon is replaced by the countdown value.

- [ ] **Step 4: Implement a button-owned hit layer**

Resolve delegated actions from the actual owning button, keep one activation per touch sequence, preserve keyboard `click`, and make the decorative icon unable to create a dead hit region. Remove or narrow the global SVG click-through rule.

- [ ] **Step 5: Verify reader and CSS GREEN**

Run: `node --test tests/reader-pending-dom.test.js tests/mobile-fixes.test.js tests/sleep-timer.test.js`

Expected: PASS.

### Task 5: Documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `public/sw.js`

**Interfaces:**
- No new runtime interface; documents capability boundaries and refreshes the shell cache version for changed static assets.

- [ ] **Step 1: Update runtime documentation**

Describe native HLS preparation, iOS locked-screen behavior, ordinary-player fallback, initial preparation delay, network requirements, and the unchanged sleep-timer scheduling limitation.

- [ ] **Step 2: Bump the service-worker shell cache**

Increment `CACHE_NAME` so installed PWAs receive the updated player, reader, and CSS assets.

- [ ] **Step 3: Run focused verification**

Run: `node --test tests/hls-audio.test.js tests/tts-hls-api.test.js tests/tts-player.test.js tests/reader-pending-dom.test.js tests/mobile-fixes.test.js`

Expected: PASS with no warnings or unhandled rejections.

- [ ] **Step 4: Run the complete suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the planned source, tests, docs, and service-worker files are modified.

- [ ] **Step 6: Record manual acceptance requirement**

Report that automated verification cannot simulate iOS lock-screen scheduling and provide the eight iOS 18.6 steps from the approved design for final device acceptance.
