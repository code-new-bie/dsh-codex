# Codex UX Parity Matrix

The target is behavioral parity with the pinned Codex TUI, not a screenshot-inspired imitation.

## Acceptance matrix

| Surface | Target |
|---|---|
| Welcome screen | same structure, DSH branding/data only |
| Composer | same multiline/editing behavior |
| Slash completion | same interaction pattern |
| Help/shortcuts | same keyboard model where applicable |
| Model picker | same presentation; data from DSH |
| Permission picker | same presentation; policy from DSH |
| Tool cells | same renderer classes where mappings exist |
| Shell cells | same streaming/collapse behavior |
| File diffs | same review rendering |
| Approval | same interaction; decision returned to DSH |
| Ask user | same picker/freeform experience |
| Plan | same presentation mapped from DSH plan state |
| Reasoning | same cell behavior where DSH exposes it |
| Steering | same active-turn input semantics |
| Interrupt | same Ctrl+C expectation |
| Resume | same picker behavior; sessions from DSH |
| Status/footer | same structure; DSH metrics/data |
| Scroll/mouse | same behavior |
| Resize | no corruption or state loss |
| Windows Terminal | first-class release gate |
| CJK/IME | first-class release gate |

## Allowed deliberate differences

- Product branding.
- Model/provider names.
- Backend-specific capabilities that have no Codex equivalent.
- DSH-specific commands placed under an isolated namespace.
- Explicit unsupported messages when semantic translation would be unsafe or misleading.

## Not acceptable

- Reimplementing a Codex widget merely because it looks simple.
- Maintaining a separate session history for UI convenience.
- Downgrading an approval requirement during protocol translation.
- Silent model changes on resume.
- Calling a generic readline prompt a TUI.

## Release comparison

Every release candidate should be tested side by side against the pinned upstream Codex version on the same terminal dimensions and theme. Differences are either fixed, documented as deliberate, or block release.
