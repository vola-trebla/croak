import { describe, expect, it } from "vitest";
import { parseLockfile } from "./lockfile.ts";
import { diffLockfiles } from "./plan.ts";

const lock = (packages: Record<string, object>) =>
  parseLockfile(
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }),
  );

describe("diffLockfiles", () => {
  const before = lock({
    "node_modules/a": { version: "1.0.0" },
    "node_modules/keep": { version: "1.0.0" },
  });

  it("reports every new package, including transitive ones, and version changes", () => {
    const after = lock({
      "node_modules/a": { version: "1.1.0" },
      "node_modules/keep": { version: "1.0.0" },
      "node_modules/new": { version: "2.0.0" },
      "node_modules/new/node_modules/deep": { version: "0.1.0" },
    });
    expect(
      diffLockfiles(before, after).map(
        (c) =>
          `${c.kind}:${c.entry.name}@${c.entry.version}${c.previousVersion ? `<-${c.previousVersion}` : ""}`,
      ),
    ).toEqual([
      "changed:a@1.1.0<-1.0.0",
      "added:new@2.0.0",
      "added:deep@0.1.0",
    ]);
  });

  it("treats everything as added when there is no previous lockfile", () => {
    expect(diffLockfiles(undefined, before).map((c) => c.kind)).toEqual([
      "added",
      "added",
    ]);
  });

  it("reports a package version once even if installed at several paths", () => {
    const after = lock({
      "node_modules/x": { version: "1.0.0" },
      "node_modules/y/node_modules/x": { version: "1.0.0" },
    });
    expect(diffLockfiles(undefined, after).map((c) => c.entry.name)).toEqual([
      "x",
    ]);
  });
});
