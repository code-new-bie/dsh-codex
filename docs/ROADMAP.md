# Roadmap

All milestones obey one rule: **DSHX owns presentation; DeepSeek Harness owns runtime capabilities.** A feature is complete only when it is delivered through official DSH services rather than copied into DSHX.

## M0 — Protocol/TUI proof — complete

- pinned Codex TUI can run without Codex Agent ownership;
- deterministic protocol fixtures cover bootstrap/thread/turn/streaming/interrupt;
- Codex protocol vocabulary is isolated at the TUI boundary.

Historical WebSocket/remote experiments are not production architecture.

## M1 — DSH public-API daily loop — complete at contract level

Implemented through DSH-owned services/events:

- start/resume/list/history;
- response and reasoning streaming;
- model selection;
- tool/shell/file/diff presentation;
- approvals and user questions;
- steering and Ctrl+C;
- token/context/footer projection where exposed;
- skills, fork, compaction and subagent presentation boundaries;
- fail-closed behavior for unsupported semantics.

Release evidence remains governed by `RELEASE-READINESS.md`.

## M2 — Standard plugin/runtime ownership — complete at architecture level

- package declares `dsh.bundle.patch`;
- official `dsh plugin --profile tui add/remove` owns installation/reconciliation;
- `dsh --profile tui` is the sole runtime and Loader owner;
- `dshx-startup` + `dshx-presentation` are ordinary Cordis rows;
- `dshx` is a thin bootstrap over the user's DSH launcher;
- no private DSH composition or production DSH dependency is shipped.

## M3 — Native transport simplification — implementation complete; platform evidence required

Final topology:

```text
official DSH parent
  └─ pinned native TUI child
       ⇅ anonymous directional process pipes
```

The production bridge, UDS/WebSocket carrier, local server and TUI-owned backend child are retired. The thin fork restores terminal stdin before crossterm initialization and uses separate inherited descriptors for protocol input/output.

Exit evidence:

- Linux `cargo --locked` + PTY/CJK/resize;
- macOS PTY/CJK/resize;
- Windows ConPTY/CJK plus correct CRT/Win32 stdin restoration;
- standard-bundle live initialize and teardown.

## M4 — Codex UX parity — automated coverage implemented; manual IME gate required

The pinned TUI supplies the upstream composer, slash interactions, pickers, overlays, cells, scroll/mouse/resize and footer behavior. DSHX only hides or adapts runtime semantics that DSH cannot faithfully provide.

The final 1.0 blocker here is a side-by-side Windows Terminal run with the exact generated artifact, including Chinese IME compose/commit/cancel and wide-glyph alignment.

## M5 — Packaging/release closure — in progress until exact-SHA gates are green

A final candidate must prove:

- TUI-only native artifact; no bridge executable;
- no second DSH runtime in a clean installation;
- official plugin activation/removal;
- Core + Linux native CI green on exact SHA;
- Windows + macOS RC platform gates green on that same SHA;
- release matrix/provenance/checksums green;
- manual Windows Terminal/IME parity recorded.

Additional DSH-specific UI surfaces (jobs/workflows, plugin diagnostics, future commands) are post-1.0 presentation work unless the acceptance matrix promotes them to blockers.
