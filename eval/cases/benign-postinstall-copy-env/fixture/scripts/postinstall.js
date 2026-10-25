// SYNTHETIC croak eval fixture (croak-eval-synthetic). Benign by design.
const { copyFileSync, existsSync } = require("node:fs");

if (!existsSync(".env")) copyFileSync(".env.example", ".env");
