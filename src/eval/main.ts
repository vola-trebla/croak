import { join } from "node:path";
import { parseArgs } from "node:util";
import { CaseError, loadCases } from "./case.ts";
import {
  loadCommandCases,
  renderCommandEval,
  runCommandEval,
} from "./commands.ts";
import { renderReport } from "./render.ts";
import { runEval } from "./run.ts";

const { values } = parseArgs({
  options: {
    plain: { type: "boolean" },
    json: { type: "boolean" },
    cases: { type: "string" },
  },
  strict: true,
});

const casesDir = values.cases ?? join(import.meta.dirname, "../../eval/cases");

try {
  const report = await runEval(loadCases(casesDir));
  const commands = runCommandEval(
    loadCommandCases(join(casesDir, "../agent-commands.json")),
  );
  if (values.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ...report, commands }, null, 2)}\n`,
    );
  } else {
    const emoji = values.plain !== true && process.stdout.isTTY === true;
    process.stdout.write(renderReport(report, { emoji }));
    process.stdout.write(renderCommandEval(commands));
  }
} catch (error) {
  // A broken case is a bug in the eval itself: fail loudly, never score around it.
  if (!(error instanceof CaseError)) throw error;
  process.stderr.write(`croak eval: invalid case ${error.message}\n`);
  process.exitCode = 1;
}
