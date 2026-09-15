import { expect, test, type Page } from "@playwright/test";
import { authenticatedTest, runsAgainstCloud } from "./fixtures/authenticated";

/**
 * T095 全产品冒烟：每一条页面路由都真的渲染得出来。
 *
 * 在这之前，「每个页面都正常」这句话的证据是一次**手工** curl 循环
 * （`docs/handoff/product-completion.md` §5），跑完就没了，下一次回归没人拦得住。
 * 这份 spec 把那次循环变成断言，并补上它证不到的两件事：登录态、以及 404 是不是
 * 真的 404（而不是 200 + 一段 404 文案的 soft 404）。
 */

/** 与 `src/app/sitemap.ts` 和路由树一致的真实路径。slug 都是 `content/` 里实际存在的文件。 */
const ROUTES = [
  "/",
  "/pricing",
  "/login",
  "/signup",
  "/reset-password",
  "/projects",
  "/create",
  "/templates",
  "/tools",
  "/agent",
  "/billing",
  "/brand-kits",
  "/exports",
  "/settings",
  "/support",
  "/affiliate",
  "/affiliate/dashboard",
  "/help/getting-started",
  "/help/export-and-restore",
  "/help/billing-and-cancellation",
  "/guides/text-to-carousel",
  "/blog",
  "/blog/carousel-hook-first-slide",
  "/legal/privacy",
  "/legal/terms",
  "/legal/affiliate",
  "/templates/clear-idea",
  "/tools/caption",
] as const;

/** 服务端渲染崩掉时 Next 会把这些字样写进页面，比只看状态码更能抓到「200 的错误页」。 */
const FAILURE_MARKERS = [
  "Application error",
  "Internal Server Error",
  "Unhandled Runtime",
  "This page could not be rendered",
] as const;

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function assertRendersCleanly(page: Page, path: string) {
  const errors = collectConsoleErrors(page);
  const response = await page.goto(path);
  expect(response, `no response for ${path}`).not.toBeNull();
  expect(response!.status(), `status for ${path}`).toBe(200);

  const body = await page.locator("body").innerText();
  for (const marker of FAILURE_MARKERS) {
    expect(body, `${path} rendered the error boundary ("${marker}")`).not.toContain(marker);
  }
  // 每个页面都要有唯一的一级标题：缺了通常意味着外壳渲染了而内容没有。
  await expect(page.locator("h1").first(), `${path} has no h1`).toBeVisible();
  expect(errors, `console errors on ${path}`).toEqual([]);
}

test.describe("anonymous", () => {
  for (const path of ROUTES) {
    test(`renders ${path}`, async ({ page }) => {
      await assertRendersCleanly(page, path);
    });
  }

  test("renders the editor with a local draft id", async ({ page }) => {
    // 编辑器是唯一没有 h1 的页面（它的顶栏是应用外壳而不是文章标题），单独断言。
    const errors = collectConsoleErrors(page);
    const response = await page.goto("/editor/local-demo");
    expect(response!.status()).toBe(200);
    await expect(page.locator("[data-editor-slide-id]").first()).toBeVisible();
    expect(errors, "console errors in the editor").toEqual([]);
  });
});

test.describe("404s are real 404s", () => {
  // 这三条一起防住 soft 404。`loading.tsx` 曾经让整个段变成流式响应，状态码在
  // notFound() 之前就提交，于是 404 全部退化成 200——页面内容对，状态码错。
  // 详见 docs/acceptance/release.md §3。
  const notFoundPaths = ["/no-such-page", "/templates/nope", "/fr/pricing"] as const;

  for (const path of notFoundPaths) {
    test(`returns 404 with the site shell for ${path}`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response!.status(), `${path} must be a real 404, not a soft 404`).toBe(404);
      // 带站点外壳：导航在，说明落在 `[locale]/not-found.tsx` 而不是 Next 原生页。
      await expect(page.getByRole("navigation", { name: "Public navigation" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page does not exist");
    });
  }

  test("localizes the 404 page", async ({ page }) => {
    const response = await page.goto("/zh-Hans/no-such-page");
    expect(response!.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("这个页面不存在");
  });
});

authenticatedTest.describe("signed in", () => {
  authenticatedTest.skip(
    !runsAgainstCloud,
    "Set ORINCARD_RUN_FULL_PRODUCT_E2E=1 to run the signed-in sweep against a real account.",
  );
  // 这里不设 screenshot / trace：Playwright 不允许在 describe 里改这两个选项（会强制
  // 换 worker）。登录本身发生在 fixture 自己的 context 里，密码不会进这些测试的截图。
  authenticatedTest.setTimeout(3 * 60_000);

  for (const path of ROUTES) {
    authenticatedTest(`renders ${path}`, async ({ page }) => {
      await assertRendersCleanly(page, path);
    });
  }

  authenticatedTest("returns 404 for a project that does not exist", async ({ page }) => {
    // A5：以前这里是 200 + 一个空白的本地草稿外壳，看起来像「项目被清空了」。
    // id 是合法 UUID 但不属于这个账号，所以查不到。
    const response = await page.goto(`/editor/${crypto.randomUUID()}`);
    expect(response!.status(), "a missing project must 404, not render an empty shell").toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This page does not exist");
  });
});
