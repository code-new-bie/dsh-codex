# 1.0 release readiness

This document defines the evidence required before a DSHX release candidate can be promoted. A check is green only when it passes for the **exact candidate SHA/artifact**; the existence of a test is not evidence by itself.

## Required architecture

A candidate is invalid regardless of test results if any of these are false:

- the package is a standard DSH bundle (`dsh.bundle.patch`);
- the user's installed `dsh --profile tui` process is the sole DSH runtime/Loader owner;
- the presentation row starts only the pinned native TUI child;
- TUI protocol I/O uses anonymous directional child-process pipes;
- no production TCP/WebSocket/UDS listener, bridge executable or Node local server exists;
- the TUI does not spawn a DSH/backend child;
- DSH owns Agent, Session, models, tools, sandbox, approvals, skills, subagents and persistence;
- Codex dialect code remains confined to the TUI protocol boundary;
- production installation does not materialize a second DSH runtime or hard-block an untested host version.

## Automation tiers

- **PR/main CI:** Node 24 core gate, then Linux native TUI/build/bundle/PTY gate.
- **RC platform gate:** release-head PRs or explicit dispatch run Windows ConPTY and macOS PTY/CJK/resize against an exact SHA.
- **Release tag:** `v*` builds platform tarballs, verifies standard bundle activation, clean-installs artifacts, runs native UI gates and publishes provenance/checksums.
- **Dependency freeze:** generated outside CI with Node 24/npm 11, reviewed and committed; CI consumes it with `npm ci`.

## Automated gates

| Gate | Evidence | Required |
|---|---|---|
| Frozen dependency graph | checked-in `package-lock.json` | no manifest drift |
| Tested DSH closure | `scripts/verify-dsh-closure.mjs` | pass |
| Ownership boundary | unit tests + `scripts/verify-ownership-boundary.mjs` | pass |
| Official profile lifecycle | `scripts/runtime-smoke.mjs` | Loader settle → directional initialize → child exit → `appExit` |
| Standard bundle delivery | `scripts/verify-bundle-install.mjs` | pack/add/dump/activate/single-runtime pass |
| Thin-fork materialization/build | build scripts + `scripts/verify-tui-invariants.mjs` | pass with pinned Codex and `cargo --locked` |
| No backend child | thin-fork guard | TUI contains no DSH/backend `Command::new` path |
| No socket/bridge production path | ownership/package guards | pass |
| Visible slash-command contract | `scripts/verify-slash-contract.mjs` | pass |
| Session/model/tool/approval delegation | unit/contract suite | pass/fail-closed |
| Linux native TUI | PTY deterministic directional-pipe test | startup, CJK prompt, resize pass |
| macOS native TUI | RC PTY test | startup, CJK prompt, resize pass |
| Windows native TUI | RC ConPTY test | startup, Chinese prompt, resize pass |
| Packaging | `scripts/package-platform.mjs` | TUI-only platform tarball, local-import closure, frozen shrinkwrap |
| Clean install | release workflow | no second `@deepseek-ai/dsh`; installed launcher/version works |
| Provenance | release sidecar | same source-lock SHA, Codex pin, DSH tested pin, transport contract |
| Integrity | `SHA256SUMS` | covers tarballs and sidecars |
| GitHub Actions pins | `test/ci-actions-pins.test.mjs` | immutable action SHAs |

## Manual Windows Terminal / IME gate

ConPTY can validate Unicode text and resize, but cannot prove real IME composition behavior or visual parity. For the exact Windows RC artifact, compare against the pinned Codex TUI in the same Windows Terminal dimensions/theme and record:

- startup/reflow/scroll/mouse behavior;
- Chinese IME compose/commit/cancel in the multiline composer;
- wide CJK alignment in transcript/tool/diff cells;
- slash completion/help;
- model and permission pickers;
- approval and ask-user overlays;
- tool/shell streaming and collapse behavior;
- unified diff review;
- plan/reasoning presentation when DSH exposes it;
- steering and Ctrl+C during an active DSH turn;
- resume and restored DSH session/model state;
- status/footer rendering.

Prepare the exact artifact with:

```powershell
./scripts/windows-rc-acceptance.ps1 `
  -Tarball .\dshx-<version>-win32-x64.tgz `
  -ExpectedSha256 <SHA256SUMS value>
```

The helper verifies the artifact checksum, performs an isolated install and prints the exact launcher path to use for the manual session. Do not substitute a source checkout after this point.

## Promotion procedure

1. Freeze/review the Node dependency graph and pin the Codex/DSH tested sources.
2. Require the exact SHA to pass Core + Linux native CI.
3. Run the exact same SHA through Windows and macOS RC platform gates.
4. Build a prerelease tag and require every release-matrix build, bundle activation, clean-install and native UI gate to pass.
5. Confirm all sidecars agree on source lock, Codex pin, DSH tested pin and transport identifier.
6. Perform the Windows Terminal/IME side-by-side gate on the generated Windows artifact.
7. Fix failures without weakening DSH ownership/security boundaries; repeat affected gates on a new exact SHA.
8. Promote only when no automated or manual blocker remains.
