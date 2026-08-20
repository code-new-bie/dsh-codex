# Security Policy

## Scope

Security-sensitive areas include command execution, filesystem mutation, sandbox policy, approval translation, credential/model configuration, session persistence and local presentation transports.

## Core invariant

The TUI is presentation. DeepSeek Harness owns policy enforcement. The adapter must never silently turn a denied or approval-required DSH operation into an allowed operation.

When a DSH permission concept cannot be represented faithfully by the current Codex UI/protocol, fail closed and surface the incompatibility to the user.

## Production transport

DSHX does not expose its production presentation protocol on a TCP listener. The product topology is:

```text
pinned Codex TUI
  ↕ WebSocket framing over private local Unix-domain socket
packaged dshx-ipc-bridge
  ↕ JSONL over child stdio
DSHX presentation adapter
  ↕ official public APIs/events
DeepSeek Harness
```

The pinned TUI explicitly rejects TCP WebSocket endpoints in DSHX mode.

On Unix, the rendezvous directory is a fresh random directory below the system temporary directory and both DSHX and pinned `codex_uds` enforce owner-only `0700` directory permissions.

On Windows, pinned `codex_uds` cannot apply Unix permission bits, so DSHX deliberately does **not** trust an arbitrary/shared `%TEMP%` as the default rendezvous root. The random socket directory is created below the current user's DSHX presentation home (`~/.dshx/codex-tui/i/` by default), inheriting the user's profile ACL. The Windows suffix is deliberately short, and DSHX rejects an AF_UNIX pathname at or above the fixed 108-byte `sun_path` capacity before launching the bridge; the error instructs the user to select a shorter `DSHX_TUI_HOME` under the user profile. Path length is measured in UTF-8 bytes so non-ASCII profile paths fail predictably rather than at bind time.

Startup is transactional. Socket-directory creation/path validation, official DSH boot, bridge readiness, and presentation-Adapter construction are one startup transaction. If any stage fails, DSHX closes readline state, terminates the bridge with bounded escalation, disposes the official DSH runtime when one exists, and removes the private rendezvous directory. Cleanup failures are diagnostic-only during failed startup: they must never replace the original startup error reported to the user.

The bridge removes its socket path on exit and the launcher removes the random rendezvous directory during bounded shutdown. Rendezvous cleanup is performed even if official DSH runtime disposal itself fails.

The isolated DSHX presentation home is never the user's ordinary `CODEX_HOME`.

## Reporting

Please report security issues privately to the repository owner rather than opening a public issue with exploit details.

## Release requirements

A production release must include regression coverage for:

- approval cancellation and rejection;
- shell/filesystem permission escalation;
- interrupted turns;
- session resume without privilege drift;
- model/provider configuration preservation;
- user profile/home DSH patch files remaining unmodified by DSHX;
- malformed/unknown protocol events;
- private local-IPC path creation and Windows AF_UNIX UTF-8 path limits;
- transactional startup rollback for socket creation, DSH boot, bridge readiness and Adapter-construction failures;
- startup cleanup failures preserving the original failure as the reported root cause;
- bounded shutdown cleanup even on runtime-disposal failure;
- no production TCP listener or Codex-core fallback;
- transport disconnect/reconnect behavior where applicable.
