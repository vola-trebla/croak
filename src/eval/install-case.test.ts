import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkInstallFixture, InstallFixtureError } from "./install-case.ts";

const fixture = (id: string) =>
  join(import.meta.dirname, "../../eval/cases", id, "fixture");

describe("checkInstallFixture", () => {
  it("fills in registry URLs and integrity, so a clean package verifies", async () => {
    expect(
      await checkInstallFixture(fixture("benign-popular-package")),
    ).toMatchObject({ status: "complete", verdict: "allow" });
  });

  it("keeps an integrity the fixture states (tampered tarball)", async () => {
    const outcome = await checkInstallFixture(fixture("a-tampered-tarball"));
    expect(outcome.status === "complete" && outcome.findings).toEqual([
      expect.objectContaining({ ruleId: "install/integrity" }),
    ]);
  });

  it("diffs against before.package-lock.json when the fixture has one", async () => {
    const outcome = await checkInstallFixture(
      fixture("a-new-fresh-dependency"),
    );
    expect(outcome).toMatchObject({ status: "complete", added: 1, changed: 1 });
  });

  it("rejects a fixture without a lockfile", async () => {
    await expect(checkInstallFixture(fixture("d-postinstall"))).rejects.toThrow(
      InstallFixtureError,
    );
  });
});
