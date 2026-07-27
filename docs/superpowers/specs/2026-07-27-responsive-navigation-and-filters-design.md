# Responsive Navigation and Filters Design

## Goal

Correct two responsive layout problems without changing navigation or filtering behavior:

1. On mobile, present account controls before the module navigation in a familiar two-row application header.
2. On desktop, keep the word-library filter toolbar aligned with the existing 920px content column.

## Mobile header

At viewport widths of 640px or less, the top navigation remains a two-row layout:

```text
┌──────────────────────────────────┐
│ username         [theme] [logout] │
├──────────────────────────────────┤
│ [      words      ][   articles  ] │
└──────────────────────────────────┘
```

The account actions appear on the first row. The username stays on the left and may shrink or truncate if space is limited; the theme and logout buttons stay grouped on the right with full touch targets. The module tabs appear on the second row and remain equal-width buttons.

Desktop navigation order and layout remain unchanged.

## Desktop word filters

The word-library filter form uses the same maximum width and horizontal centering as `.pc-header`, `.pc-grid`, and the other primary content blocks:

- Maximum width: 920px.
- Horizontal margins: automatic.
- Existing grid columns and controls remain unchanged at desktop widths.
- Existing single-column mobile behavior remains unchanged.

## Implementation boundaries

The fix is limited to markup ordering support and responsive CSS:

- Preserve current labels, click handlers, routes, theme persistence, and logout behavior.
- Use CSS ordering at the mobile breakpoint so desktop DOM order and layout are unaffected.
- Add the missing content-width constraint to the filter toolbar.
- Do not introduce a dropdown menu or new JavaScript interactions.

## Verification

Add static CSS regression assertions that demonstrate the current stylesheet is missing:

- The desktop filter toolbar has a 920px maximum width and is horizontally centered.
- At the mobile breakpoint, account actions render before module tabs.
- The mobile account row keeps the username separate from a right-aligned action group.

Run the targeted regression test first and confirm it fails, apply the minimal CSS fix, then run the complete test suite. Finally, inspect representative desktop and mobile viewport renders to confirm visual alignment and absence of horizontal overflow.
