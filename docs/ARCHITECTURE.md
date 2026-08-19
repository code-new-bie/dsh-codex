# Architecture

## Objective

DSHX is a terminal frontend for official DeepSeek Harness. Its purpose is to preserve the pinned Codex terminal interaction model while projecting DSH public runtime state into that UI.

It is **not** a fork of DeepSeek Harness and must not grow into an agent framework.

## Normative ownership boundary

| Concern | Owner |
|---|---|
| Terminal layout / composer / keyboard / overlays | DSHX / Codex TUI thin fork |
| UX parity and branding | DSHX |
| `dshx` launcher / packaging | DSHX |
| Public API/event → TUI protocol projection | DSHX thin adapter |
| Session persistence | DeepSeek Harness upstream |
| Agent loop | DeepSeek Harness upstream |
| Model routing | DeepSeek Harness upstream |
| Tool registry and execution | DeepSeek Harness upstream |
| Sandbox and approval policy | DeepSeek Harness upstream |
| Skills / subagents / plugins / jobs | DeepSeek Harness upstream |

The adapter may translate and cache disposable presentation state. It must never become a second source of truth for session history, policy, model configuration, tools or agent state.

If a DSH capability is unavailable or cannot be represented safely, DSHX must disable, hide or explicitly mark the corresponding UI unsupported. It must **not** implement the missing runtime capability.

## Target topology

```text
┌─────────────────────────────────────┐
│ Codex TUI thin fork                 │  project-owned presentation
│                                     │
│ welcome / composer / cells / diff   │
│ slash commands / pickers / footer   │
└──────────────────┬──────────────────┘
                   │ private child process
                   │ JSON-RPC / JSONL over stdin/stdout
┌──────────────────▼──────────────────┐
│ dsh-codex thin adapter              │  project-owned translation
│                                     │
│ Thread ↔ Session id/projection      │
│ Turn   ↔ DSH turn lifecycle         │
│ Item   ↔ exposed DSH events         │
└──────────────────┬──────────────────┘
═══════════════════╪════════════════════ ownership boundary
                   │ official public APIs/events
┌──────────────────▼──────────────────┐
│ DeepSeek Harness                    │  upstream-owned runtime
│                                     │
│ agents / sessions / llm / tools     │
│ sandbox / approvals / skills / ...  │
└─────────────────────────────────────┘
```

The child-process boundary is a transport boundary only. The Node adapter does not become an Agent runtime: it boots the official DSH profile/composition and translates its public state/events for the TUI.

## Protocol mapping

Mappings are UI projections, not replacement implementations.

| Codex concept | DSH source |
|---|---|
| Thread | DSH Session identity and exposed metadata |
| `thread/start` | official DSH Session/Agent creation API |
| `thread/resume` | official DSH Session inspection/resume API |
| `thread/list` | official DSH session catalog |
| Turn | official DSH user-interaction lifecycle |
| agent-message delta | exposed DSH agent/model streaming event |
| command execution item | exposed DSH tool/shell event |
| file-change item | exposed DSH filesystem/editor event |
| approval request | official DSH approval request |
| user-input request | official DSH ask-user request |
| plan update | exposed DSH plan/todo state |
| turn interrupt | official DSH cancellation/control API |

Where no official mapping exists, the adapter reports unsupported instead of synthesizing a shadow capability.

## Session invariants

1. DSH session IDs and persisted events are authoritative.
2. DSHX does not keep a parallel conversation database.
3. Resume obtains model/provider/reasoning state from DSH through supported interfaces; the TUI does not invent replacements.
4. TUI caches are disposable and reconstructable.
5. DSHX never changes permission semantics to make a Codex widget easier to reuse.

## Codex upstream strategy

The TUI is pinned to a known `openai/codex` commit. Upstream changes are integrated as explicit sync commits. Project-specific changes live as a small ordered patch stack so rendering/input code remains close to upstream.

Desired long-term diff:

```text
Codex TUI upstream     95%+ unchanged
DSH UI adapter         project-owned and thin
Branding               minimal patch
DSH-specific UI        isolated extension points only
```

## Runtime transport

Early protocol proofs used Codex remote/app-server WebSocket mode. That path is development-only and is not an accepted production dependency.

Production `dshx` uses a private child-process transport:

1. `dshx` launches the packaged pinned Codex TUI.
2. The TUI starts `bin/dshx-app-server.mjs` with the packaged Node runtime path supplied by the launcher.
3. TUI and adapter exchange app-server-compatible JSON-RPC as newline-delimited JSON over the child stdin/stdout pipes.
4. The adapter boots and disposes the official DeepSeek Harness composition in that child process.

Production therefore opens no TCP listener and exports no app-server endpoint/token. The release packager rejects a runtime `ws` dependency or legacy WebSocket server module. WebSocket fixtures may remain only in the source/development test closure.

## Launcher contract

Production 1.0 supports:

```bash
cd <project>
dshx
```

The user must not need to invoke `codex --remote`, a bridge script, package-manager commands or DSH profile plumbing for normal startup.

`CODEX_HOME` is redirected to DSHX presentation-only state, so DSHX does not read or modify the user's ordinary Codex state.

## Security model

The TUI renders approval decisions; DSH enforces them. Translation must never silently upgrade privileges. If the current Codex UI/protocol cannot faithfully represent a DSH permission request, DSHX fails closed and surfaces an explicit incompatibility.

The private stdio adapter further reduces the local attack surface: production requires no listening socket and no bearer credential crossing process boundaries. Security authority still remains in DSH, not in the transport layer.
