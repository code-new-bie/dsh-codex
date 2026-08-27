# Roadmap

All milestones obey one ownership rule: **DSHX maintains the TUI, launcher, transport and thin public-API adapter only. DeepSeek Harness capabilities remain upstream-owned.**

Milestone status describes implementation progress. A 1.0 release requires the independent evidence in `RELEASE-READINESS.md`.

## Milestone 0 — Codex TUI protocol proof — complete

Goal: prove that the pinned Codex TUI can be driven without Codex's agent runtime.

Delivered:

- pinned Codex and DSH upstream references;
- deterministic app-server-compatible development stub;
- bootstrap/thread/turn/streaming/interrupt protocol proof;
- zero-argument development launcher;
- thin-fork patches proving the Codex TUI can run with DSHX as its backend.

The historical TCP/WebSocket path is retained only as a development fixture and is excluded from the production package.

## Milestone 1 — Official DSH public-API adapter / daily coding loop — implementation complete, RC evidence pending

Delivered through official DSH public APIs/events:

- session start/resume/list/history projection;
- response + reasoning streaming;
- specialized shell/tool/file/diff presentation where DSH exposes faithful semantics;
- approval and ask-user presentation with DSH policy authoritative;
- steering and Ctrl+C interrupt;
- model/provider/reasoning picker backed by official DSH registry/resolution;
- context/token/footer projection where DSH exposes the data;
- skills discovery;
- fork, compaction and subagent boundaries delegated to DSH-owned services;
- fail-closed ownership tests preventing local execution/runtime duplication.

Exit gate: the exact release candidate must pass the automated daily-loop/PTY gates and real dogfooding; implementation alone does not declare the milestone release-green.

## Milestone 2 — Codex UX parity — thin-fork parity implemented; manual terminal acceptance pending

Implemented/inherited from the pinned Codex TUI:

- welcome screen, composer and slash-command interaction;
- model and permission pickers;
- resume picker using DSH session data;
- approval and ask-user overlays;
- tool/shell/diff/plan/reasoning cells;
- steering/interrupt behavior;
- Codex-native scroll, mouse and resize behavior;
- status/footer rendering where DSH exposes data.

Unsupported Codex runtime semantics are explicitly hidden/rejected rather than silently emulated. See `DSH-CAPABILITY-MATRIX.md`.

Exit gate still pending: side-by-side Windows Terminal + Chinese IME/CJK acceptance against the pinned Codex TUI using the exact generated release-candidate artifact.

## Milestone 3 — Additional DSH capability surfaces (presentation only) — partial

Implemented where official seams are stable:

- Skills discovery/UI feed.
- Subagent thread/status presentation and DSH-owned interruption authority.

Future presentation-only candidates:

- Jobs/workflows UI.
- Plugin diagnostics/configuration UI where DSH exposes a stable product-facing seam.
- Additional DSH-specific commands that do not disturb Codex-compatible commands.

This milestone is not a blocker for the core 1.0 daily coding loop unless a listed capability is required by the final product acceptance matrix.

## Milestone 4 — Production packaging and 1.0 gate — implementation complete, external validation pending

Implemented:

- `dshx` zero-argument startup with no manual bridge/profile/remote command;
- pinned Codex TUI included in platform release artifacts;
- packaged cross-platform `dshx-ipc-bridge` using Codex `codex_uds`;
- production Unix-socket transport with no TCP listener / bearer-token loopback dependency;
- real local-IPC data-plane self-check in `dshx doctor`;
- exact supported DSH release closure and compatibility gates;
- DSH-owned session durability/resume projection tests;
- approval/permission/subagent fail-closed tests;
- Linux x64, Windows x64, macOS arm64 and macOS x64 release jobs;
- clean-install artifact smoke and SHA-256 checksums;
- Linux real pinned-TUI PTY smoke in CI **and tagged release workflow**;
- Codex/DSH pin + patch-queue sync model;
- explicit RC promotion checklist in `RELEASE-READINESS.md`.

## Milestone 5 — Standard profile-bundle delivery — implementation complete, real-session acceptance pending

The surface ships as a regular DSH profile bundle instead of a bespoke launcher runtime:

- the package manifest declares `dsh.bundle.patch`; official `dsh plugin --profile <p> add/remove` installs, layers, reconciles and withdraws the surface;
- loader-mounted rows (`dshx-startup`, `dshx-presentation`) own launch parameters, transport and endpoint publication; lifecycle authority is the Cordis root Fiber;
- `bin/dshx` is a thin bootstrap over the same official command (idempotent, version-pinned), and bare `dsh --profile tui` serves the endpoint passively with a visible listening hint;
- the Codex dialect is confined to `src/tui-protocol/`, enforced structurally by the ownership guard;
- per-platform release tarballs embed the pinned TUI + bridge and activate with zero environment overrides;
- verification: `npm run verify:bundle` proves dev-flow and release-flavor delivery end to end (reconcile, composed-tree assertions, activation, single-instance rule); CI gates it in the Linux TUI job.

Exit gate: one real interactive dogfooding session plus the Windows Terminal/CJK/IME acceptance already required for 1.0.

1.0 may ship only when the exact candidate has green CI/release evidence and the manual Windows Terminal/CJK/IME UX acceptance is recorded as passing.
