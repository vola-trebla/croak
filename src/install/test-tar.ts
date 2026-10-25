import { gzipSync } from "node:zlib";

/** A minimal ustar writer for tests (in memory). */
export function header(
  name: string,
  size: number,
  type = "0",
  extra: { prefix?: string; linkname?: string } = {},
): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  if (extra.linkname !== undefined) h.write(extra.linkname, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  if (extra.prefix !== undefined) h.write(extra.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
export const pad = (data: Buffer): Buffer =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
export function tar(
  files: Array<{
    name: string;
    content?: string;
    type?: string;
    prefix?: string;
    linkname?: string;
  }>,
): Buffer {
  const parts = files.flatMap((f) => {
    const data = Buffer.from(f.content ?? "");
    const extra = {
      ...(f.prefix === undefined ? {} : { prefix: f.prefix }),
      ...(f.linkname === undefined ? {} : { linkname: f.linkname }),
    };
    return [
      header(
        f.name,
        f.type === "5" || f.type === "2" ? 0 : data.length,
        f.type ?? "0",
        extra,
      ),
      pad(data),
    ];
  });
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
export const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
  return `${len}${body}`;
};
