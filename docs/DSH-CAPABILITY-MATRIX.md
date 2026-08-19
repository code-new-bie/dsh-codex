# DSH public capability matrix

This document is a guardrail for the DSHX adapter. Every Codex-facing behavior must map to an **official DeepSeek Harness public API/event**. If no suitable public capability exists at the pinned DSH commit, DSHX marks the surface unsupported or degrades the presentation; it does not implement a replacement runtime.

Pinned DSH commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`

## Core interaction mapping

| Codex/TUI need | Official DSH source | DSHX responsibility | Status |
|---|---|---|---|
| Start a conversation | `ctx.agents.create(...)` | Project result into `thread/start` / Thread UI | Verified |
| Resume a conversation | `ctx.agents.resume({ resumeSessionId })` | Project resumed Session into Thread/resume UI | Verified |
| Live agent lookup | `ctx.agents.get(id)`, `list()`, `roots()` | Presentation/navigation only | Verified |
| User follow-up | `Agent.followup(message)` | Convert composer input to DSH user message | Verified |
| Steering while running | `Agent.steer(message)` | Forward active-turn steering from composer | Verified |
| Cancel / Ctrl+C | `Agent.cancel(cause, options?)` | Map TUI interrupt intent, never invent policy | Verified |
| Wait for quiescence | `Agent.whenIdle()` | Drive UI busy/idle convergence | Verified |
| Agent status | `agent/status` event and `Agent.status` | Render active/idle state | Verified |
| Durable transcript source | `Session` append-only event log | Project only; never create a second transcript DB | Verified |
| Session event feed | `session/event` | Translate exposed event vocabulary to TUI items | Verified |
| User message | `user/message` | Render transcript/input history | Verified |
| Token/chunk streaming | `assistant/chunk` | Convert exposed chunks to agent-message/reasoning deltas | Verified |
| Final assistant message | `assistant/message` | Finalize message item and usage presentation | Verified |
| Tool invocation | `tool/call` | Render matching Codex tool/shell/file cell where semantics are known | Verified |
| Tool result | `tool/result` | Render result/meta; do not execute the tool in DSHX | Verified |
| File contextual diff | `tool/result.meta` when provided by producing tool | Present diff/card only | Verified capability seam |
| Plan / todo | `todo/write` | Project whole-list snapshot into plan UI | Verified |
| Provider/model/reasoning route | `request/header` | Populate status/model presentation and resume projection | Verified |
| Context-window route metadata | `request/context` | Feed context footer when present | Verified |
| Flush durability | `session/flush` | Await/request through official lifecycle only when required | Verified |
| Session listing | `ctx.sessionPersistence.list()` / `listSnapshots()` | Populate resume picker | Verified |
| Session inspection | `ctx.sessionPersistence.inspect(id)` | Read immutable history for resume/details | Verified |
| Session persistence/crash repair | `ctx.sessionPersistence` implementations | **None** — DSH owns durability and repair | Upstream-owned |
| Permission preset list/current | `ctx.permissionPresets.names`, `optionOf()`, `current(session.events)` | Populate Codex-style permissions selector | Verified |
| Permission preset switch | `ctx.permissionPresets.set(session, name)` | Delegate selected value; do not write sandbox/approval events ourselves | Verified |
| Effective file sandbox | `ctx.sandboxPolicy.resolve({ session })` | Present DSH enforcement as an external sandbox | Verified |
| Effective approval policy | `ctx.approval.overrideOf(session)` + `ctx.approval.config.policy` | Map `ask → on-request`, `never → never` | Verified |
| Interactive approval request | scoped `approval/request` waterfall | Present only when Codex has a faithful UI for that DSH tool; otherwise delegate/fail closed | Verified |
| Approval audit | `approval/asked` / `approval/decided` | Read/render if useful; never use audit events as the answer channel | Verified |

## Permission semantic notes

DSH sandbox mode governs **filesystem effects only**. Its public sandbox contract explicitly states that network and process visibility are outside the sandbox vocabulary. Codex's legacy `SandboxPolicy` combines filesystem and network presentation fields, so DSHX must not claim that a DSH confined session is a Codex-native `workspaceWrite`/`readOnly` policy with invented network semantics.

DSHX therefore projects confined DSH modes as Codex `externalSandbox` for the legacy field and keeps the actual DSH preset name/options as the user-facing source of truth. `danger-full-access` has an exact legacy Codex representation and may be projected directly.

DSH approval outcomes are closed and fail-closed:

```text
allowed-once
rejected
cancelled
unavailable
```

Only `allowed-once` is a grant. Codex's `acceptForSession` has **no faithful DSH equivalent** and must not be offered for DSH-backed approvals. The TUI needs a narrow backend-aware patch that keeps one-shot accept / decline / cancel while hiding session-wide approval. Unknown plugin-tool approvals are not misclassified as shell/file approvals; an unclaimed request naturally falls through to DSH's `unavailable` outcome.

## DSH events observed at the pinned commit

The session event vocabulary already contains the primitives needed for a Codex-like coding transcript:

```text
turn/start
turn/end
step/start
step/end
user/message
assistant/chunk
assistant/message
tool/call
tool/result
todo/write
request/header
request/context
approval/asked
approval/decided
approval/policy
sandbox/mode
permission/preset
```

The adapter must treat the vocabulary as merge-extensible. Unknown plugin events are valid DSH events; DSHX may ignore explicitly ignorable presentation events but must not reinterpret required unknown events as known capabilities.

## Explicit non-ownership

DSHX does not own any implementation behind these surfaces:

```text
ctx.agents
Agent loop
Session / SessionPersistence
ctx.llm adapters and routing
tool execution
sandbox
approval policy
permission presets
skills
subagents
plugins
jobs / workflows
crash recovery
```

A mapping row describes where DSHX **reads, calls or presents an upstream capability**. It does not grant permission to duplicate that capability locally.

## Capability fallback rule

For every UI feature:

1. Detect whether the pinned/runtime DSH composition exposes a faithful public capability.
2. If yes, adapt it narrowly into the Codex TUI surface.
3. If the semantics are only partially representable, show an explicit reduced/unsupported state.
4. If representing it would weaken permissions or durability semantics, fail closed.
5. Never solve a missing upstream capability by adding a shadow runtime to `dsh-codex`.

## Research still required

The following surfaces need further public-API verification before implementation:

- Enumerating the current DSH model/provider catalog for `/model` without relying on private registry fields.
- Ask-user event/tool presentation seam and cancellation semantics.
- Exact built-in DSH tool-name/meta contracts needed to specialize generic tool cells into Codex shell/file/diff cells.
- Skills/subagents/jobs/plugin UI capability discovery for later milestones.

Those are adapter research tasks, not invitations to implement the capabilities in DSHX.
