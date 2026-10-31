import {
  checkRegistrySignature,
  NPM_REGISTRY_KEYS,
  type RegistryKey,
} from "../crypto/registry-signature.ts";
import type { Finding, Severity } from "../verdict.ts";
import type { PlanChange } from "./plan.ts";
import type { VersionFacts } from "./registry.ts";

const sha512Of = (integrity: string | undefined): string | undefined =>
  integrity
    ?.trim()
    .split(/\s+/)
    .find((hash) => hash.startsWith("sha512-"));

/**
 * The registry's signature over this version (M7, D42). Broken blocks: a
 * known key's signature that does not verify, or a lockfile hash that is not
 * the one the registry signed. Missing or unverifiable warns: npm signs every
 * version, but a key rotation croak missed must not block every install.
 */
export function signatureFindings(
  change: PlanChange,
  facts: VersionFacts,
  keys: readonly RegistryKey[] = NPM_REGISTRY_KEYS,
): Finding[] {
  const { entry } = change;
  const version = entry.version ?? "";
  const finding = (severity: Severity, message: string): Finding => ({
    ruleId: "install/signature",
    severity,
    file: `${entry.name}@${version}`,
    message,
  });
  if (facts.integrity === undefined)
    return [
      finding(
        "warn",
        "has no integrity hash in the registry, so there is no registry signature to check",
      ),
    ];
  const check = checkRegistrySignature(
    {
      name: entry.name,
      version,
      integrity: facts.integrity,
      signatures: facts.signatures,
      published: facts.published,
    },
    keys,
  );
  switch (check.status) {
    case "invalid":
      return [
        finding(
          "block",
          `has a registry signature that does not verify (${check.reason}): the package document was altered after npm signed it`,
        ),
      ];
    case "unsigned":
      return [
        finding(
          "warn",
          "has no registry signature, although registry.npmjs.org signs every version",
        ),
      ];
    case "unverifiable":
      return [
        finding(
          "warn",
          `has a registry signature croak cannot check: ${check.reason}`,
        ),
      ];
    case "valid": {
      const locked = sha512Of(entry.integrity);
      const signed = sha512Of(facts.integrity);
      if (locked === undefined)
        // No hash at all is install/integrity's finding.
        return entry.integrity === undefined
          ? []
          : [
              finding(
                "info",
                "is locked with only a sha1 hash, which croak did not compare with the sha512 the registry signed",
              ),
            ];
      return signed !== undefined && locked !== signed
        ? [
            finding(
              "block",
              "is locked to a tarball hash that is not the one the registry signed: the lockfile points at a different tarball",
            ),
          ]
        : [];
    }
  }
}
