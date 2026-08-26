# Production runtime integration

## Decision

DSHX reuses the same architectural seam that official DeepSeek Harness uses for its headless product: a direct Cordis/core entry point over the official DSH composition, without requiring the WebUI/browser runtime for normal terminal use.

The TUI remains project-owned. DeepSeek Harness remains upstream-owned.

Supported DSH package line for the current release branch: `0.1.0-rc.8`.
Pinned DSH source reference: `141eb6fef83422698aef7a981029e843e8161534`.

The official runtime owns Agent creation/resume, Session persistence, model selection/routing, tools, approvals, permission policy, skills, subagents and every other capability surface. DSHX generalizes only the **presentation lifetime** from a headless/one-shot consumer into an interactive terminal frontend.

## Production topology

```text
┌──────────────────────────────────────────┐
│ dshx Node launcher                       │
│  - boots official DSH composition        │
│  - mounts dshx-presentation plugin row   │
│  - owns child-process lifetime only      │
└────────────────────┬─────────────────────┘
                     │
                     │ DSH public APIs/events
                     ▼
┌──────────────────────────────────────────┐
│ DSHX presentation adapter                │
│  - Codex protocol projection only        │
│  - mounted as the dshx-presentation      │
│    Cordis plugin (name/inject/Config/    │
│    apply), disposed by the root Fiber    │
└────────────────────┬─────────────────────┘
                     │ JSONL / child stdio
                     ▼
┌──────────────────────────────────────────┐
│ dshx-ipc-bridge                          │
│  - pinned Codex workspace binary         │
│  - no agent/session/runtime state         │
└────────────────────┬─────────────────────┘
                     │ WebSocket framing over
                     │ private local UDS only
                     ▼
┌──────────────────────────────────────────┐
│ pinned Codex TUI thin fork               │
│  presentation/input only                 │
└──────────────────────────────────────────┘
```

The bridge exists because the TUI is Rust and the official DSH composition is Node/TypeScript. It reuses Codex's own cross-platform `codex_uds` implementation rather than introducing unsafe FFI or a second runtime.

## Why WebSocket framing is still present

The pinned Codex app-server client speaks WebSocket frames for its remote transport abstraction, including its Unix-socket endpoint. DSHX keeps that framing but changes the production carrier:

- **forbidden in production:** `ws://127.0.0.1:*`, TCP listeners, bearer-token loopback transport, user-facing Codex remote mode;
- **production:** a private `unix://.../app.sock` endpoint implemented by `codex_uds`, with the bridge relaying JSON messages to Node over child stdio.

Therefore production does not depend on Codex's experimental TCP WebSocket remote mode, while the TUI can continue using the upstream protocol machinery with a minimal thin-fork patch.

## Launcher lifecycle

`dshx` performs the following sequence:

1. Bootstrap the surface profile through the official plugin machinery: `dsh plugin --profile <p> add <package>` (idempotent — a profile already pinning this exact package version as a bundle layer is left untouched). The package manifest declares `dsh.bundle.patch`, so the loader picks the surface up as a real bundle layer.
2. Boot the official DSH composition for that profile; the loader mounts the rows declared by the shipped `cordis.patch.yml` (`dshx-startup`, `dshx-presentation`) and locks the competing headless presentation rows.
3. The startup row publishes launch parameters (presentation home, packaged binaries, version) as the `dshxStartup` service; the presentation row injects it, starts the local transport, and publishes the endpoint as the `dshxPresentation` service.
4. Spawn `dshx-ipc-bridge`, wait for its readiness control message, and expose the resulting `unix://` endpoint to the TUI.
5. Spawn the pinned Codex TUI with `DSHX_APP_SERVER_ENDPOINT` set to that local endpoint and an isolated presentation-only `CODEX_HOME`.
6. Relay app-server JSON between the TUI and the DSH presentation adapter while DSH remains authoritative for all runtime state.
7. On TUI exit or process shutdown, dispose the official Context: its root Fiber unwinds the presentation plugin (closing the transport and removing the temporary socket directory) — the Fiber is the sole teardown authority.

Ctrl+C is intentionally not intercepted by the Node launcher because it is an in-TUI interaction used to interrupt/steer the active DSH turn. Process `SIGTERM` is propagated for lifecycle shutdown.

## What the adapter may do

- Create/resume Agents through official DSH services.
- Forward follow-up, steering and cancellation to official Agent/subagent control APIs.
- Subscribe to public Agent/Session events.
- Read official session persistence/list/inspection surfaces.
- Project DSH events into Codex Thread/Turn/Item UI events.
- Keep disposable UI correlation state such as `DSH turn number → current Codex turn id`.
- Translate a user decision from an upstream Codex picker into the corresponding official DSH approval/question API call without weakening it.

## What the adapter must not do

- Implement an agent loop.
- Call model providers directly instead of DSH.
- Execute tools or shell commands outside DSH.
- Store a second durable transcript or session database.
- Repair/replay sessions with DSHX-owned persistence logic.
- Decide sandbox/approval policy.
- Reimplement compaction, fork, skills, subagents, jobs or plugins.
- Persist an independent model choice when DSH already owns selection.

The test suite contains ownership guards for these boundaries. Missing official services are compatibility failures, not invitations to add shadow implementations.

## Development-only transport

The historical deterministic protocol PoC (`devtools/protocol-poc.mjs`) and TCP/WebSocket stub (`devtools/stub-server.mjs`) remain useful test fixtures for protocol work, but they live outside the production `src/` tree and are not copied into the installable production package. The `ws` dependency is development-only.

The real TUI smoke test uses `bin/dshx-stub-local.mjs`, which drives the deterministic fixture through the same packaged local-IPC bridge as production.

## Diagnostics

`dshx doctor` validates:

- supported Node runtime;
- packaged pinned Codex TUI;
- packaged `dshx-ipc-bridge`;
- a real UDS + WebSocket `ping → pong` self-test using Codex's cross-platform UDS implementation;
- official DSH bundle composition;
- isolated DSHX presentation home.

A successful bridge self-test proves the local transport data plane on the current OS; it is stronger than merely checking that the binary exists.

## Compatibility and upstream sync

DSH and Codex are both moving upstreams. The repository pins source/package versions and keeps the Codex divergence as an ordered patch queue. Compatibility is defined by public capabilities actually exposed by the supported DSH line.

If a DSH update removes a required public seam, that version is unsupported until DSHX can adapt through another official seam or DSH restores one. DSHX must not preserve compatibility by copying DSH internals.

If a Codex update breaks a patch or app-server shape, the pin is advanced only after the patch queue, protocol tests, PTY smoke, packaging checks and UX parity gate are revalidated.
