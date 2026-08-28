# Production runtime integration

## Decision

DSHX is a **DSH profile surface**, not an application that embeds or launches a private Harness runtime. The user's installed `dsh --profile tui` process owns the Cordis Loader tree and all runtime services. DSHX contributes a startup row, a presentation row, protocol projection code and the pinned native TUI.

The tested development closure is DSH `0.1.0-rc.8`, but production compatibility is host-driven. Runtime peer declarations use a compatibility floor and remain optional advisory peers so installing DSHX cannot materialize a second Harness runtime into the profile.

## Lifecycle

1. `dshx` resolves the user's DSH launcher and idempotently ensures this package is installed into the selected profile through `dsh plugin --profile <p> add <package>`.
2. `dshx` starts `dsh --profile <p> ...` with the user's arguments unchanged.
3. The Loader composes `dshx-startup` and `dshx-presentation` from `cordis.patch.yml`.
4. `dshx-startup` reads official `cmdlineArgs` and publishes presentation facts (`cwd`, presentation home, package version, TUI args).
5. `dshx-presentation` waits for Loader settlement and starts the packaged native TUI as its child.
6. The presentation row binds anonymous directional child pipes directly to the live DSH Context through `startDshxStdioTransport`.
7. The TUI speaks the pinned Codex app-server-compatible JSONL dialect across those pipes; the adapter translates to DSH public services/events.
8. TUI exit requests official `appExit`, so the DSH launcher disposes the root composition and remains the sole teardown authority.

## Descriptor contract

The DSH parent uses Node's supported directional stdio semantics:

```text
child fd0  protocol input   DSH → TUI
child fd1  terminal stdout
child fd2  terminal stderr
child fd3  preserved terminal stdin
child fd4  protocol output  TUI → DSH
```

Spawn configuration:

```js
stdio: ['pipe', 'inherit', 'inherit', 0, 'pipe']
```

The native thin fork performs descriptor remapping before crossterm initializes:

- duplicate fd 0 to preserve protocol input;
- restore fd 3 onto ordinary stdin;
- on Unix, clear inherited `O_NONBLOCK` from the saved input and fd 4 before Tokio file I/O;
- on Windows, restore both CRT fd 0 and `STD_INPUT_HANDLE`;
- create `RemoteAppServerEndpoint::InheritedPipes { input_fd, output_fd }`.

The app-server client reads from the saved input descriptor and writes to fd 4. It does not spawn a backend process.

## No transport service

The production transport deliberately has no address and no listening service. DSHX does not use:

- TCP/WebSocket remote mode;
- Unix-domain sockets;
- local socket rendezvous directories;
- bearer-token loopback auth;
- a Rust/Node bridge executable;
- a Node local-server process.

The process relationship itself provides the local trust/lifetime boundary.

## Adapter authority

The adapter may:

- create/resume Agents through official DSH services;
- forward follow-up, steering, interrupt and subagent control;
- subscribe to Agent/Session events;
- read official persistence/session-query surfaces;
- project those facts into Codex Thread/Turn/Item UI shapes;
- keep disposable correlation state needed only for presentation;
- translate approval/question UI responses to the matching DSH service.

It must not:

- implement an Agent loop;
- call model providers directly;
- execute tools/shell commands outside DSH;
- store a second durable transcript;
- reimplement session repair, compaction, fork, skills, subagents, jobs or plugins;
- decide sandbox/approval policy;
- persist independent model/runtime state when DSH owns it.

Missing required public services are compatibility errors, not extension points for shadow implementations.

## Development and test topology

Protocol unit tests can instantiate deterministic adapters in-process. Real TUI PTY/ConPTY tests use `devtools/tui-stub-parent.mjs`: the **test parent** owns a deterministic protocol stub and launches the TUI with the same descriptor layout as production. This validates terminal stdin restoration, native directional-pipe transport, CJK input and resize without requiring provider credentials or network calls.

Separately, `scripts/runtime-smoke.mjs` and `scripts/verify-bundle-install.mjs` exercise the real official DSH profile and prove that Loader settlement, initialize, appExit and single-runtime ownership work through the same parent-owned pipe contract.

## Compatibility

DSH and Codex are moving upstreams. The repository pins a tested source/package closure for reproducible CI and keeps Codex divergence as an ordered patch queue, but production resolves the actual DSH services from the host installation.

If an upstream DSH release removes a required public seam, DSHX adapts through another public seam or reports an incompatibility. It does not preserve compatibility by copying DSH internals.

A Codex pin is advanced only when the patch queue materializes cleanly and the core, native build, bundle, PTY/ConPTY, platform and UX-parity gates pass again.
