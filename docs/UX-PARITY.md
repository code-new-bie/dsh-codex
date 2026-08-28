# Codex UX parity matrix

The target is **behavioral parity with the pinned Codex TUI**, not a screenshot-inspired imitation. DSHX keeps upstream Codex widgets/input handling wherever practical and changes backend ownership, DSH data/branding, and unsupported-capability visibility.

| Surface | Target / evidence |
|---|---|
| Welcome | upstream structure, DSH branding/version/model data |
| Composer | inherited multiline/editing behavior |
| Slash completion/help | inherited interaction; unsupported runtime-owned commands hidden |
| Model picker | Codex presentation backed by DSH model registry/resolution |
| Permission picker | Codex presentation backed by DSH permission presets/policy |
| Tool/shell/file/diff cells | Codex renderers fed from DSH-owned tool/session events |
| Approval | one-shot Codex overlay only where DSH semantics match; fail closed otherwise |
| Ask user | DSH user-question service projected into Codex UI; unsupported semantics explicit |
| Plan/reasoning | projected from DSH-exposed plan/reasoning events |
| Steering/interrupt | delegated to DSH Agent/subagent authority |
| Resume | Codex UI backed by DSH persistence/session state |
| Status/footer | DSH-owned model/token/context data where exposed |
| Scroll/mouse/resize | inherited Codex behavior; native PTY/ConPTY regression gates |
| Windows/CJK/IME | automated ConPTY Unicode/resize plus manual Windows Terminal IME gate |

## Capability visibility

A Codex command is visible only when it is either a presentation-local operation or has a faithful mapping to an official DSH public capability. Unsupported Codex runtime owners are hidden rather than routed to Codex core.

`/diff`, fork/compact/agents and skills remain visible only where their execution/data path is DSH-owned. `scripts/verify-slash-contract.mjs` makes this classification executable.

## Allowed deliberate differences

- DSHX branding and DSH model/provider vocabulary;
- DSH-specific capabilities with no Codex equivalent;
- explicit unsupported messages where semantic translation would be unsafe;
- hidden Codex runtime commands without a faithful DSH equivalent.

## Not acceptable

- replacing upstream widgets with look-alikes unnecessarily;
- keeping a second durable session history;
- weakening approvals/sandbox/subagent authority in translation;
- silent model changes on resume;
- falling back to Codex Agent/runtime for hidden commands;
- replacing the composer with generic readline-style input;
- treating protocol/PTY automation as proof of real IME composition behavior.

## Automated parity protection

- pinned Codex patch materialization and `cargo --locked` build;
- thin-fork invariants proving the TUI does not spawn a backend runtime;
- real native TUI startup through parent-owned directional pipes;
- Linux/macOS PTY and Windows ConPTY CJK/resize tests;
- DSH adapter protocol/unit tests and fail-closed ownership tests;
- standard DSH bundle activation and single-runtime checks.

The PTY/ConPTY fixture is presentation-only: `devtools/tui-stub-parent.mjs` owns a deterministic protocol stub and launches the TUI with the same descriptor topology as production. The TUI never launches its own stub/backend.

## Manual release comparison

For every 1.0 RC, install the exact generated Windows artifact and compare it side-by-side with the pinned upstream Codex TUI under the same Windows Terminal dimensions/theme. Verify composer editing, Chinese IME composition/commit/cancel, wide-glyph alignment, slash completion, pickers, overlays, tool/shell/diff cells, reasoning/plan, steering/Ctrl+C, resume, scroll/mouse, resize and footer rendering.

Differences are fixed, explicitly documented as deliberate, or block release. See `RELEASE-READINESS.md`.
