---

name: ship
description: Commit the current work on a properly named branch, push it, and open a GitHub pull request for the maintainer to review and merge. Use when the user says /ship, "ship it", "commit and open a PR", or when a small task is done and ready for review in the croak repo. Never merges.
---

# Ship: branch → commit → push → PR

The maintainer reviews and merges every PR on GitHub. Your job ends at an open PR.

## Steps

1. **Branch.** Run `git branch --show-current`.
   - On `main`: create a branch first — `git switch -c <type>/<milestone>-<topic>`.
     Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.
     Milestone from ROADMAP.md (`m1`, `m2`, …) when it applies, e.g. `feat/m2-repo-autorun`, `fix/cli-unknown-flag`.
   - On a feature branch: confirm it matches the task; if not, ask.
2. **Check.** Run `pnpm check`. If it fails, stop and report — do not ship red.
3. **Review what you stage.** `git status --short` and `git diff`.
   - Stage files explicitly by path. Never stage `.env*`, `eval/samples/`,
     `.claude/settings.local.json`, or anything that looks like a secret or a real malware sample.
4. **Commit.** English, imperative subject ≤ 72 chars, body explains _why_ when not obvious.
   End with the attribution line from the session instructions, if any.
   One logical change per commit; several small commits are fine.
5. **Push.** `git push -u origin <branch>`. Never force-push unless the user asks.
6. **PR.** `gh pr create --base main` with this body:

   ```markdown
   ## What
   - …

   ## Why
   - …

   ## How to verify
   - `pnpm check`
   - …

   ## Known follow-ups
   - … (or "None")
   ```

   Title: short and specific, prefixed with the milestone when it applies (`M1: …`).
   End the body with the PR attribution line from the session instructions, if any.
7. **Report.** Give the PR link and a 2–3 line summary. Then wait for the maintainer.
   Do not merge, approve, or close the PR.
