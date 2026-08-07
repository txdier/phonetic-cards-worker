# Reader Sentence Translation Layout Design

## Goal

Improve the article reading experience when sentence translation mode is active. English remains the primary reading layer; Chinese translations behave like quiet editorial annotations instead of equal-weight cards or repeated controls.

## Scope

This change affects only sentence translation mode in the article reader:

- sentence-unit spacing and paragraph rhythm;
- original/translation visual hierarchy;
- idle, loading, translated, error, and offline translation controls;
- responsive and accessible interaction states.

Original-only mode, full-article translation mode, translation APIs, caching, sentence indexes, highlighting, selection, and read-aloud behavior remain unchanged.

## Selected Direction

Use the approved “light annotation” layout with a quiet annotation gutter.

Each sentence and its translation form one semantic reading unit, but the unit has no card background, border box, or shadow. The original sentence keeps the user-selected reader typography. Its translation appears directly below it with:

- a Chinese sans-serif font;
- a size approximately 82–86% of the original sentence;
- the existing secondary text color;
- a 2px low-contrast teal annotation rule;
- a small gap from its original and a larger gap before the next sentence.

Paragraph spacing remains visibly larger than sentence-unit spacing so the source article structure stays legible. Long translations wrap naturally and are never clamped.

## Translation Controls and States

Controls stay in the annotation layer and never enter the English reading line.

### Idle

An untranslated sentence shows one visually compact “译” affordance plus a short “翻译本句” label in the annotation gutter. The visible treatment is quiet, but its interactive hit area remains at least 44×44 CSS pixels. The full accessible label remains “翻译本句”.

### Loading

The annotation gutter displays the existing loading status. The action is disabled, the layout does not jump, and focus moves to the status only when the action previously owned focus.

### Translated

The translation text is the primary content of the annotation gutter. “重新翻译” becomes a low-emphasis refresh icon aligned to the far edge. It has a 44×44 hit area, a visible keyboard focus state, and a full accessible name.

### Error and Offline

The message stays beside the annotation rule using existing semantic error colors. A retry action remains available with a 44×44 hit area. Error text is not hidden behind hover-only behavior.

## Responsive Behavior

- The layout remains single-column at all widths.
- On narrow screens, translation indentation is reduced to preserve line length.
- Controls never require hover and remain usable by touch.
- The annotation gutter must not introduce horizontal scrolling.
- User-selected reader width, size, and line-height preferences remain authoritative.

## Accessibility

- Preserve the current sentence keyboard and screen-reader behavior.
- All translation actions remain native buttons.
- Maintain visible focus rings and 44×44 minimum hit areas.
- Use existing theme tokens so light and dark themes retain sufficient contrast.
- Loading, error, and offline messages retain their current live-region semantics.
- Color is not the sole indication of state: text, icons, and status labels remain available.

## Implementation Boundaries

Prefer CSS changes and small markup/class adjustments inside the existing sentence translation renderer. Do not change API contracts, translation state management, persistence, or article data. Reuse existing color and typography variables rather than adding a parallel design system.

## Verification

Automated coverage must verify:

- sentence mode renders original and translation in the approved hierarchy;
- idle and translated controls use the intended compact presentation while retaining accessible labels;
- loading, error, offline, focus-restoration, and retry behavior still works;
- translations remain unclamped and stable on mobile;
- original and full-translation modes are unaffected;
- the complete test suite passes.

Visual verification should cover desktop and narrow mobile widths in both light and dark themes, including a long Chinese translation and a mix of translated and untranslated sentences.
