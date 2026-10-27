// SYNTHETIC croak eval fixture: downloads the prebuilt binary for this platform.
const https = require("https");
const { execFileSync } = require("child_process");
https.get("https://cdn.example.invalid/bin/" + process.platform, (res) => res.on("end", () => execFileSync("./bin", ["--version"])));
