# Final floating-speech review fix report

## Scope and root cause

Final review identified that the floating timer used the same unlimited `m:ss`
formatter as the top timer. The floating capsule has a fixed mobile grid column,
so a valid large custom timer value could overflow that column. The timer domain
continues to accept every positive integer minute value; only the floating visual
presentation is compacted.

## Changes

- Added `formatFloatingRemaining(milliseconds)` in `public/reader-view.js`.
  It preserves normal `m:ss` output below 100 minutes and renders `99m+` at
  100 minutes or above. `syncTimerControls()` uses it only for the floating
  timer value; the top timer and floating `aria-label` still use the full
  `formatRemaining()` value.
- Added `data-icon` to every SVG created by `svgIcon(name)`. SVGs remain
  `aria-hidden="true"`; button Chinese `aria-label` values remain the
  accessible names.
- Extended `tests/reader-pending-dom.test.js` to assert every rate-cycle step
  updates the controller, top range, top output, floating visible value, and
  floating `aria-label`.
- Added a 10,000-minute custom timer DOM regression assertion: top text and
  floating `aria-label` retain `10000:00`, while only floating visible text is
  `99m+`.
- Added floating primary-action SVG identity coverage for target, close, pause,
  and play states.

## TDD evidence

1. RED (before formatter production code):

   ```text
   node --test --test-name-pattern "reader exposes direct replay and sleep timer controls for touch use" tests/reader-pending-dom.test.js
   FAIL: '10000:00' !== '99m+'
   ```

2. GREEN (after the display-only formatter):

   ```text
   node --test --test-name-pattern "reader exposes direct replay and sleep timer controls for touch use" tests/reader-pending-dom.test.js
   PASS: 1/1
   ```

3. SVG identifier regression:

   ```text
   node --test --test-name-pattern "reader identifies each floating primary-action icon across speech states" tests/reader-pending-dom.test.js
   RED: undefined !== 'target'

   node --test --test-name-pattern "reader exposes direct replay and sleep timer controls for touch use|reader identifies each floating primary-action icon across speech states" tests/reader-pending-dom.test.js
   GREEN: 2/2
   ```

## Verification commands and results

| Command | Result |
| --- | --- |
| `node --test tests/reader-pending-dom.test.js` | PASS, 84 tests |
| `node --test tests/reader-pending-dom.test.js tests/static-shell.test.js` | PASS, 104 tests |
| `npm.cmd test` | PASS, 327 tests |
| `git diff --check` | PASS, no whitespace errors |

## Self-review

- Confirmed the custom-timer validation remains untouched, so no maximum was
  introduced for positive integer minutes.
- Confirmed only the floating rendered value is capped; exact remaining time is
  retained in the top output and floating button `aria-label`.
- Confirmed rate synchronization assertions now cover all requested DOM values.
- Confirmed `data-icon` is non-visual and existing SVG `aria-hidden` plus the
  authoritative Chinese button labels are retained.
- No browser dependency or unrelated refactor was added. The existing static
  five-column mobile CSS contract is retained.

## Remaining manual verification

Real geometry still requires manual/device verification on iPhone, Android,
320px, 375px, and landscape viewports. This fix intentionally does not add a
heavy browser dependency solely to automate that layout check.
