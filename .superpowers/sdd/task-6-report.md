# Task 6 Report: Stable Sentence Translation Slots

## Outcome

Implemented sentence-mode rendering and connected it to the sentence translation cache API.

- Original and full modes retain `<p>` paragraph markup and existing English sentence speech/selection behavior.
- Sentence mode renders valid block paragraph/unit markup with one stable translation slot per global sentence index.
- Entering or restoring sentence mode renders idle slots immediately, then performs one lazy cache GET without generating translations.
- Per-sentence POST state is independent and uses browser SHA-256 source hashes plus request generations.
- Translate, retry, and refresh actions update only their slot; refresh failures retain the prior translation.
- Cache GET failures surface as non-blocking reader errors while idle slot actions remain usable.
- Mode changes and cleanup invalidate pending generations so stale responses cannot mutate current DOM/state.
- Cache and request updates do not rerender the toolbar or translation panel, preserving the Task 5 focus behavior.
- Stable, touch-sized slot styles reserve two translation lines and allow long translations to grow without clamping.

## Files

- `public/reader-view.js`
- `public/styles.css`
- `tests/reader-pending-dom.test.js`
- `tests/static-shell.test.js`

## TDD Evidence

Initial focused RED:

```text
node --test --test-name-pattern="sentence translation (slot|restore|refresh|stale|speech)" tests/reader-pending-dom.test.js
tests 6, pass 0, fail 6
```

The failures were caused by the missing sentence slots, cache GET, actions, and request state. The static slot-style test also failed because the new CSS rules were absent.

After the first GREEN pass, self-review added a slot stability invariant requiring the translated text to live inside the single refresh action. That assertion failed before the render refactor and passed afterward.

## Final Verification

```text
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
tests 124, pass 124, fail 0

npm.cmd test
tests 388, pass 388, fail 0

git diff --check
exit 0
```

The first full-suite attempt exposed timing-sensitive deferred test setup under parallel load. The tests were corrected to wait until the asynchronous SHA-256 path reached the API stub; the final full-suite run above is clean.

## Self-review

- Confirmed GET never triggers sentence POST/AI generation.
- Confirmed sentence actions are excluded from English sentence click/start-selection routing.
- Confirmed cached maps survive leaving sentence mode and are restored without a second successful GET.
- Confirmed ordinary failure, refresh failure, newer-response wins, and post-cleanup completion paths.
- Confirmed no fixed height, max height, overflow clipping, or line clamp on translation content.

No known concerns remain.

## Review Fixes

Addressed the two Important findings from Task 6 review:

- Replaced the translated `<p>` nested inside the refresh `<button>` with phrasing-content `<span>` markup, retaining block layout through `display: block`.
- Replaced one-turn waits after WebCrypto-backed sentence actions with observable polling on POST counts and terminal slot states. No arbitrary sleeps were added.

Review-fix RED:

```text
node --test --test-name-pattern="sentence translation slot renders|sentence translation slots reserve" tests/reader-pending-dom.test.js tests/static-shell.test.js
tests 2, pass 0, fail 2
```

The DOM test reported `P !== SPAN`, and the style test reported the missing `display: block` declaration.

Review-fix focused GREEN:

```text
node --test --test-name-pattern="sentence translation (slot|restore|refresh|stale|speech)|sentence translation slots reserve" tests/reader-pending-dom.test.js tests/static-shell.test.js
tests 7, pass 7, fail 0
```

Requested final verification:

```text
node --test tests/reader-pending-dom.test.js tests/static-shell.test.js
tests 124, pass 124, fail 0
```

Review-fix self-review confirmed that the sentence translation action contains no `<p>`, the translated role is carried by a block-styled `<span>`, and all reviewed post-digest paths wait for API invocation or an observable terminal slot state. Task 5 translation-panel code and focus handling were unchanged.
