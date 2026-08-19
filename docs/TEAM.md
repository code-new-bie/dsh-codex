# DSHX delivery team

This repository is organized around six engineering roles. These are workstreams, not ownership of DeepSeek Harness internals.

## 1. Codex TUI upstream

Owns the pinned Codex TUI source, upstream syncs, patch minimization, branding deltas, terminal rendering and keyboard behavior.

**May change:** TUI source and narrow extension points.

**Must not change:** DSH runtime behavior.

## 2. DSH public-API integration

Tracks the public DeepSeek Harness interfaces needed by the TUI and converts them into a stable adapter boundary.

**May change:** adapter calls, compatibility detection and graceful unsupported states.

**Must not implement:** agent loop, session engine, tools, sandbox, approval policy, skills, subagents, jobs or workflows.

## 3. Protocol mapping

Owns Codex Thread/Turn/Item ↔ DSH public event/API projections and compatibility tests. Unknown or unsafe permission semantics fail closed.

## 4. Terminal and Windows UX

Owns side-by-side Codex parity on Windows Terminal first, plus Linux/macOS, resize, scrolling, mouse, CJK/IME, Ctrl+C and shell/terminal edge cases.

## 5. QA and security

Owns protocol fixtures, regression tests, crash/reconnect tests, approval fail-closed checks and release blockers. Visual completeness alone can never pass a release gate.

## 6. Release and upstream operations

Owns `dshx` packaging, reproducible builds, checksums, `dshx doctor`, platform artifacts and upstream pin/sync policy.

## Non-negotiable ownership rule

`dsh-codex` maintains **TUI + launcher + the thinnest practical public-API adapter**.

DeepSeek Harness remains an upstream dependency. If DSH does not expose a capability that Codex UI can display, DSHX must hide/disable/degrade that UI or wait for upstream. It must not recreate the missing capability locally.

A PR is out of scope if its primary purpose is to reimplement a DeepSeek Harness capability rather than present or adapt one.

## Product command contract

Production 1.0 requires this to be the normal path:

```bash
cd <project>
dshx
```

No user-facing `codex --remote`, bridge process, manual profile command or package-manager orchestration is acceptable in the production launch path.
