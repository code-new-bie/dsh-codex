# Architecture

## Objective

DSHX is a standard terminal presentation bundle for **official DeepSeek Harness**. It preserves the pinned Codex TUI interaction model while projecting DSH public runtime state into that UI.

It is not a DeepSeek Harness fork and must not grow into an agent framework.

## Ownership

| Concern | Owner |
|---|---|
| Terminal layout, composer, keyboard, overlays | pinned Codex TUI / DSHX thin fork |
| UX parity and DSHX branding | DSHX |
| Standard bundle rows and `dshx` convenience launcher | DSHX |
| DSH public API/event → TUI protocol projection | DSHX |
| Agent loop and control | DeepSeek Harness |
| Sessions and persistence | DeepSeek Harness |
| Models, providers and credentials | DeepSeek Harness |
| Tools and shell execution | DeepSeek Harness |
| Sandbox and approvals | DeepSeek Harness |
| Skills, subagents, plugins and jobs | DeepSeek Harness |

The adapter may keep disposable presentation correlation state. It must never become a second source of truth for history, policy, model configuration, tools or Agent state.

## Process topology

```text
dshx
  │ ensure bundle in profile
  ▼
user-installed dsh --profile tui
  │ sole DSH runtime / Loader owner
  ├─ dshx-startup
  └─ dshx-presentation
        │ spawn native TUI only
        ▼
   pinned Codex TUI
        ⇅ directional anonymous child pipes
   src/tui-protocol
        ⇅
   DSH public services/events
```

There is no production TCP listener, WebSocket server, Unix-domain socket, IPC bridge or second DSH process.

## Directional pipe contract

Node's child-process pipes are directional, not a generic duplex fd. The presentation runner therefore launches the TUI with:

```js
stdio: ['pipe', 'inherit', 'inherit', 0, 'pipe']
```

The child sees:

| fd | Meaning |
|---:|---|
| 0 | protocol input, DSH parent → TUI |
| 1 | terminal stdout |
| 2 | terminal stderr |
| 3 | original terminal stdin |
| 4 | protocol output, TUI → DSH parent |

Before terminal initialization, the thin fork duplicates protocol fd 0, restores fd 3 onto ordinary stdin, and then gives the saved protocol input plus fd 4 to the app-server-compatible client. On Unix it clears inherited `O_NONBLOCK` on protocol descriptors before wrapping them as file-backed Tokio I/O; on Windows it restores both CRT stdin and the Win32 standard input handle.

The protocol bytes are newline-delimited JSON. Transport code carries no runtime state and has no network address.

## Standard plugin composition

`package.json` declares:

```json
{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}
```

The patch adds only DSHX-owned startup/presentation rows. `dshx-startup` consumes the official `cmdlineArgs` service and publishes immutable presentation launch facts. `dshx-presentation` consumes that service, waits for Loader settlement, starts the native TUI and binds its pipes directly to the live Context.

The user's `dsh --profile tui` process remains the application host. `dshx` may install the bundle idempotently through `dsh plugin --profile tui add`, but it does not mount a private composition.

## Protocol boundary

Codex wire vocabulary is confined to `src/tui-protocol/` and protocol plumbing. Domain modules under `src/dsh/` speak DSH concepts and public services.

Typical projections include:

| TUI concept | DSH authority |
|---|---|
| Thread | Session identity/metadata |
| thread start/resume/list | Agent + Session public services |
| Turn | DSH turn lifecycle |
| assistant/reasoning deltas | DSH Session events |
| command/file cells | DSH tool/result events |
| approvals | DSH approval service |
| ask-user | DSH user-question service |
| plan | DSH plan/todo state |
| interrupt/steer | DSH Agent/subagent control |

Where no faithful mapping exists, DSHX reports unsupported or hides the surface rather than synthesizing a shadow capability.

## Session and security invariants

1. DSH session ids and persisted events are authoritative.
2. DSHX has no parallel conversation database.
3. Resume restores DSH-owned model/session state.
4. Presentation caches are disposable.
5. DSHX never weakens sandbox or approval semantics for UI compatibility.
6. Missing required DSH services fail closed.
7. The TUI child never starts a backend/runtime child of its own.

## Upstream strategy

The TUI is pinned to a known `openai/codex` commit. Project divergence is maintained as an ordered, build-tested patch queue. Rendering/input code should remain as close to upstream as practical; DSH-specific behavior belongs at the protocol and narrow startup seams.
