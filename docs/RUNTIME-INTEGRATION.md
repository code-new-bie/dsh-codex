# Production runtime integration

## Decision

DSHX will reuse the same architectural seam that official DeepSeek Harness uses for its headless product: a direct Cordis/core entry point over `dsh-base`, without requiring the Web/Host/HTTP/browser runtime for ordinary terminal use.

The TUI remains project-owned. DeepSeek Harness remains upstream-owned.

Pinned DSH reference: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.

At that commit, official `@deepseek-ai/dsh-headless` demonstrates the supported pattern:

- wait for loader settlement;
- read the official default model service;
- create an Agent through `ctx.agents.create(...)`;
- drive it with public Agent APIs;
- observe the authoritative Session;
- flush through `ctx.sessions.flush(...)`;
- let DSH own model/tool/session/persistence behavior.

DSHX generalizes only the **presentation lifetime** from one-shot stdout to an interactive TUI. It does not generalize or replace the runtime.

## Target production topology

```text
┌──────────────────────────────────────────┐
│ dshx executable                          │
│  - user-facing command                   │
│  - starts local components               │
└────────────────────┬─────────────────────┘
                     │
          local supported transport
          (prefer stdio / in-process)
                     │
┌────────────────────▼─────────────────────┐
│ pinned Codex TUI thin fork               │
│  presentation only                       │
└────────────────────┬─────────────────────┘
                     │ Codex-compatible UI protocol
┌────────────────────▼─────────────────────┐
│ DSHX presentation adapter                │
│  Cordis plugin over official dsh-base    │
│  translation only                        │
└────────────────────┬─────────────────────┘
═════════════════════╪══════════════════════ ownership boundary
                     │ official DSH public APIs/events
┌────────────────────▼─────────────────────┐
│ official DeepSeek Harness                │
│ agents / sessions / llm / tools / etc.  │
└──────────────────────────────────────────┘
```

## What the adapter is allowed to do

- Create/resume Agents through official `ctx.agents` APIs.
- Forward follow-up, steering and cancellation to the official Agent object.
- Subscribe to public Agent/Session events.
- Read official session persistence/list/inspection surfaces.
- Project DSH events into Codex Thread/Turn/Item UI events.
- Keep disposable UI correlation state such as `DSH turn number → current Codex turn id`.

## What the adapter is forbidden to do

- Implement an agent loop.
- Call providers directly instead of DSH.
- Execute tools instead of DSH.
- Store a second durable transcript.
- Repair sessions or implement crash recovery.
- Decide sandbox/approval policy.
- Reimplement skills/subagents/jobs/plugins.
- Persist an independent model selection when DSH already owns selection.

## Transport phases

### M0 development

The installed Codex CLI may connect to a local WebSocket compatibility stub via `codex --remote`. This exists solely to prove protocol/TUI compatibility.

### M1 development

The deterministic stub is replaced behind the same protocol surface by a Cordis plugin using official DSH APIs. WebSocket may still be used locally for development observation if useful.

### Production

Experimental Codex remote WebSocket mode is removed from the user launch path. The pinned thin-fork TUI and DSHX adapter use a local supported transport hidden behind `dshx`, preferably stdio or in-process IPC depending on the final Rust/Node process boundary.

The production contract remains:

```bash
cd <project>
dshx
```

## Process boundary

Codex TUI is Rust; DSH is TypeScript/Node. DSHX should not create an unsafe FFI dependency merely to force both into one process.

The preferred design is therefore:

```text
Rust TUI process
   ⇅ structured local protocol over stdio/local IPC
Node DSH composition + DSHX adapter plugin
```

`dshx` supervises both lifetimes and propagates terminal interrupt/shutdown correctly. The protocol carries presentation events; it does not own runtime state.

## DSH compatibility principle

DSH is a fast-moving upstream. Compatibility is determined by the public capabilities actually exposed by the pinned/supported DSH version. DSHX may ship a narrow compatibility layer for API shape changes, but it must not preserve old behavior by carrying a forked copy of DSH internals.

If an upstream breaking change removes a needed public seam, that DSH version is unsupported until DSHX can adapt through another official seam or DSH restores an appropriate interface.
