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
  (decompression bombs), parse tar entries in memory, verify every header
  checksum. With no disk writes, `../` entries and symlink entries cannot
  escape. Tarballs come only from `registry.npmjs.org` over https and must
  match the lockfile's integrity hash, or the package blocks (D27).
- The tar reader must read an archive exactly as npm's tar (node-tar) does:
  a file croak sees differently from what npm installs is a bypass. Where the
  two could disagree (a zero block before more entries, duplicate or `../`
  paths, unknown entry types, global pax paths) the archive is rejected and
  the check is incomplete (D31).

### 3. Bound every resource

| Limit                                     | Value   | On exceed                               |
| ----------------------------------------- | ------- | --------------------------------------- |
| file size read                            | 1 MB    | file recorded as `oversized`, not read  |
| directory entries (files, dirs, symlinks) | 100,000 | `SnapshotLimitError` → fail closed      |
| directory depth                           | 64      | `SnapshotLimitError` → fail closed      |
| file size read in a tarball (M3)          | 8 MB    | entry recorded as `oversized`, not read |
| decompressed tarball (M3)                 | 256 MB  | `TarballError` → incomplete             |
| tarball entries (M3)                      | 20,000  | `TarballError` → incomplete             |
| one tarball download (M3)                 | 100 MB  | `RegistryError` → incomplete            |
| all tarballs of one plan (M3)             | 300 MB  | incomplete                              |
| scan time (M2)                            | TBD     | fail closed                             |

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
- runs `npm install --package-lock-only --ignore-scripts`;
- compares the plan with what is really installed: entries of
  `node_modules/.package-lock.json` whose folder holds that package and
  version (`croak plan --installed`), not the project's lockfile. On a fresh
  clone npm installs, and runs the scripts of, everything the lockfile lists,
  so all of it is checked. An entry counts as installed only when its folder
  holds that package and its source and hash match the plan (D34, D35). `--ci` checks the lockfile as written (npm ci reinstalls every
  package), `--update` plans `npm update`, `--empty` plans into an empty
  project (npx, `npm install -g`);
- plans a workspace from its root, where the package manager installs, with
  every manifest of the project copied (never `node_modules` or `.git`; a
  file name with a control character, or more than 5,000 manifests, is
  refused); refuses (exit 2) `npm-shrinkwrap.json`, not checked yet;
- with `--pnpm`, runs pnpm the same way, plus what pnpm needs that npm does
  not (D39): pnpm can run code before it resolves anything. corepack fetches
  and runs the pnpm version a project's `packageManager` names, so the root
  manifest is copied without `packageManager`/`devEngines`, and corepack runs
  with its network off and only the user's own cache; `pnpm-workspace.yaml`
  can load pnpmfiles and config dependencies, so it is copied with
  resolution settings only. Both pass through `croak sanitize`.

`scripts/test-croak-install.sh` (in CI) proves the path runs no lifecycle
script: a bait package whose `preinstall`/`postinstall`/`prepare` would create
a marker file is planned from a local tarball, and the test fails if the
marker exists or the project changed. A plain `npm install` of the same bait
does run it. The same test covers a fresh clone, `--ci`, `--empty` and `--json`.
The bait is packed with `tar`: npm 10's `npm pack` runs `prepare` even with
`--ignore-scripts`.

`croak plan` itself talks to one host, registry.npmjs.org over https, for
two things: each new package's metadata (names validated against npm's rules
first, 15 s timeout, 200 MB cap per response) and each new version's tarball
(only URLs that pass `registryTarball()`: https, that host, no port or
credentials; 60 s timeout, 100 MB cap, 300 MB per plan; verified against the
lockfile's integrity hash). `--metadata-only` skips the tarballs; `--offline`
skips both. A lockfile entry that points anywhere else is reported as
`install/source`, never silently skipped.

The agent hook (`scripts/croak-hook.sh`, D32) is a second small shell script
in the same role: it runs `croak hook plan` (read the command, find the
installs), runs `croak-install` for each, and runs `croak hook decide`. croak
still only reads files. Any error the script sees is exit 2 (deny); for
crashes and timeouts it cannot see, the hook must be registered with
`"onFailure": "block"`, because Claude Code otherwise lets the command through.

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

`croak-install` (and so the agent hook) runs `croak plan` this way: read
access to croak, the project and the plan's temporary directory; write
access only to croak's cache directory (D33). The hook's own plan and decide
steps are not sandboxed: they parse the command text and check which paths
exist, and never touch package code.

The one thing croak writes is its content verdict cache
(`$XDG_CACHE_HOME/croak/content`, default `~/.cache/croak/content`;
directory 0700, files 0600), from one file the invariant tripwire allows
(`src/install/content-cache.ts`). Entries are keyed by the tarball's sha512
and croak's own code, so changed rules never reuse an old verdict; a corrupt
entry or one croak cannot read is a miss. Someone who can write that
directory can forge verdicts, but they can already change your files.
`croak plan --no-cache` skips it.

Known gap: a target outside the read allowlist crashes croak with a raw
`ERR_ACCESS_DENIED` stack instead of a clean error.

### 6b. The LLM layer (M5, D36)

Opt-in only: `croak plan --llm` (or `CROAK_LLM=1` for `croak-install` and the
hook) with `ANTHROPIC_API_KEY` set. What leaves the machine: for each package
the rules warned about, the diff between its previous version and this one
(public registry tarballs, downloaded and hash-checked like the rest), sent to
Anthropic's API through the official SDK, the one runtime dependency
(pinned). Never the project's own files, lockfile or environment. The model's
answer can only add a finding (`escalate()`, tested exhaustively); package
content is untrusted input inside a per-call random boundary, and the prompt
says text addressed to the reviewer is no evidence. A missing key, a refusal,
a malformed answer or a network error leaves the rules' verdict with an info
line. The SDK is loaded only when the step runs (one allowed dynamic import,
`src/llm/client.ts`): never by `croak repo`, the hook's own steps, or a plan
without `--llm`. Through `croak-install` it runs inside croak's sandbox (Node
permission model); network is not covered by it, as for the registry. Calls
time out after 30 s with one retry, and the step stops at 10 packages, 90 s
or 150 MB of downloads, leaving the rules' verdict for the rest.

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
