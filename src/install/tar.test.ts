import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { snapshotTarball, TarballError } from "./tar.ts";
import { header, pad, paxRecord, tar } from "./test-tar.ts";

describe("snapshotTarball", () => {
  it("lists files without the top-level directory and reads them", () => {
    const snap = snapshotTarball(
      tar([
        { name: "package/package.json", content: '{"name":"x"}' },
        { name: "package/lib", type: "5" },
        { name: "package/lib/index.js", content: "module.exports = 1;" },
      ]),
    );
    expect(snap.entries.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "file:lib/index.js",
      "file:package.json",
    ]);
    expect(snap.read("package.json")).toBe('{"name":"x"}');
  });

  it("joins the ustar prefix, honors pax paths and GNU long names", () => {
    const longName = `${"d/".repeat(60)}deep.js`;
    const snap = snapshotTarball(
      tar([
        { name: "lib/a.js", prefix: "package", content: "a" },
        {
          name: "PaxHeader",
          type: "x",
          content: paxRecord("path", `package/${longName}`),
        },
        { name: "short-name.js", content: "b" },
        {
          name: "././@LongLink",
          type: "L",
          content: `package/gnu-${"x".repeat(120)}.js\0`,
        },
        { name: "truncated", content: "c" },
      ]),
    );
    expect(snap.entries.map((e) => e.path)).toEqual([
      longName,
      `gnu-${"x".repeat(120)}.js`,
      "lib/a.js",
    ]);
  });

  it("records links but never reads through them", () => {
    const snap = snapshotTarball(
      tar([{ name: "package/link", type: "2", linkname: "/etc/passwd" }]),
    );
    expect(snap.entries).toEqual([{ path: "link", kind: "symlink", size: 0 }]);
    expect(snap.read("link")).toBeUndefined();
  });

  it("keeps traversal paths as plain names (nothing is written to disk)", () => {
    const snap = snapshotTarball(
      tar([{ name: "package/../../evil.js", content: "x" }]),
    );
    expect(snap.entries.map((e) => e.path)).toEqual(["../../evil.js"]);
  });

  it("marks files over the read limit as oversized", () => {
    const snap = snapshotTarball(
      tar([{ name: "package/big.js", content: "x".repeat(2000) }]),
      { maxFileBytes: 1000 },
    );
    expect(snap.entries[0]).toMatchObject({ kind: "oversized", size: 2000 });
    expect(snap.read("big.js")).toBeUndefined();
  });

  it.each([
    [
      "too many entries",
      () =>
        snapshotTarball(tar([{ name: "a" }, { name: "b" }, { name: "c" }]), {
          maxEntries: 2,
        }),
      /entries/,
    ],
    [
      "unpacked size over the limit (decompression bomb)",
      () =>
        snapshotTarball(gzipSync(Buffer.alloc(5_000_000)), {
          maxUnpackedBytes: 1_000_000,
        }),
      /unpacked/,
    ],
    ["not gzip", () => snapshotTarball(Buffer.from("plain text")), /gzip/],
    [
      "a corrupted header checksum",
      () => {
        const raw = Buffer.concat([
          header("package/a.js", 1),
          pad(Buffer.from("a")),
          Buffer.alloc(1024),
        ]);
        raw[0] = "z".charCodeAt(0);
        return snapshotTarball(gzipSync(raw));
      },
      /checksum/,
    ],
    [
      "a file running past the end",
      () => snapshotTarball(gzipSync(header("package/a.js", 4096))),
      /truncated/,
    ],
  ])("rejects %s", (_name, run, message) => {
    expect(run).toThrow(TarballError);
    expect(run).toThrow(message);
  });
});
