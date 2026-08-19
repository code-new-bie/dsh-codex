# DSH public capability matrix

This document is a guardrail for the DSHX adapter. Every Codex-facing behavior must map to an **official DeepSeek Harness public API/event**. If no suitable public capability exists at the supported DSH release, DSHX marks the surface unsupported or degrades the presentation; it does not implement a replacement runtime.

Supported DSH package line: `0.1.0-rc.8`.
Pinned DSH source reference: `141eb6fef83422698aef7a981029e843e8161534`.

## Core interaction mapping

| Codex/TUI need | Official DSH source | DSHX responsibility | Status |
|---|---|---|---|
| Start a conversation | `ctx.agents.create(...)` | Project result into `thread/start` / Thread UI | Implemented + tested |
| Resume a conversation | `ctx.agents.resume({ resumeSessionId })` | Project resumed Session into Thread/resume UI | Implemented + tested |
| Live agent lookup | `ctx.agents.get(id)`, `list()`, `roots()` | Presentation/navigation only | Implemented + tested |
| User follow-up | `Agent.followup(message)` | Convert composer input to official DSH user content | Implemented + tested |
| Steering while running | `Agent.steer(message)` | Forward active-turn steering from composer | Implemented + tested |
| Cancel / Ctrl+C | `Agent.cancel(cause, options?)` | Map TUI interrupt intent; never invent policy | Implemented + tested |
| Wait for quiescence | `Agent.whenIdle()` | Drive UI busy/idle convergence | Implemented + tested |
| Agent/subagent status | `agent/status`, `agent/created`, `agent/disposed` | Render thread active/idle/not-loaded state | Implemented + tested |
| Durable transcript source | `Session` append-only event log | Project only; never create a second transcript DB | Implemented + guarded |
| Session event feed | `session/event` | Translate exposed event vocabulary to TUI items | Implemented + tested |
| User message | `user/message` | Render transcript/input history | Implemented + tested |
| Token/chunk streaming | `assistant/chunk` | Convert visible/reasoning chunks to Codex deltas | Implemented + tested |
| Final assistant message | `assistant/message` | Finalize message/reasoning items | Implemented + tested |
| Tool invocation/result | `tool/call`, `tool/result` | Render matching Codex tool/shell/file/diff cells; never execute locally | Implemented + tested |
| File contextual diff | producing tool result/meta | Present diff/card only | Implemented where DSH emits faithful metadata |
| Plan / todo | `todo/write`, `planMode` | Project plan list/mode into Codex presentation | Implemented + tested |
| Provider/model catalog | `ctx.llm.listProviders()`, `listModels()`, `resolveModelInfo()` | Populate `/model` using public registry | Implemented + tested |
| Model/reasoning validation | `ctx.llm.resolveCallConfig()` + official model-selection service | Validate/apply picker changes through DSH | Implemented + tested |
| Persisted route metadata | `request/header` | Restore model/reasoning presentation on resume | Implemented + tested |
| Context/token usage | `request/context` + persisted session usage | Feed footer/usage projection when exposed | Implemented + tested |
| Session listing/inspection | `ctx.sessionPersistence.list()`, `inspect()` | Resume picker/history hydration | Implemented + tested |
| Session persistence/crash repair | `ctx.sessionPersistence` implementations | **None** — DSH owns durability and repair | Upstream-owned |
| Paginated history | persisted Session events | Convert immutable events into Codex turn/item pages | Implemented + tested |
| Permission preset list/current | `ctx.permissionPresets` | Populate Codex-style permissions selector | Implemented + tested |
| Permission preset switch | `ctx.permissionPresets.set(...)` | Delegate selected value; do not write policy events ourselves | Implemented + tested |
| Effective sandbox/approval state | DSH sandbox/approval services | Present DSH enforcement without inventing Codex semantics | Implemented + tested |
| Interactive approval request | scoped `approval/request` waterfall | Present only faithful one-shot decisions; fail closed otherwise | Implemented + tested |
| Ask user | `ctx.userQuestions.registerProvider(...)` | Present Codex request-user-input overlay and return DSH answer | Implemented for faithful single-select/free-text cases |
| Skills discovery | official DSH skills registry/provider surface | Adapt current registry snapshot to `skills/list` | Implemented + tested |
| Session fork | Host API `sessions.fork` | Select DSH event boundary and delegate durable fork | Implemented + ownership guarded |
| Manual compaction | official DSH `/compact` command | Invoke through DSH command service; render compaction events | Implemented + ownership guarded |
| Shell execution | official DSH `tools.execute` with owning Agent | Map Codex shell request/result to DSH tool execution | Implemented + ownership guarded |
| Workspace diff command | official DSH `tools.execute` with owning Agent | Use DSH execution, then present result | Implemented + ownership guarded |
| Subagent lifecycle | official `subagents` service + agent lifecycle events | Present child threads/status; delegate interrupt authority | Implemented + fail-closed authority tests |

## Permission semantic notes

DSH sandbox mode governs the semantics exposed by DSH; DSHX must not invent network/process guarantees that are absent from that public contract. Where Codex's legacy sandbox shape is broader than DSH's vocabulary, DSHX presents an external sandbox plus the actual DSH permission preset rather than falsely claiming Codex-native enforcement.

DSH approval outcomes are closed and fail-closed. Only an explicit DSH grant is projected as approval. Codex's session-wide approval actions are hidden when no faithful DSH equivalent exists. Unknown plugin-tool approvals are not guessed into shell/file semantics; unclaimed requests remain unavailable/denied according to DSH policy.

## Session durability and restart semantics

DSHX keeps no durable transcript. Resume calls `ctx.agents.resume(...)`, history is read from DSH persistence, and the latest persisted `request/header` wins over the current machine default when restoring model/reasoning presentation. DSHX does not repair, replay or rewrite Session state after a crash.

## Known deliberate capability gaps

These are not shadow-implemented:

- **DSH multi-select user questions:** the pinned Codex request-user-input presentation does not provide a faithful multi-select contract in the current adapter, so DSHX rejects that request instead of silently changing its semantics.
- **Codex-specific review/apps/plugins/hooks/memory/personality surfaces:** hidden where the supported DSH release has no faithful public equivalent wired into DSHX.
- **Jobs/workflows UI:** DSH may own these capabilities, but a stable terminal presentation contract has not yet been adopted; this is a presentation-only future surface.
- **Ephemeral Codex fork / goal-continuation semantics:** not mapped onto durable DSH Session forks.
- **Codex service-tier and reasoning-summary/personality thread settings:** rejected because there is no equivalent public DSH setting to project.

A visible Codex command is kept only when its semantics are backed by DSH or are purely local TUI presentation. Unsupported runtime-owned commands are hidden rather than routed to Codex core.

## Capability fallback rule

For every UI feature:

1. Detect whether the supported DSH composition exposes a faithful public capability.
2. If yes, adapt it narrowly into the Codex TUI surface.
3. If semantics are only partially representable, show an explicit reduced/unsupported state.
4. If representing it would weaken permissions, authority or durability semantics, fail closed.
5. Never solve a missing upstream capability by adding a shadow runtime to `dsh-codex`.

## Release evidence

This matrix describes implementation/ownership, not release-candidate pass status. The exact candidate must still satisfy `docs/RELEASE-READINESS.md`, including CI, packaged local-IPC checks and manual Windows Terminal/CJK/IME parity acceptance.
