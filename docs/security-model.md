# Security model

croak is a security tool, so it is a target. This document defines what croak
trusts, what it treats as hostile, and the rules that keep the analysis
itself from becoming the vulnerability. `toad-reviewer` and the invariant
checks (`pnpm invariants`) enforce it.

## Trust boundary

| Trusted                                       | Untrusted (hostile by default)                           |
| --------------------------------------------- | -------------------------------------------------------- |
| croak's own code and its pinned dev toolchain | every file in a scanned repo or package                  |
| Node.js runtime                               | package tarballs and their entries (names, sizes, types) |
| user's croak configuration                    | registry metadata: names, READMEs, versions, maintainers |
|                                               | LLM output (M5)                                          |
|                                               | the user's project `.npmrc` when planning installs (M3)  |

Registry _transport_ is trusted to deliver what the registry has; the
_content_ is not.

## Rules

### 1. Analyzed content is data, never code

- No execution APIs in croak's code: `child_process`, `vm`, `worker_threads`,
  `node:module`, `eval`, `new Function`, `require`, dynamic `import()`.
  Enforced by `pnpm invariants` on every PR.
- No filesystem writes in analysis code. Analyzers only read.
- Our own test runner only collects `src/**/*.test.ts` — fixtures may ship
  their own tests (found in the M0 review).

### 2. Read safely

- Directory walks never follow symlinks; symlinks are recorded, not read.
- The root `.git` contributes only what git itself executes — `config` (e.g. a
  `core.fsmonitor` command that runs on `git status`) and `hooks/` — and its
  object store is skipped. Nested `.git` directories are walked like any other
  directory: inside a working tree they are a hiding place.
- `node_modules` is walked on purpose: a committed one can hide code. Its
  presence is itself a warning (`repo/node-modules-present`, one per directory),
  since `croak repo` checks repos before install; oversized files inside it are
  `info`, because large bundles are normal in installed dependencies.
- Files are opened with `O_NOFOLLOW` and only if they were listed as regular
  files — no path traversal through `read()`.
- `read()` verifies the file's device and inode against the listing and reads
  at most one byte past the cap, so a file swapped (even via an intermediate
  directory) or grown after listing raises `SnapshotIntegrityError`.
- POSIX only: without `O_NOFOLLOW` (Windows) croak refuses to scan instead of
  silently losing the guard; `package.json` declares `darwin` and `linux`.
- Tarballs (M3) are never extracted to disk. Gunzip with `maxOutputLength`
  (decompression bombs), parse tar entries in memory. With no disk writes,
  `../` entries and symlink entries cannot escape.

### 3. Bound every resource

| Limit                                     | Value   | On exceed                              |
| ----------------------------------------- | ------- | -------------------------------------- |
| file size read                            | 1 MB    | file recorded as `oversized`, not read |
| directory entries (files, dirs, symlinks) | 100,000 | `SnapshotLimitError` → fail closed     |
| directory depth                           | 64      | `SnapshotLimitError` → fail closed     |
| decompressed tarball (M3)                 | TBD     | fail closed                            |
| scan time (M2)                            | TBD     | fail closed                            |

An incomplete scan is never reported as a clean scan. Oversized code files
(JS/TS/JSON, `.git` config and hooks; lockfiles exempt) produce a
`repo/unscanned` warning from a detector that is always registered; in agent
mode (M4) unscanned code is fail-closed.

### 4. Regexes over hostile text must not blow up (M2)

Detectors run regexes on attacker-controlled text, so catastrophic
backtracking (ReDoS) is a denial-of-service vector. Keep patterns simple, cap
the line length a detector scans, and test detectors against pathological
input with a time budget.

### 5. The one external process: npm/pnpm for install plans (M3)

This is the weakest point of the design: running a package manager against an
untrusted project. Before shipping M3:
- copy only `package.json` and the lockfile into a temporary directory — the
  project's `.npmrc` is not used unless the user opts in;
- run with `--package-lock-only` / `--lockfile-only` and `--ignore-scripts`;
- run with a minimal environment (no `NPM_TOKEN`, cloud credentials, etc.);
- do not resolve `git:`, `file:`, `link:`, or URL dependencies — report them
  as signals instead;
- prove with tests that no lifecycle script runs on this path.

### 6. Least privilege (M2 spike)

Investigate running analysis under Node's permission model
(`node --permission --allow-fs-read=<target>`): read-only access to the target,
no child processes, no workers. Defense in depth — even a bug in croak could
not execute analyzed code. Network is likely not covered and needs checking.

### 7. Verdict semantics

- **Facts → signals → verdict.** The presence of a file (`tasks.json`, a
  `postinstall`) is a fact, not a finding. Verdicts come from what the fact
  does and its context. Every detector has a malicious case and a benign twin
  in the eval.
- **Nothing lowers a deterministic finding.** Not the LLM layer (M5), and not
  provenance (M7).
- **Provenance is evidence of origin, not of safety.** A registry signature
  shows the tarball is what the registry has; provenance shows which CI
  workflow built it from which commit; a source diff shows whether the
  published files match that commit. A valid provenance on a malicious commit
  is still malicious. The useful signals are _changes_: provenance that
  disappeared, a different repo or workflow, or new executable entry points
  (install scripts, `bin`, native binaries) that the source does not have.

### 8. Eval fixtures

Payloads are inert (`echo`, `localhost`, `.invalid` domains). **Every**
fixture — malicious and benign — carries the `SYNTHETIC croak eval fixture`
marker and the `croak-eval-synthetic` token in a readable file (enforced by a
test), so a detector keying off them gets false alarms rather than a perfect
score; `pnpm invariants` also forbids the marker in non-test code. Fixtures
cannot contain a `.git` directory (git refuses to commit one), so `.git`
attacks are covered by unit tests on generated directories instead. Real samples are referenced by name
and hash only; `eval/samples/` is gitignored.
