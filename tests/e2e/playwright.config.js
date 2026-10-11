// Run with `npm test` from tests/e2e after `cargo build` (see README).
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "specs",
  fullyParallel: true,
  // Every test starts its own server and repositories, so tests never share state.
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 860 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
