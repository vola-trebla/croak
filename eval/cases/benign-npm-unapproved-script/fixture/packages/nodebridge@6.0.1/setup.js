// SYNTHETIC croak eval fixture: downloads a binary and runs it, like esbuild.
const https = require("https");
const { execFileSync } = require("child_process");
https.get("https://registry.npmjs.org/-/bin.tgz", (res) => res.on("end", () => execFileSync("./bin", ["--version"])));
