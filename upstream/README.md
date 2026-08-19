# Upstream baselines

This directory records the exact upstream revisions used by `dsh-codex`.

- `CODEX_COMMIT` — pinned `openai/codex` revision used for TUI/protocol compatibility work.
- `DSH_COMMIT` — pinned `deepseek-ai/deepseek-harness` revision used for runtime compatibility work.

Do not update either file as part of an unrelated feature. Upstream moves should be isolated, reviewed and accompanied by compatibility test results.

When Codex TUI source is vendored or synchronized, preserve its Apache-2.0 notices. DSH-derived code or interfaces remain subject to the upstream MIT terms where applicable.
