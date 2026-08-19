# Security Policy

## Scope

Security-sensitive areas include command execution, filesystem mutation, sandbox policy, approval translation, credential/model configuration, session persistence and remote/local transports.

## Core invariant

The TUI is presentation. DeepSeek Harness owns policy enforcement. The adapter must never silently turn a denied or approval-required DSH operation into an allowed operation.

When a DSH permission concept cannot be represented faithfully by the current Codex UI/protocol, fail closed and surface the incompatibility to the user.

## Reporting

Please report security issues privately to the repository owner rather than opening a public issue with exploit details.

## Release requirements

A production release must include regression coverage for:

- approval cancellation and rejection;
- shell/filesystem permission escalation;
- interrupted turns;
- session resume without privilege drift;
- model/provider configuration preservation;
- malformed/unknown protocol events;
- transport disconnect/reconnect behavior where applicable.
