# DSHX (`dsh-codex`)

DSHX is a production-oriented terminal frontend for **official DeepSeek Harness** with a Codex-grade interaction target.

## Product goal

From any code project, the normal production entry point must be:

```bash
dshx
```

The user should get an experience that tracks the pinned Codex CLI/TUI as closely as practical: welcome screen, composer, slash commands, model/permission pickers, approvals, tool/shell cells, diffs, plan/reasoning, steering, interrupt, resume, status/footer, scrolling, resize, mouse and CJK/IME behavior.

## Ownership boundary

We maintain only:

- the Codex TUI thin fork / upstream sync;
- TUI behavior and UX parity;
- the `dshx` launcher and packaging;
- the thinnest practical adapter from DSH **public APIs/events** to the TUI protocol.

We do **not** maintain, fork or recreate DeepSeek Harness capabilities. DSH owns the agent loop, sessions, model routing, tools, sandbox, approval policy, skills, subagents, plugins, jobs/workflows and persistence.

If DSH does not expose a capability, DSHX waits for upstream or degrades/hides the corresponding UI. It does not implement a replacement runtime.

```text
Codex TUI thin fork             ← dsh-codex owns presentation
        │
        │ app-server-compatible projection
        ▼
thin DSH UI adapter             ← dsh-codex owns translation only
        │
════════════════ ownership boundary ════════════════
        │
        ▼
Official DeepSeek Harness       ← upstream owns capabilities/runtime
```

## Product principles

1. **Reuse Codex UI instead of imitating it.** Keep upstream rendering/input code as intact as practical.
2. **DSH is authoritative.** Never create a second session database, policy engine or agent runtime.
3. **Adapter, not framework.** Protocol translation is allowed; reimplementation of DSH capabilities is not.
4. **Fail closed.** Permission/approval semantics that cannot be represented faithfully must never be silently weakened.
5. **`dshx` is the product command.** Production users do not manually run Codex remote mode, bridge processes or DSH profile plumbing.
6. **Windows is first-class.** Windows Terminal/PowerShell and Chinese IME are release gates, not follow-up polish.

## Current status

`main` contains the architecture baseline. Active M0 work is on `work/protocol-poc`.

M0 intentionally uses Codex remote/app-server transport only as a development harness to prove the UI/protocol seam. It is **not** the production transport. The production target is a pinned Codex TUI thin fork packaged behind `dshx`.

The earlier custom `pi-tui` implementation is a legacy prototype and is not the target product.

See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TEAM.md`](docs/TEAM.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/UX-PARITY.md`](docs/UX-PARITY.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SECURITY.md`](SECURITY.md)

## M0 development launcher

On the protocol-PoC branch, after installing dependencies and the pinned development Codex CLI:

```bash
npm install
npm link

dshx doctor
dshx
```

This development launcher starts a deterministic compatibility stub and attaches the Codex TUI to it. The next milestone replaces the stub with a thin adapter over official DSH public APIs.

## License

Apache-2.0 for project-owned code. Vendored/synchronized upstream code keeps its applicable upstream notices and license requirements.
