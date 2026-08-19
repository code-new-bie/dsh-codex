# dsh-codex

A production-oriented DeepSeek Harness CLI that reuses the Codex terminal UX as closely as practical while keeping **DeepSeek Harness as the agent runtime and source of truth**.

## Goal

`dsh-codex` is not another Codex-like TUI. The target is a thin Codex TUI fork plus a DSH backend compatibility layer, so the visible interaction model stays aligned with Codex while sessions, model routing, tools, sandboxing, approvals, skills and subagents remain owned by DSH.

```text
Codex TUI (thin fork)
        │
        │ app-server compatible protocol
        ▼
dsh-codex adapter
        │
        ▼
DeepSeek Harness / Cordis
        │
        ├─ Session
        ├─ Agent loop
        ├─ LLM routing
        ├─ Tools
        ├─ Sandbox / Approval
        ├─ Skills
        └─ Subagents
```

## Product principles

1. **DSH is authoritative.** No second session database and no second policy engine.
2. **Reuse Codex UI instead of imitating it.** Keep the upstream TUI diff small and auditable.
3. **Protocol boundary first.** Translate DSH Session/Agent/Event concepts into Codex Thread/Turn/Item concepts.
4. **Production transports only.** Experimental remote transports are useful for development, not the final runtime dependency.
5. **Windows is a first-class target.** Windows Terminal/PowerShell behavior is part of the release gate.

## Repository status

The repository is being reset around the thin-fork architecture. The earlier custom `pi-tui` prototype is preserved separately for reference and is **not** the target implementation.

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/UX-PARITY.md`](docs/UX-PARITY.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SECURITY.md`](SECURITY.md)

## Intended CLI

```bash
dsh-codex
# or eventually
dsh --profile codex
```

The user-facing experience should intentionally track Codex for the welcome screen, composer, slash commands, model/permission pickers, approvals, tool cells, diffs, plans, steering, resume picker, status/footer, scrolling and keyboard behavior.

## License

Apache-2.0. Any vendored upstream code keeps its original notices and license requirements.
