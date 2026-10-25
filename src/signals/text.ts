/** npm, VS Code, and most JSON readers ignore a leading UTF-8 byte-order mark. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
