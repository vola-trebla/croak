# Security policy

croak is a security tool, so a bug in croak can be a vulnerability in your
workflow. Reports are very welcome.

## Status

Early development. Only the latest `main` is supported; there are no releases
yet.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability
reporting: **Security → Report a vulnerability** on this repository.

Include what you ran, the input (a minimal repo or `package.json` is ideal),
what croak reported, and what you expected. This is a personal project, so
responses are best-effort, but security reports are read first.

## What counts as a vulnerability

- croak **executes** analyzed code, or a file in a scanned repo influences
  what croak itself runs
- a detector can be made to **lower** a verdict, skip a file it should read,
  or report a scan as clean when it was incomplete
- the report can be manipulated (for example terminal escape sequences that
  hide findings)
- hostile input makes croak crash, hang, or exhaust memory

## Known limits (not vulnerabilities)

croak documents what it does not catch — runtime-only payloads, payloads
reached through `require` chains beyond the files a script runs directly,
long-game maintainer takeovers, network inside the sandbox, and more. See
[docs/security-model.md](docs/security-model.md) and the README. Ideas for
closing those gaps are welcome as regular issues.
