# DSHX (`dsh-codex`)

DSHX is a standard **DeepSeek Harness TUI bundle** that reuses a pinned Codex TUI thin fork for terminal rendering and interaction. Agent behavior remains owned by the user's installed DeepSeek Harness.

## Product contract

Normal use is simply:

```bash
cd /path/to/project
dshx
```

The interaction target is the pinned Codex CLI/TUI: composer, slash commands, model and permission pickers, approvals, ask-user flows, tool/shell cells, diffs, plan/reasoning presentation, steering, Ctrl+C interrupt, resume, status/footer, scrolling, resize and mouse behavior. Windows Terminal and CJK/IME are release gates.

DSHX does **not** ship a Codex agent runtime, a second DSH runtime, a WebUI dependency, a local server, a WebSocket/UDS bridge, or a user-facing remote-mode command.

## Standard DSH plugin delivery

The package declares `dsh.bundle.patch`, so DSH installs and composes it through the official plugin/profile machinery:

```bash
dsh plugin --profile tui add ./code-new-bie-dshx-tui-<version>.tgz
dsh --profile tui

dsh plugin --profile tui remove @code-new-bie/dshx-tui
```

`dshx` is only a convenience bootstrap. It ensures the selected profile contains this package and then starts the user's official `dsh --profile <profile>` launcher. The DSH process owns the Loader tree, runtime services and process-exit lifecycle.

## Runtime topology

```text
dshx
  │ thin profile bootstrap
  ▼
user-installed dsh --profile tui        ← sole runtime owner
  │
  ├─ dshx-startup Cordis row
  └─ dshx-presentation Cordis row
         │
         │ launches presentation child only
         ▼
    pinned Codex TUI thin fork
         ⇅ anonymous directional child-process pipes
    TUI-protocol projection
         ⇅ official DSH public APIs/events
    Agent / Session / tools / policy / persistence
```

The production transport has no listener and no address. The DSH parent starts the native TUI with three inherited descriptor facts:

- child fd `0`: protocol input, DSH → TUI;
- child fd `3`: preserved terminal stdin;
- child fd `4`: protocol output, TUI → DSH.

The thin fork saves protocol fd 0, restores the terminal handle onto ordinary stdin before crossterm starts, and connects its app-server-compatible client to the two protocol descriptors. This keeps the upstream TUI in charge of terminal I/O while the already-mounted DSH Context stays in charge of runtime behavior.

## Ownership boundary

DSHX owns only:

- the pinned Codex TUI thin fork and its narrow patch queue;
- UX parity and branding;
- the standard DSH startup/presentation rows;
- the anonymous presentation transport;
- the thinnest practical projection from DSH public APIs/events into the TUI protocol.

DeepSeek Harness owns:

- Agent creation, continuation and cancellation;
- Session identity, history and persistence;
- model selection, routing and credentials;
- tools and shell execution;
- sandbox and approval policy;
- user questions;
- skills, subagents, plugins and jobs/workflows.

If DSH does not expose a capability that the Codex UI expects, DSHX hides it, degrades it explicitly, or fails closed. It does not create a replacement runtime.

The Codex protocol dialect is confined to `src/tui-protocol/`. Modules under `src/dsh/` use DSH vocabulary and public services.

## Host compatibility

Production does not pin the user's DSH installation to one exact release. DSH packages are optional advisory peers with a compatibility floor; the profile resolves services from the host installation. Development and CI freeze one tested DSH closure so regressions are reproducible without shipping that closure as a second runtime.

## Build and verification

Source builds require Node.js supported by DSH (`^22.19.0 || >=24.0.0`), Rust/Cargo, Git and the pinned Codex platform toolchain. CI/release dependency freezing uses Node 24 LTS / npm 11.

```bash
npm ci
npm test
node scripts/verify-ownership-boundary.mjs
node scripts/runtime-smoke.mjs
```

Build the pinned native TUI:

```bash
# Linux/macOS
./scripts/build-codex-tui.sh

# Windows PowerShell
./scripts/build-codex-tui.ps1
```

Then verify the materialized thin fork and standard bundle delivery:

```bash
node scripts/verify-tui-invariants.mjs
npm run verify:bundle
```

`verify:bundle` performs pack → official `dsh plugin --profile tui add` into an isolated DSH home → composed-tree assertions → live directional-pipe initialize → single-runtime assertions.

Linux/macOS PTY and Windows ConPTY tests use a deterministic **test parent** that owns the protocol stub and starts the native TUI with the same directional-pipe topology as production. The TUI never starts that stub itself.

## Release model

Ordinary CI runs the Node/DSH core gate followed by a Linux native-TUI gate. Release-candidate validation additionally runs macOS PTY and Windows ConPTY/CJK gates. Release tags build platform-specific tarballs, clean-install them, verify standard plugin activation and publish checksums/provenance.

A release artifact contains the DSHX Cordis rows/projection code and one matching `dshx-tui` native binary. It does not contain a bridge executable or a private DSH runtime.

Manual Windows Terminal acceptance remains required for real IME composition/cancel behavior and side-by-side visual parity; automated ConPTY can validate Chinese text and resize but cannot fully emulate an IME.

See:

- `docs/ARCHITECTURE.md`
- `docs/RUNTIME-INTEGRATION.md`
- `docs/DSH-CAPABILITY-MATRIX.md`
- `docs/UX-PARITY.md`
- `docs/RELEASE-READINESS.md`

## License

Apache-2.0 for project-owned code. Synchronized upstream code retains its applicable upstream notices and license requirements.
