# Reader and mobile fixes

This change set addresses the following issues:

1. Sentence translation failures caused by overly strict model-output parsing.
2. Long-article sentence translation lookup and context-size failures.
3. Cross-device synchronization of word and article TTS profiles.
4. More reliable PWA background/lock-screen article playback.
5. Sleep-timer icon click targeting on mobile browsers.
6. iOS/PWA auto-zoom when collecting pending terms.
7. Word add/edit form presented as a modal card instead of opening at the page top.
8. Confirms the word library page size remains 24 items.

## Database migration

Apply migration `0011_user_preferences.sql` before deploying:

```bash
wrangler d1 migrations apply phonetic_cards_db --remote
```

## Verification

```bash
npm test
npm run test:all
git diff --check
```

PWA checks should include an installed app, screen lock during article playback, timer-icon taps, pending-term collection, and word editing on a narrow mobile viewport.
