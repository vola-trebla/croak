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

  it("reads like npm: pax size, old GNU and pax types, ./ paths", () => {
    const payload = "/* payload */ x();";
    const raw = Buffer.concat([
      // A pax size overrides the header size, as in node-tar.
      header("PaxHeader", Buffer.byteLength(paxRecord("size", "18")), "x"),
      pad(Buffer.from(paxRecord("size", "18"))),
      header("package/install.js", 0),
      pad(Buffer.from(payload)),
      // "N" is an old GNU long name, "X" an old pax header.
      header("././@LongLink", 18, "N"),
      pad(Buffer.from("package/hidden.js\0")),
      header("package/README.txt", 1),
      pad(Buffer.from("h")),
      header(
        "X",
        Buffer.byteLength(paxRecord("path", "package/old-pax.js")),
        "X",
      ),
      pad(Buffer.from(paxRecord("path", "package/old-pax.js"))),
      header("ignored", 1),
      pad(Buffer.from("p")),
      header("package/./package.json", 2),
      pad(Buffer.from("{}")),
      Buffer.alloc(1024),
    ]);
    const snap = snapshotTarball(gzipSync(raw));
    expect(snap.entries.map((e) => e.path)).toEqual([
      "hidden.js",
      "install.js",
      "old-pax.js",
      "package.json",
    ]);
    expect(snap.read("install.js")).toBe(payload);
  });

  it("ignores the name prefix of a non-ustar header, as npm does", () => {
    const block = header("package.json", 2, "0", { prefix: "package" });
    block.write("\0\0\0\0\0\0\0\0", 257, "latin1"); // no ustar magic
    let sum = 0;
    block.write("        ", 148);
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const snap = snapshotTarball(
      gzipSync(
        Buffer.concat([block, pad(Buffer.from("{}")), Buffer.alloc(1024)]),
      ),
    );
    // Without the prefix the name is "package.json" itself, and npm strips it as the top directory.
    expect(snap.entries).toEqual([]);
  });

  it("records links but never reads through them", () => {
    const snap = snapshotTarball(
      tar([{ name: "package/link", type: "2", linkname: "/etc/passwd" }]),
    );
    expect(snap.entries).toEqual([{ path: "link", kind: "symlink", size: 0 }]);
    expect(snap.read("link")).toBeUndefined();
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
      "a traversal path",
      () =>
        snapshotTarball(tar([{ name: "package/../../evil.js", content: "x" }])),
      /escapes/,
    ],
    [
      // npm reads past a single zero block; croak must not stop there and miss the payload.
      "a zero block hiding a later copy",
      () =>
        snapshotTarball(
          gzipSync(
            Buffer.concat([
              header("package/index.js", 2),
              pad(Buffer.from("ok")),
              Buffer.alloc(512),
              header("package/index.js", 3),
              pad(Buffer.from("bad")),
              Buffer.alloc(1024),
            ]),
          ),
        ),
      /zero block/,
    ],
    [
      "the same path twice",
      () =>
        snapshotTarball(
          tar([
            { name: "package/index.js", content: "ok" },
            { name: "package/index.js", content: "bad" },
          ]),
        ),
      /twice/,
    ],
    [
      "an unknown entry type",
      () => snapshotTarball(tar([{ name: "package/a.js", type: "S" }])),
      /unknown entry type/,
    ],
    [
      "a global pax header that sets a path",
      () =>
        snapshotTarball(
          tar([
            {
              name: "g",
              type: "g",
              content: paxRecord("path", "package/x.js"),
            },
            { name: "package/a.js", content: "a" },
          ]),
        ),
      /global pax/,
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
