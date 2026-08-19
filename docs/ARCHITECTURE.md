# Architecture

## Objective

`dsh-codex` should preserve the Codex terminal interaction model while replacing the Codex agent backend with DeepSeek Harness.

## Ownership boundary

| Concern | Owner |
|---|---|
| Terminal layout / composer / keyboard / overlays | Codex TUI thin fork |
| Session persistence | DSH |
| Agent loop | DSH |
| Model routing | DSH |
| Tool registry and execution | DSH |
| Sandbox and approval policy | DSH |
| Skills / subagents / jobs | DSH |
| Protocol translation | dsh-codex adapter |

The TUI must never become a second source of truth for session history, tool policy, model configuration or agent state.

## Target topology

```text
┌─────────────────────────────────────┐
│ Codex TUI thin fork                 │
│                                     │
│ welcome / composer / cells / diff   │
│ slash commands / pickers / footer   │
└──────────────────┬──────────────────┘
                   │
          app-server-compatible API
                   │
┌──────────────────▼──────────────────┐
│ dsh-codex protocol adapter          │
│                                     │
│ Thread ↔ Session                    │
│ Turn   ↔ Agent turn                 │
│ Item   ↔ DSH event/tool projection  │
└──────────────────┬──────────────────┘
                   │ Cordis
┌──────────────────▼──────────────────┐
│ DeepSeek Harness                    │
│                                     │
│ agents / sessions / llm / tools     │
│ sandbox / approvals / skills        │
└─────────────────────────────────────┘
```

## Protocol mapping

The adapter starts with a deliberately small vertical slice.

| Codex concept | DSH concept |
|---|---|
| Thread | Session |
| `thread/start` | create DSH Session + Agent |
| `thread/resume` | inspect and resume DSH Session |
| `thread/list` | DSH session catalog |
| Turn | one user interaction with a DSH Agent |
| agent-message delta | model/agent streaming event |
| command execution item | DSH shell/tool event |
| file-change item | DSH filesystem/editor event |
| approval request | DSH approval request |
| user-input request | DSH ask-user request |
| plan update | DSH plan/todo projection |
| turn interrupt | DSH turn cancellation |

## Session invariants

1. DSH session IDs are authoritative.
2. Resume reads model/provider/reasoning configuration from persisted DSH session events where available.
3. The TUI may cache presentation state, but it must be disposable.
4. No Codex session database is used for DSH conversations.

## Upstream strategy

The Codex TUI fork should be pinned to a known upstream commit. Upstream changes are integrated as explicit sync commits. Product-specific modifications should live behind narrow traits/interfaces whenever practical.

The desired long-term diff is:

```text
Codex TUI upstream     95%+ unchanged
DSH adapter            project-owned
Branding               minimal patch
DSH-specific commands  isolated extension points
```

## Runtime transport

Development may use Codex remote/app-server modes to validate mapping quickly. A production release should use a local production-grade transport (same process, stdio, or local socket) and must not depend on an upstream transport explicitly documented as experimental.

## Security model

The UI renders approval decisions; DSH enforces them. The adapter must not silently upgrade permissions. Any translation that cannot faithfully represent a DSH permission request must fail closed and surface an explicit unsupported-policy message.
