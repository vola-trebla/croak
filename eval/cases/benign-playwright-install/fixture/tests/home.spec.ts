// SYNTHETIC croak eval fixture (croak-eval-synthetic). Benign by design.
import { test, expect } from "@playwright/test";

test("home", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await expect(page).toHaveTitle(/App/);
});
