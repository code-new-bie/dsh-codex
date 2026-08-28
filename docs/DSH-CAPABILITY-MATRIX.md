# DSH public capability matrix

Every Codex-facing runtime behavior must map to an **official DeepSeek Harness public API/event**. If no faithful public capability exists in the host, DSHX hides/degrades the UI or fails closed; it does not implement a replacement runtime.

The current CI-tested closure is DSH `0.1.0-rc.8` at the repository's pinned DSH source reference. Production is host-version agnostic above the declared compatibility floor and resolves services from the user's installation.

## Core mapping

| Codex/TUI need | DSH authority | DSHX responsibility | Status |
|---|---|---|---|
| Start conversation | `ctx.agents.create(...)` | project result into Thread UI | implemented/tested |
| Resume | `ctx.agents.resume(...)` | hydrate Codex Thread from DSH Session | implemented/tested |
| Session list/history | DSH persistence/query services | resume picker/history pages | implemented/tested |
| Follow-up | `Agent.followup(...)` | convert composer input | implemented/tested |
| Steering | `Agent.steer(...)` | forward active-turn steering | implemented/tested |
| Interrupt | Agent/subagent control | map Ctrl+C without inventing authority | implemented/tested |
| Agent status | DSH Agent lifecycle events | active/idle/not-loaded projection | implemented/tested |
| Transcript | DSH Session event log | presentation projection only | implemented/guarded |
| Assistant/reasoning stream | DSH Session events | Codex item/delta projection | implemented/tested |
| Tool execution/result | DSH ToolRuntime/events | shell/tool/file/diff presentation; never local execution | implemented/tested |
| Plan/todo | DSH plan/todo state | Codex plan projection | implemented/tested |
| Model catalog | DSH LLM registry | model picker | implemented/tested |
| Model validation/selection | DSH model-selection/resolution services | validate/apply picker changes | implemented/tested |
| Persisted route state | DSH request header | restore model/reasoning presentation | implemented/tested |
| Token/context usage | DSH request/session usage | footer projection where exposed | implemented/tested |
| Permission presets | DSH permission service | picker/list/switch projection | implemented/tested |
| Effective sandbox/approval | DSH policy services | present policy without weakening it | implemented/tested |
| Approval request | DSH approval waterfall | faithful one-shot UI only | implemented/fail-closed |
| Ask user | DSH user-question provider | Codex input overlay where semantics match | partial, explicit gaps |
| Skills | DSH skills registry | `skills/list` projection | implemented/tested |
| Fork | DSH Host/session fork API | translate presentation anchor and delegate | implemented/guarded |
| Compaction | official DSH command plane | invoke/render only | implemented/guarded |
| Shell/workspace command | DSH `tools.execute` with owning Agent | present request/result | implemented/guarded |
| Subagents | DSH subagent service + lifecycle events | child thread/status/interrupt presentation | implemented/tested |

## Semantic rules

- DSH sandbox/approval vocabulary is authoritative; DSHX does not claim stronger Codex-native enforcement than DSH exposes.
- Only explicit DSH grants are shown as approval. Unsupported session-wide grants remain unavailable.
- Unknown plugin-tool approvals are not guessed into shell/file semantics.
- Resume uses persisted DSH Session/request state; DSHX keeps no durable transcript or repair logic.
- Visible Codex commands are either presentation-local or backed by DSH. Unsupported runtime-owned commands are hidden instead of routed to Codex core.

## Deliberate gaps

- DSH multi-select user questions where the pinned Codex UI cannot represent the semantics faithfully.
- Codex-specific review/apps/plugins/hooks/memory/personality surfaces without a DSH public equivalent.
- Jobs/workflows terminal UI until a stable presentation contract is selected.
- Codex-only ephemeral fork/goal-continuation semantics that do not match durable DSH Session forks.
- Codex service-tier/reasoning-summary/personality settings without DSH equivalents.

## Fallback rule

For every UI feature:

1. detect a faithful DSH public capability;
2. adapt it narrowly when present;
3. show an explicit reduced/unsupported state when only partial presentation is possible;
4. fail closed if translation would weaken authority, permissions or durability;
5. never add a shadow runtime to compensate for a missing upstream seam.

This matrix describes implementation ownership. Release evidence is tracked separately in `RELEASE-READINESS.md`, including standard bundle activation, directional-pipe native UI gates and manual Windows Terminal/CJK/IME parity.
