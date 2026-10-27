import { describe, expect, it } from "vitest";
import { workspaceRoot } from "./workspace.ts";

const fs = (files: Record<string, string>) => ({
  exists: (path: string) => path in files,
  readFile: (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  },
});

describe("workspaceRoot", () => {
  it("finds the npm root by its workspaces key, read as JSON (M6 review)", () => {
    const files = {
      "/r/package.json": '{"work\\u0073paces":["packages/*"]}',
      "/r/packages/a/package.json": '{"name":"a"}',
    };
    expect(workspaceRoot("/r/packages/a", "npm", fs(files))).toBe("/r");
    // The word in a script is not the key.
    expect(
      workspaceRoot(
        "/s",
        "npm",
        fs({
          "/s/package.json": '{"scripts":{"x":"echo \\"workspaces\\": 1"}}',
        }),
      ),
    ).toBeUndefined();
  });

  it("finds the pnpm root by pnpm-workspace.yaml, and none outside a workspace", () => {
    const files = { "/r/pnpm-workspace.yaml": "packages: []" };
    expect(workspaceRoot("/r/a/b", "pnpm", fs(files))).toBe("/r");
    expect(workspaceRoot("/r/a/b", "npm", fs(files))).toBeUndefined();
    expect(
      workspaceRoot("/x", "npm", fs({ "/x/package.json": "not json" })),
    ).toBeUndefined();
  });
});
