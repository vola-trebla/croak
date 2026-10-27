import { describe, expect, it } from "vitest";
import { parseYamlDocuments, YamlError } from "./yaml.ts";

const one = (text: string) => parseYamlDocuments(text)[0];

describe("parseYamlDocuments", () => {
  it("reads the YAML pnpm writes: nested mappings, quoted keys, flow collections", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  '@esbuild/darwin-arm64@0.28.2':",
      "    resolution: {integrity: sha512-abc==}",
      "    engines: {node: '>=18'}",
      "    cpu: [arm64]",
      "    os: [darwin]",
      "",
      "  esbuild@0.28.2:",
      "    hasBin: true",
    ].join("\n");
    expect(one(text)).toEqual({
      lockfileVersion: "9.0",
      packages: {
        "@esbuild/darwin-arm64@0.28.2": {
          resolution: { integrity: "sha512-abc==" },
          engines: { node: ">=18" },
          cpu: ["arm64"],
          os: ["darwin"],
        },
        "esbuild@0.28.2": { hasBin: "true" },
      },
    });
  });

  it("reads scalar block sequences and empty mappings", () => {
    expect(one("a:\n  deps:\n    - msw\n    - react\n  b: {}\n")).toEqual({
      a: { deps: ["msw", "react"], b: {} },
    });
  });

  it("joins flow collections a formatter spread over lines, also on the line after the key", () => {
    const text =
      'packages:\n  "x@1.0.0":\n    resolution:\n      {\n        integrity: sha512-x==,\n      }\n    cpu: [\n      arm64,\n    ]\n';
    expect(one(text)).toEqual({
      packages: {
        "x@1.0.0": { resolution: { integrity: "sha512-x==" }, cpu: ["arm64"] },
      },
    });
  });

  it("splits documents at ---", () => {
    expect(parseYamlDocuments("---\na: 1\n---\nb: 2\n")).toEqual([
      { a: "1" },
      { b: "2" },
    ]);
  });

  it.each([
    ["an anchor", "a: &x 1"],
    ["an alias", "a: *x"],
    ["a tag", "a: !!str 1"],
    ["a block scalar", "a: |"],
    ["a tab", "a:\n\tb: 1"],
    ["a duplicate key", "a: 1\na: 2"],
    ["inconsistent indentation", "a:\n    b: 1\n  c: 2"],
    ["a nested block sequence", "a:\n  - b: 1"],
    ["an unterminated flow collection", "a: {b: 1"],
    ["an unterminated quote", "a: 'b"],
    ["a line that is not key: value", "a:\n  just text"],
    ["a flow collection without a key", "{a: 1}"],
  ])("refuses %s rather than guess", (_name, text) => {
    expect(() => parseYamlDocuments(text)).toThrow(YamlError);
  });

  it("caps size, depth and keys", () => {
    expect(() => parseYamlDocuments("a: 1", { maxBytes: 2 })).toThrow(
      /larger than/,
    );
    expect(() =>
      parseYamlDocuments("a:\n b:\n  c:\n   d: 1", { maxDepth: 2 }),
    ).toThrow(/deeply/);
    expect(() =>
      parseYamlDocuments("a: 1\nb: 2\nc: 3", { maxKeys: 2 }),
    ).toThrow(/keys/);
  });
});
