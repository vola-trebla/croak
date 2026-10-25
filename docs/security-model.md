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

### 5. The one external process: npm for install plans (M3, D24)

croak itself never spawns a process. Planning an install needs npm, so that
lives in one small wrapper, `scripts/croak-install.sh`, and croak only reads
its result (`croak plan --before <lock> --after <lock>`). The wrapper:
- works in a fresh temporary directory with copies of `package.json` and the
  lockfile only — the project's `.npmrc` is not used, and the project's own
  files are never modified;
- runs npm with an empty environment and empty user/global npm config, so no
  auth tokens or cloud credentials are visible to it;
- uses the public registry only, and sets `git` to `/usr/bin/false`, so git
  dependencies fail the plan instead of being cloned (fail closed);
- runs `npm install --package-lock-only --ignore-scripts`.

`scripts/test-croak-install.sh` (in CI) proves the path runs no lifecycle
script: a bait package whose `preinstall`/`postinstall`/`prepare` would create
a marker file is planned from a local tarball, and the test fails if the
marker exists or the project changed. A plain `npm install` of the same bait
does run it.

This is isolation, not a sandbox: npm still talks to the network and parses
untrusted registry metadata, and `--ignore-scripts` is not treated as one. A
lockfile diff is not the whole story either: croak checks every new or
changed package version in the planned tree, transitive ones included.

### 6. Least privilege: run croak sandboxed (checked 2026-10-25, D23)

Node 24's permission model runs croak with read-only access to its own code
and the scan target:

```bash
node --permission --allow-fs-read=<croak dir> --allow-fs-read=<target> \
     --disallow-code-generation-from-strings <croak dir>/dist/cli.js repo <target>
```

Measured: croak produces the same verdicts, while child processes, file
writes, worker threads, `eval`, and `new Function` all fail
(`ERR_ACCESS_DENIED` / `EvalError`). So even a croak bug that ended up
"running" analyzed code would get almost no capabilities. **Network is not
covered**: Node 24 has no network permission, so `fetch` still works inside
the sandbox. CI runs croak sandboxed on every PR, so a change that needs any
of the denied capabilities fails the build.

Known gap: a target outside the read allowlist crashes croak with a raw
`ERR_ACCESS_DENIED` stack instead of a clean error. To fix with the M4 hook,
which will run croak sandboxed by default.

### 7. Verdict semantics

- **🟢 allow** means nothing suspicious was found — not a guarantee.
  **🟡 warn** means behavior that needs attention was found — never "safe to
  run". **🔴 block** means strong evidence of an attack. The CLI report states
  this on every run.
- **Install scripts:** a script made only of inert tools (husky, tsc, …) or
  `npm run` calls to such scripts, with no network, local files, inline code,
  code signals, environment assignments, redirects, wrappers, or
  workspace-wide runs, is an info note (D19). Tools that execute repo code
  (vite, prisma, turbo, …) and any other install-time script are at least a
  warning (code runs). Network alone stays a warning; network combined with secrets, process
  spawning, eval, or decoding — in the command, its inline code, or the file it
  runs — is a block, as is download-and-execute in any form (pipe, substitution,
  or a downloaded file run later). Recognizing a known tool (prisma, husky, …)
  adds an info note and never lowers anything else in the same command.
- **Analysis depth (known limit):** croak reads the script and the files it runs
  directly. It does not follow `require`/`import` from those files yet, so a
  clean-looking `setup.js` that requires a malicious module is only as visible
  as the module itself is to other detectors.
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
