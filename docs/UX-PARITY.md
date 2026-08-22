# Codex UX parity matrix

The target is **behavioral parity with the pinned Codex TUI**, not a screenshot-inspired imitation. DSHX therefore keeps upstream Codex widgets/input handling wherever possible and changes only backend ownership, product data/branding, and unsupported-capability visibility.

Status below means implementation/evidence coverage, not that the final release candidate has passed manual acceptance.

## Acceptance matrix

| Surface | Target | Current implementation evidence |
|---|---|---|
| Welcome screen | same structure, DSH branding/data only | Codex TUI thin fork + branding patch; PTY smoke asserts DSH surface |
| Composer | same multiline/editing behavior | inherited unchanged from pinned Codex TUI |
| Slash completion | same interaction pattern | inherited Codex UI; backend-incompatible commands hidden by narrow capability patch |
| Help/shortcuts | same keyboard model where applicable | inherited from pinned Codex TUI |
| Model picker | same presentation; data from DSH | official DSH model/provider directory + settings tests |
| Permission picker | same presentation; policy from DSH | DSH permission preset projection + backend-aware Codex picker patch |
| Tool cells | same renderer classes where mappings exist | DSH tool presentation specialization + tests |
| Shell cells | same streaming/collapse behavior | Codex shell renderer driven by DSH-owned tool execution/events |
| File diffs | same review rendering | Codex diff renderer driven by DSH tool metadata/workspace command path |
| Approval | same one-shot interaction where semantics match | DSH approval provider + fail-closed backend-aware overlay patch |
| Ask user | same picker/freeform experience where semantics match | `ctx.userQuestions` provider → Codex request-user-input overlay; multi-select remains explicit unsupported gap |
| Plan | same presentation mapped from DSH plan state | `todo/write` + DSH plan mode projection/tests |
| Reasoning | same cell behavior where DSH exposes it | DSH reasoning chunks/messages → Codex reasoning item/delta |
| Steering | same active-turn input semantics | Codex active composer → `Agent.steer(...)` through DSH controller |
| Interrupt | same Ctrl+C expectation | launcher preserves Ctrl+C for TUI; TUI interrupt delegates to DSH Agent/subagent authority |
| Resume | same picker behavior; sessions from DSH | Codex resume UI + DSH persistence list/inspect/resume/history hydration |
| Status/footer | same structure; DSH metrics/data | persisted/current model + token/context projections where exposed |
| Scroll/mouse | same behavior | inherited from pinned Codex TUI |
| Resize | no corruption or state loss | inherited from pinned Codex TUI; manual RC verification required |
| Windows Terminal | first-class release gate | native Windows build/package + real local-IPC doctor; visual/input acceptance still manual |
| CJK/IME | first-class release gate | Codex input code is inherited; exact RC artifact still requires manual Chinese IME acceptance |

## Backend command visibility

A Codex slash command is visible only when either:

1. it is a presentation/local-TUI operation, or
2. DSHX has a faithful mapping to an official DSH public capability.

Codex runtime-owned surfaces such as unsupported app/plugin/hook/memory/personality/review modes are hidden rather than falling through to Codex core. `/diff` remains visible because its execution path is DSH-owned. Skills remain visible because `skills/list` is backed by the official DSH registry surface.

## Allowed deliberate differences

- Product branding.
- Model/provider names and DSH-owned configuration vocabulary.
- Backend-specific capabilities that have no Codex equivalent.
- Explicit unsupported messages when semantic translation would be unsafe or misleading.
- Hidden Codex runtime commands when the supported DSH line has no faithful public equivalent.
- DSH multi-select user questions until the pinned Codex UI can represent them without semantic loss.

## Not acceptable

- Reimplementing a Codex widget merely because it looks simple.
- Maintaining a separate durable session history for UI convenience.
- Downgrading an approval or subagent authority requirement during protocol translation.
- Silent model changes on resume.
- Routing a hidden/unsupported command back into Codex's agent runtime.
- Replacing the inherited Codex composer with a generic readline prompt.
- Calling automated transport tests proof of Windows Terminal/CJK/IME parity.

## Automated parity protection

The repository protects the parts that can be automated:

- pinned Codex patch application/build;
- source invariants keeping DSHX on the external backend path;
- DSH adapter protocol/unit tests;
- ownership/fail-closed tests;
- real pinned-TUI PTY lifecycle smoke over production local IPC;
- native platform package + `dshx doctor`, including a real local-IPC data-plane self-test.

## Manual release comparison

For every 1.0 release candidate, install the **generated release artifact** and compare it side by side with the pinned upstream Codex version using the same Windows Terminal dimensions/theme. At minimum verify composer editing, Chinese IME composition/commit/cancel, wide-glyph alignment, slash completion, pickers, overlays, tool/shell/diff cells, reasoning/plan, steering/Ctrl+C, resume, scroll/mouse, resize and footer rendering.

Differences are either fixed, documented above as deliberate, or block release. The promotion procedure lives in `RELEASE-READINESS.md`.
