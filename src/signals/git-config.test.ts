import { describe, expect, it } from "vitest";
import { parseGitConfig } from "./git-config.ts";

describe("parseGitConfig", () => {
  it("reads sections, subsections, keys, and line numbers", () => {
    const text = `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "echo hi"\n[remote "origin"]\n\turl = https://x.invalid/r.git\n`;
    expect(parseGitConfig(text)).toEqual([
      { section: "core", key: "repositoryformatversion", value: "0", line: 2 },
      { section: "core", key: "fsmonitor", value: "echo hi", line: 3 },
      {
        section: "remote.origin",
        key: "url",
        value: "https://x.invalid/r.git",
        line: 5,
      },
    ]);
  });

  it("lowercases section and key names but keeps subsection case and values", () => {
    expect(
      parseGitConfig(`[Filter "LFS"]\n  Clean = git-lfs clean -- %f`),
    ).toEqual([
      {
        section: "filter.LFS",
        key: "clean",
        value: "git-lfs clean -- %f",
        line: 2,
      },
    ]);
  });

  it("accepts the legacy [section.sub] form and a key on the header line", () => {
    expect(parseGitConfig(`[submodule.lib] update = !sh x.sh`)).toEqual([
      { section: "submodule.lib", key: "update", value: "!sh x.sh", line: 1 },
    ]);
  });

  it("strips comments outside quotes and unescapes quoted values", () => {
    const text = `# comment\n; another\n[core]\n  pager = less # trailing\n  editor = "vim \\"-u\\" x ; y"\n`;
    expect(parseGitConfig(text).map((e) => e.value)).toEqual([
      "less",
      'vim "-u" x ; y',
    ]);
  });

  it("treats a bare key as true and ignores garbage lines", () => {
    expect(parseGitConfig(`[core]\n  bare\n  ???\n`)).toEqual([
      { section: "core", key: "bare", value: "true", line: 2 },
    ]);
  });
});
