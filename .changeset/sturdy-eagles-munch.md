---
type: Fixed
pr: 5322
---
**OpenCode 2.x plugin loads again, and its guards actually run** — the plugin now exports a v2 `setup(ctx)` entrypoint alongside the v1 `server()` hook map (v2 rejected the v1-only export), and hook scripts run under node/bun (override with `GSD_HOOK_RUNTIME`) instead of OpenCode's own binary, which silently skipped every guard and leaked ~14 MB to `/tmp` per spawn. (#4916, #4849)
