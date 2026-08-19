# Contributing

## Development rule

Keep the Codex TUI patch surface small. Prefer adding behavior in the DSH adapter or behind narrow extension points over editing rendering/input code directly.

## Before opening a PR

- Explain whether the change belongs to presentation, protocol translation, or DSH runtime integration.
- Add/adjust protocol mapping tests for adapter changes.
- Add UX parity evidence for visible TUI changes.
- Verify Windows Terminal behavior for input, resize, scrolling and Ctrl+C when relevant.
- Do not add a second persistence layer for sessions or approvals.

## Upstream changes

Changes copied or adapted from `openai/codex` must preserve applicable upstream license notices. Record upstream syncs as dedicated commits and update `upstream/CODEX_COMMIT`.

Changes that depend on DeepSeek Harness behavior must update `upstream/DSH_COMMIT` when the compatibility baseline moves.

## Commit style

Use concise conventional-style subjects where practical, for example:

```text
feat(adapter): map DSH approvals to Codex requests
fix(tui): preserve steering input during tool streaming
test(windows): add resize and interrupt regression case
chore(upstream): sync Codex TUI to <sha>
```
