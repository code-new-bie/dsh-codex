# 1.0 release readiness

This file defines the evidence required before a DSHX release candidate may be promoted to 1.0. It intentionally distinguishes **implemented checks** from **checks that have actually passed on a release candidate**.

## Rule

No item becomes green because code for the check exists. A release candidate is green only when the corresponding GitHub Actions job or documented manual acceptance run has passed for the exact candidate commit/tag.

## Automated gates

| Gate | Evidence implemented in repository | Required result for 1.0 |
|---|---|---|
| Zero-argument launch | `bin/dshx.mjs`, clean-install smoke | pass on supported release artifacts |
| Official DSH composition | `scripts/runtime-smoke.mjs` on Linux/Windows/macOS | pass |
| Frozen source dependency graph | checked-in `package-lock.json`; trusted main-branch RC freeze workflow resolves it with install scripts disabled | lock present and no manifest drift |
| Exact DSH dependency closure | `scripts/verify-dsh-closure.mjs`, source lock and release shrinkwrap | pass |
| DSH ownership boundary | adapter/unit tests + CI ownership assertions | pass |
| Approval/permission fail-closed | approval/permission/subagent authority tests | pass |
| Session resume/durability projection | DSH `agents.resume`, persistence projection and resume tests; persisted model/header wins over machine default | pass |
| Local production transport | no production TCP listener; pinned TUI rejects TCP WebSocket endpoint | pass |
| Cross-platform local IPC data plane | `dshx-ipc-bridge --check` performs real private UDS + WebSocket-framing ping/pong | pass on Linux/Windows/macOS |
| Visible slash-command contract | `scripts/verify-slash-contract.mjs` classifies every pinned Codex command and asserts DSH-backed methods for every runtime-owned command left visible in DSHX | pass |
| Real pinned TUI / Linux + macOS | PTY smoke drives pinned TUI through local IPC, resizes the terminal, and roundtrips a CJK prompt | pass on both Unix release platforms |
| Real pinned TUI / Windows | ConPTY smoke drives pinned TUI through the same local-IPC topology, resizes the terminal, and roundtrips a Chinese prompt | pass |
| Automated CJK/resize sanity | Linux/macOS PTY + Windows ConPTY verify UTF-8 input/echo survives a live resize without process/session loss | pass |
| CI action supply chain | every external `uses:` ref is a current GitHub Action release pinned to a full immutable commit SHA; `test/ci-actions-pins.test.mjs` rejects mutable refs | pass |
| Packaging | platform tarball + static local-import closure check + publishable shrinkwrap derived from the frozen source graph | pass |
| Clean installation | install generated tarball then `dshx --version` + `dshx doctor` | pass on every release platform |
| Release provenance | platform sidecar records Codex pin, DSH pin and SHA-256 of the frozen source `package-lock.json` | present and consistent across artifacts |
| Release artifacts | Linux x64, Windows x64, macOS arm64, macOS x64 | all built |
| Integrity | release `SHA256SUMS` covers tarballs and provenance sidecars | published |
| Codex thin-fork invariants | patch application/build plus CI source assertions | pass |

## Manual UX acceptance gate

Automation can exercise PTY/ConPTY resize and Chinese text, but it cannot establish real **IME composition-state behavior**, mouse behavior, or visual parity. For the exact 1.0 release candidate, perform a side-by-side run against the pinned Codex TUI using the same Windows Terminal dimensions/theme and record pass/fail for:

- Windows Terminal startup, visual reflow after resize, scroll and mouse behavior;
- Chinese IME composition/commit/cancel in the multiline composer;
- wide CJK glyph alignment in transcript/tool/diff cells;
- slash completion and help keyboard behavior;
- model and permission pickers;
- approval and ask-user overlays;
- shell/tool streaming and collapse behavior;
- unified diff review;
- plan/reasoning cells when DSH exposes them;
- steering and Ctrl+C interrupt during an active turn;
- resume picker and restored session/model state;
- status/footer rendering.

Before starting the manual comparison, verify and install the **exact generated Windows artifact** with:

```powershell
./scripts/windows-rc-acceptance.ps1 `
  -Tarball .\dshx-<version>-win32-x64.tgz `
  -ExpectedSha256 <SHA256SUMS value>
```

The harness verifies the artifact hash, performs an isolated global-prefix install, runs `dshx --version` and `dshx doctor`, and prints the exact installed `dshx.cmd` path to use for the Windows Terminal/IME session. Do not substitute a source checkout after this setup.

Any difference is either fixed, documented as a deliberate product difference in `docs/UX-PARITY.md`, or blocks 1.0.

## Promotion procedure

1. Freeze the dependency graph in `package-lock.json`, then freeze the candidate commit on `release/1.0-rc`; Codex/DSH pins must not change during validation.
2. Run the full CI workflow plus the dedicated macOS PTY and Windows ConPTY workflows for that exact commit.
3. Create a prerelease tag (for example `v1.0.0-rc.N`) and require every release-matrix build/clean-install/TUI gate to pass. The RC tag must point at the current `release/1.0-rc` head.
4. Confirm each release sidecar identifies the same frozen source-lock SHA-256 and expected Codex/DSH pins.
5. Run `scripts/windows-rc-acceptance.ps1` against the generated Windows release artifact and its published SHA-256, then use the printed installed launcher for the manual Windows Terminal/CJK/IME side-by-side acceptance run.
6. Resolve every failed gate without weakening a DSH ownership or security boundary.
7. Re-run affected automated and manual gates after fixes.
8. Merge PR #11 only after all RC gates are green; stable `v1.0.0` must point at the current `main` head and the release ledger issues #12–#15 must be closed.

## Current integration note

`release/1.0-rc` is the sole release-candidate integration branch. It is based on the production local-IPC implementation from `agent/production-ipc`; the alternative direct-stdio Codex-client experiment is intentionally excluded because it requires a much larger upstream TUI/client patch and would increase DSHX maintenance ownership.

Older stacked draft PRs remain historical engineering workstreams only. They are not release evidence. The exact `release/1.0-rc` head and its eventual `v1.0.0-rc.N` tag are the only commits whose CI/manual evidence may be used to promote 1.0.
