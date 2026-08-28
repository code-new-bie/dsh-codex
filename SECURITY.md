# Security Policy

## Scope

Security-sensitive areas include command execution, filesystem mutation, sandbox/approval translation, credential/model configuration, session persistence and the local presentation transport.

## Core invariant

The TUI is presentation. **DeepSeek Harness owns policy enforcement.** DSHX must never turn a denied, approval-required or unavailable DSH operation into an allowed local operation.

When a DSH permission/capability cannot be represented faithfully by the pinned Codex UI/protocol, DSHX fails closed or hides that surface.

## Runtime ownership

Production has one Harness runtime: the user's installed `dsh --profile tui` process. DSHX packages must not install or boot a second DSH runtime. The presentation adapter operates inside the already-mounted Context and delegates stateful behavior to public DSH services.

The TUI child must never spawn a DSH/backend child or fall back to Codex Agent/runtime ownership.

## Production transport

The production protocol is never exposed on a listening endpoint:

```text
official DSH parent
   ⇅ anonymous directional child-process pipes
pinned Codex TUI child
```

Child descriptors are arranged so protocol bytes and terminal input stay separate: protocol input arrives on child fd0, original terminal stdin is preserved as fd3 and restored before terminal initialization, and protocol output leaves on fd4.

Consequences:

- no TCP/WebSocket listener;
- no Unix-domain socket;
- no rendezvous path or bearer token;
- no IPC bridge executable;
- no reconnect/attach surface;
- transport lifetime is bounded by the parent/child process relationship.

On Unix the native thin fork clears inherited nonblocking flags before file-backed protocol reads/writes. On Windows it restores both CRT stdin and the Win32 standard input handle before crossterm uses the console.

## Failure and shutdown behavior

- Loader composition must settle before the native TUI is started.
- A missing packaged TUI or missing protocol descriptor is a startup failure, not a fallback to Codex core.
- Protocol parse/dispatch failures stay on the protocol/error channels and cannot contaminate terminal protocol output.
- TUI exit requests official DSH `appExit`; the DSH launcher/root Fiber remains teardown authority.
- Presentation disposal closes the adapter and terminates a still-running child without inventing another runtime lifecycle.

## Capability boundary

Regression coverage must ensure:

- approval cancellation/rejection is fail-closed;
- shell/filesystem execution goes through DSH tools and sandbox policy;
- Ctrl+C/interrupt delegates to DSH Agent/subagent authority;
- resume preserves DSH-owned session/model state;
- DSH credentials/profile documents are not rewritten by DSHX;
- malformed/unknown protocol messages cannot gain capability;
- no production network listener/bridge/local-server path reappears;
- no production DSH dependency or private composition reappears;
- the TUI cannot start a backend runtime child;
- unsupported Codex runtime commands remain hidden or explicit failures.

## Reporting

Please report security issues privately to the repository owner rather than opening a public issue with exploit details.
