import { describe, expect, it } from "vitest";
import {
  type Check,
  type CheckResult,
  hookDecide,
  hookPlan,
  planLines,
  runHook,
} from "./hook.ts";

const event = (command: string, cwd = "/repo", tool = "Bash") =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    cwd,
    tool_input: { command },
  });
const fs = (paths: string[], files: Record<string, string> = {}) => ({
  readFile: (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  },
  exists: (path: string) => paths.includes(path) || path in files,
  home: "/home/u",
});
const project = fs(["/repo"], { "/repo/package.json": "{}" });
const modes = (command: string, deps = project) =>
  hookPlan(event(command), deps).checks.map(
    (c) => `${c.mode} ${c.dir} [${c.packages.join(" ")}]`,
  );

describe("hookPlan", () => {
  it("turns install intents into croak-install checks", () => {
    expect(
      modes("npm i zod && npm ci && npx cowsay hi && npm i -g pnpm"),
    ).toEqual([
      "project /repo [zod]",
      "ci /repo []",
      "empty /repo [cowsay]",
      "empty /repo [pnpm]",
    ]);
  });

  it("ignores other tools and commands that install nothing", () => {
    expect(hookPlan(event("npm i zod", "/repo", "Read"), project)).toEqual({
      intents: [],
      checks: [],
    });
    expect(hookPlan(event("npm test"), project).checks).toEqual([]);
  });

  it("skips npx of a bin npm's prefix already has", () => {
    const deps = fs([
      "/repo",
      "/repo/package.json",
      "/repo/web",
      "/repo/node_modules/.bin/vitest",
    ]);
    expect(hookPlan(event("npx vitest run", "/repo/web"), deps).checks).toEqual(
      [],
    );
    expect(
      hookPlan(event("npx vitest@4 run", "/repo/web"), deps).checks,
    ).toHaveLength(1);
  });

  it("plans an install outside any project into an empty one", () => {
    expect(modes("npm i left-pad", fs(["/repo"]))).toEqual([
      "empty /repo [left-pad]",
    ]);
    expect(modes("npm install", fs(["/repo"]))).toEqual([]);
  });

  it("refuses what it cannot hand to the shell safely or check yet", () => {
    const plan = hookPlan(event("mkdir app && cd app && npm i zod"), project);
    expect(plan.checks).toEqual([]);
    expect(plan.intents).toEqual([
      expect.objectContaining({
        kind: "unchecked",
        reason: expect.stringContaining("does not exist yet"),
      }),
    ]);
    expect(hookPlan(event("npm i 'a\tb'"), project).intents[0]).toMatchObject({
      kind: "unchecked",
    });
  });

  it("writes one tab-separated line per check", () => {
    expect(planLines(hookPlan(event("npm i zod chalk"), project))).toBe(
      "check\t1\tnpm\tproject\t/repo\tzod\tchalk\n",
    );
  });
});

describe("hookPlan: where npm really installs (M4 review)", () => {
  const files = (extra: Record<string, string> = {}) =>
    fs(["/repo", "/repo/src", "/repo/packages/a"], {
      "/repo/package.json": '{"name":"repo"}',
      ...extra,
    });

  it("checks npm's prefix, not the directory the agent is in", () => {
    expect(modes("cd src && npm install", files())).toEqual([
      "project /repo []",
    ]);
    expect(modes("cd src && npm install evil", files())).toEqual([
      "project /repo [evil]",
    ]);
  });

  it("checks npm update as an update", () => {
    expect(modes("npm update debug", files())).toEqual([
      "update /repo [debug]",
    ]);
  });

  it.each([
    [
      "a shrinkwrap",
      { "/repo/npm-shrinkwrap.json": "{}" },
      "npm install",
      "npm-shrinkwrap.json",
    ],
    [
      "a project .npmrc registry",
      { "/repo/.npmrc": "registry=https://attacker.invalid/" },
      "npm i evil",
      "registry croak does not check",
    ],
    [
      "a scoped registry in ~/.npmrc",
      { "/home/u/.npmrc": "@corp:registry=https://npm.corp.invalid/" },
      "npx cowsay",
      "registry croak does not check",
    ],
  ])("denies an install with %s (D34)", (_name, extra, command, reason) => {
    const plan = hookPlan(event(command), files(extra));
    expect(plan.checks).toEqual([]);
    expect(plan.intents).toEqual([
      expect.objectContaining({
        kind: "unchecked",
        reason: expect.stringContaining(reason),
      }),
    ]);
  });

  it.each([
    ["a quoted registry key", '"registry"=https://attacker.invalid/'],
    ["a userconfig pointing elsewhere", "userconfig=./other.npmrc"],
    ["an ini section", "[registry]\nx=1"],
    ["a script-shell", "script-shell=./run.sh"],
    ["node-options", "node-options=--require ./preload.js"],
  ])(
    "denies a project .npmrc with %s (whole-project review)",
    (_name, npmrc) => {
      const plan = hookPlan(
        event("npm i zod"),
        files({ "/repo/.npmrc": npmrc }),
      );
      expect(plan.checks).toEqual([]);
      expect(plan.intents[0]).toMatchObject({ kind: "unchecked" });
    },
  );

  it("does not hold the user's own node-options against them", () => {
    expect(
      modes(
        "npm i zod",
        files({ "/home/u/.npmrc": "node-options=--max-old-space-size=8192" }),
      ),
    ).toEqual(["project /repo [zod]"]);
  });

  it("hands a workspace member's install to croak-install where npm stands (D38, M6 review)", () => {
    // croak-install finds the root and checks the folder is a member.
    const npmWs = files({
      "/repo/package.json": '{"name":"repo","workspaces":["packages/*"]}',
      "/repo/packages/a/package.json": '{"name":"a"}',
    });
    expect(modes("cd packages/a && npm install zod", npmWs)).toEqual([
      "project /repo/packages/a [zod]",
    ]);
    const pnpmWs = files({
      "/repo/pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "/repo/packages/a/package.json": '{"name":"a"}',
    });
    expect(modes("cd packages/a && pnpm add zod", pnpmWs)).toEqual([
      "project /repo/packages/a [zod]",
    ]);
    expect(
      hookPlan(event("cd packages/a && pnpm add zod"), pnpmWs).checks[0]
        ?.manager,
    ).toBe("pnpm");
  });

  it("denies a pnpm install when pnpm-workspace.yaml points at another registry", () => {
    const plan = hookPlan(
      event("pnpm add zod"),
      files({
        "/repo/pnpm-workspace.yaml": "registry: https://attacker.invalid/\n",
      }),
    );
    expect(plan.checks).toEqual([]);
    expect(plan.intents[0]).toMatchObject({
      kind: "unchecked",
      reason: expect.stringContaining("registry croak does not check"),
    });
  });

  it("accepts the public registry and npm's own userconfig variable", () => {
    const deps = {
      ...files({
        "/home/u/.npmrc":
          "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=x",
        "/cfg/npmrc": "fund=false",
      }),
      env: {
        npm_config_userconfig: "/cfg/npmrc",
        npm_config_registry: "https://registry.npmjs.org/",
      },
    };
    expect(modes("npm i zod", deps)).toEqual(["project /repo [zod]"]);
    const foreign = {
      ...deps,
      env: { NPM_CONFIG_REGISTRY: "https://attacker.invalid/" },
    };
    expect(hookPlan(event("npm i zod"), foreign).intents[0]).toMatchObject({
      kind: "unchecked",
    });
  });
});

const check: Check = {
  id: 1,
  manager: "npm",
  mode: "project",
  dir: "/repo",
  packages: ["x"],
  label: "npm install x in /repo",
};
const report = (verdict: string, findings: object[] = []) =>
  JSON.stringify({
    kind: "install-plan",
    status: "complete",
    verdict,
    findings,
  });
const result = (
  code: number | undefined,
  stdout = "",
  stderr = "",
): CheckResult => ({ check, code, stdout, stderr });

describe("hookDecide", () => {
  it("stays silent when everything is allowed: it never grants a permission", () => {
    expect(hookDecide([], [result(0, report("allow"))])).toBeUndefined();
    expect(hookDecide([], [])).toBeUndefined();
  });

  it("asks on a warning and shows the findings", () => {
    const out = hookDecide(
      [],
      [
        result(
          0,
          report("warn", [
            {
              severity: "warn",
              file: "x@1.0.0",
              ruleId: "install/install-script",
              message: "runs code at install time",
            },
          ]),
        ),
      ],
    );
    expect(out?.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(
      "🟡 x@1.0.0 install/install-script",
    );
  });

  it.each([
    [
      "a block",
      result(
        1,
        report("block", [
          {
            severity: "block",
            file: "x@1.0.0",
            ruleId: "install/name",
            message: "looks like y",
          },
        ]),
      ),
      "🔴 x@1.0.0 install/name",
    ],
    [
      "a missing package",
      result(
        2,
        "",
        "croak-install: a requested package does not exist on npm. Check the name:\nnpm error 404 Not Found\nnpm error 404\n  x: did you mean `y`?",
      ),
      "does not exist on npm. Check the name: x: did you mean `y`?",
    ],
    [
      "an incomplete check",
      result(
        3,
        JSON.stringify({
          status: "incomplete",
          reason: "npm registry: timeout",
        }),
      ),
      "incomplete: npm registry: timeout",
    ],
    ["a check that never ran", result(undefined), "could not run"],
    ["unreadable output", result(0, "not json", "boom"), "did not finish"],
  ])(
    "denies %s and tells the agent not to work around it",
    (_name, r, text) => {
      const reason = hookDecide([], [r])?.hookSpecificOutput;
      expect(reason?.permissionDecision).toBe("deny");
      expect(reason?.permissionDecisionReason).toContain(text);
      expect(reason?.permissionDecisionReason).toContain(
        "Do not work around this check",
      );
    },
  );

  it("denies unchecked intents even when every check passed", () => {
    const out = hookDecide(
      [
        {
          kind: "unchecked",
          command: "pnpm add zod",
          reason: "croak checks npm only",
        },
      ],
      [result(0, report("allow"))],
    );
    expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("runHook", () => {
  it("plans from the input file and decides from the work directory", () => {
    const deps = fs(["/repo"], {
      "/repo/package.json": "{}",
      "/w/input.json": event("npm i x"),
    });
    const planned = runHook(["plan", "/w/input.json"], deps).stdout;
    expect(planned.split("\n")[1]).toBe("check\t1\tnpm\tproject\t/repo\tx");
    const files = {
      "/w/plan": planned,
      "/w/1.code": "1\n",
      "/w/1.out": report("block", [
        { severity: "block", file: "x@1", ruleId: "r", message: "m" },
      ]),
    };
    const decided = JSON.parse(runHook(["decide", "/w"], fs([], files)).stdout);
    expect(decided.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("reports bad input as a usage error the shell turns into deny", () => {
    expect(
      runHook(["plan", "/w/in"], fs([], { "/w/in": "not json" })),
    ).toMatchObject({ code: 2, stderr: expect.stringContaining("not JSON") });
    expect(runHook([], project).code).toBe(2);
  });
});
