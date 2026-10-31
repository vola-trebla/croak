import type { BuildIdentity } from "../crypto/der.ts";
import type { ProvenanceCheck } from "../crypto/sigstore.ts";
import type { Finding, Severity } from "../verdict.ts";
import type { PlanChange } from "./plan.ts";

/** A version's install scripts, one `name: command` per line ("" for none). */
export interface InstallCommands {
  readonly current: string;
  readonly previous: string;
}

/** A provenance bundle checked, or "missing" when the registry served none. */
export type Provenance = ProvenanceCheck | "missing";

/**
 * The workflow file a build started from, inside its repo and without its
 * ref: tags change every release, and a renamed repo renames the URI.
 */
function workflowOf(identity: BuildIdentity): string | undefined {
  const uri = identity.buildConfigUri?.replace(/@[^@]*$/, "");
  const repo = `${identity.sourceRepositoryUri ?? ""}/`;
  return uri?.startsWith(repo) === true ? uri.slice(repo.length) : uri;
}

/** How this build differs from the previous version's, if it does. */
function buildChanges(now: BuildIdentity, before: BuildIdentity): string[] {
  const changes: string[] = [];
  // Repos get renamed (react now builds from github.com/react/react); the
  // numeric id survives a rename and changes when a name is re-registered.
  const otherRepo =
    now.sourceRepositoryId !== undefined &&
    before.sourceRepositoryId !== undefined
      ? now.sourceRepositoryId !== before.sourceRepositoryId
      : now.sourceRepositoryUri !== before.sourceRepositoryUri;
  if (otherRepo)
    changes.push(
      `was built from ${now.sourceRepositoryUri ?? "an unnamed repository"}, not from ${before.sourceRepositoryUri ?? "the repository"} that built the previous version`,
    );
  else if (workflowOf(now) !== workflowOf(before))
    changes.push(
      `was built by the workflow ${workflowOf(now) ?? "(unnamed)"}, not by ${workflowOf(before) ?? "the workflow"} that built the previous version`,
    );
  return changes;
}

/**
 * Provenance signals for one planned version (M7, D42). A claim that does
 * not verify blocks; one croak cannot check warns. A build from another
 * repository or workflow than the previous version's warns, and blocks
 * with an install script that is new or changed (as in D30). Provenance
 * never lowers another finding.
 */
export function provenanceFindings(
  change: PlanChange,
  current: Provenance,
  previous: Provenance | undefined,
  scripts: InstallCommands,
): Finding[] {
  const file = `${change.entry.name}@${change.entry.version ?? "?"}`;
  const finding = (severity: Severity, message: string): Finding => ({
    ruleId: "install/provenance",
    severity,
    file,
    message,
  });
  if (current === "missing")
    return [
      finding(
        "warn",
        "is listed with provenance, but the registry served no provenance attestation to check",
      ),
    ];
  if (current.status === "invalid")
    return [
      finding(
        "block",
        `claims provenance that does not verify (${current.reason}): the attestation was forged or altered`,
      ),
    ];
  if (current.status === "unverifiable")
    return [
      finding("warn", `has provenance croak cannot check: ${current.reason}`),
    ];
  if (previous === undefined || previous === "missing") return [];
  if (previous.status !== "verified") return [];
  const newScript =
    scripts.current !== "" && scripts.current !== scripts.previous;
  return buildChanges(current.identity, previous.identity).map((what) =>
    newScript
      ? finding(
          "block",
          `${what}, and adds or changes an install script: the pattern of a hijacked release`,
        )
      : finding("warn", what),
  );
}
