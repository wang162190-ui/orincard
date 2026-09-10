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
      use: {
        ...devices["Desktop Firefox"],
        // macOS 上 Firefox 默认只让 Tab 停在文本输入框，按钮、链接、tab 这类控件要开
        // "Full Keyboard Access" 才进 Tab 序——这是操作系统惯例，不是页面的问题。依赖键盘的用户
        // 本来就开着它。accessibility.tabfocus = 7 就是那个开关，这里显式打开，让 T093 的
        // 键盘顺序断言量的是页面的 Tab 序，而不是鼠标用户的系统默认值。
        launchOptions: { firefoxUserPrefs: { "accessibility.tabfocus": 7 } },
      },
    },
    {
      name: "webkit",
      testMatch: CROSS_BROWSER_SPECS,
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
