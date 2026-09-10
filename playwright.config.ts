import { defineConfig, devices } from "@playwright/test";

const CROSS_BROWSER_SPECS = ["e2e/accessibility.spec.ts", "e2e/browsers.spec.ts"];

export default defineConfig({
  testDir: "./tests",
  testMatch: ["e2e/**/*.spec.ts", "visual/**/*.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Firefox and WebKit only carry the T093 cross-browser acceptance specs. Running
    // every suite three times would triple the real cloud logins those specs perform.
    {
      name: "firefox",
      testMatch: CROSS_BROWSER_SPECS,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testMatch: CROSS_BROWSER_SPECS,
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
