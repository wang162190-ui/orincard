import { expect, test, type Page } from "@playwright/test";

// T093 浏览器兼容验收。
// playwright.config.ts 把 firefox 与 webkit 两个 project 的 testMatch 精确挂在
// e2e/accessibility.spec.ts 与 e2e/browsers.spec.ts 上，所以跨浏览器的证据只有写在这两个文件里
// 才会真的在三个引擎上跑。用例一律按 testInfo.project.name 取当前引擎，不硬编码单一浏览器。
//
// 桌面核心流走的是不花供应商预算的那一段：营销首页 → 创建表单准备就绪 → 本地草稿编辑器 →
// 重载后本地持久化 → 导出入口。真实生成与真实导出要 AI 与 Trigger 预算，由协调线在串行的
// 云端验收里跑，这里不点 "Generate carousel"，也就不会把一次跨浏览器矩阵变成三次真实付费调用。

// 本文件底部的登录用例会在页面上填真实开发账号的口令，trace 与失败截图会把那一帧连同请求一起
// 存进 test-results/。Playwright 不允许把 use() 收窄到 describe（会强制新 worker），所以整个文件
// 关掉这两项，让凭据没有落盘的路径。不含凭据的 accessibility.spec.ts 仍用配置里的默认值。
test.use({ screenshot: "off", trace: "off" });

const ENGINES = {
  chromium: { present: /Chrome\/\d+/, absent: /Firefox\/\d+/ },
  firefox: { present: /Firefox\/\d+/, absent: /Chrome\/\d+/ },
  webkit: { present: /Safari\/\d+/, absent: /Chrome\/\d+/ },
} as const;

type EngineName = keyof typeof ENGINES;

function engineOf(name: string): EngineName {
  if (name in ENGINES) {
    return name as EngineName;
  }
  throw new Error(
    `Playwright project "${name}" is not one of the three engines this acceptance covers: ` +
      `${Object.keys(ENGINES).join(", ")}.`,
  );
}

async function openLocalDraft(page: Page, draftId: string) {
  await page.goto(`/editor/${draftId}`);
  await expect(page.getByRole("heading", { name: "Edit your carousel." })).toBeVisible();
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
}

test("the matrix really runs on three engines, and each project is the engine it names", async ({
  page,
}, testInfo) => {
  // Guards the whole T093 matrix against silently collapsing onto chromium: if the firefox or
  // webkit project ever disappears from the config, or a project is wired to the wrong device,
  // the acceptance fails instead of reporting three passes from one engine.
  const configured = testInfo.config.projects.map((project) => project.name);
  for (const required of Object.keys(ENGINES)) {
    expect(configured, `Playwright has no "${required}" project`).toContain(required);
  }

  const engine = engineOf(testInfo.project.name);
  await page.goto("/");
  const userAgent = await page.evaluate(() => navigator.userAgent);
  expect(userAgent, `${engine} reported a foreign user agent`).toMatch(ENGINES[engine].present);
  expect(userAgent, `${engine} reported a foreign user agent`).not.toMatch(ENGINES[engine].absent);
});

test("the desktop core flow reaches the editor and keeps the draft across a reload", async ({
  page,
}, testInfo) => {
  const engine = engineOf(testInfo.project.name);
  const draftId = `local-browsers-core-${engine}`;
  const headline = `Cross-browser edit ${engine}`;

  await page.goto("/");
  await page.getByRole("link", { name: "Create your first carousel" }).click();
  await expect(page).toHaveURL(/\/create$/);

  await page.getByLabel("Topic", { exact: true }).fill("A calm weekly planning ritual");
  // 按可访问名定位：<label> 包住了 <select>，label 纯文本连着选项文字，getByLabel 精确匹配对不上。
  await page.getByRole("combobox", { name: "Platform", exact: true }).selectOption("instagram");
  await page.getByLabel("Number of slides", { exact: true }).fill("4");
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Use short, practical sentences.");
  // Ready, not submitted: the generate call itself is a paid provider call.
  await expect(page.getByRole("button", { name: "Generate carousel" })).toBeEnabled();

  await openLocalDraft(page, draftId);
  await page.getByRole("button", { name: "Slide 2: Lead with the conclusion" }).click();
  await page.getByRole("textbox", { name: "Headline", exact: true }).fill(headline);
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  await expect(page.locator("[data-editor-slide-id]")).toHaveCount(6);

  await page.reload();
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  await expect(page.getByRole("button", { name: `Slide 2: ${headline}` })).toBeVisible();

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", {
    name: "Workspace",
  }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/exports");
  await expect(page.getByRole("heading", { level: 1, name: "Exports" })).toBeVisible();
});

test("a narrow viewport stacks the editor and never needs a sideways scroll", async ({
  page,
}, testInfo) => {
  const engine = engineOf(testInfo.project.name);
  await openLocalDraft(page, `local-browsers-narrow-${engine}`);

  const canvas = page.getByRole("region", { name: "Canvas" });
  const content = page.getByRole("region", { name: "Slide content" });

  await page.setViewportSize({ width: 1280, height: 900 });
  const wideCanvas = await canvas.boundingBox();
  const wideContent = await content.boundingBox();
  expect(wideCanvas, "the canvas has no box on a desktop viewport").not.toBeNull();
  expect(wideContent, "the content panel has no box on a desktop viewport").not.toBeNull();
  // Three columns: the content panel sits to the left of the canvas on the same row.
  expect(wideContent!.x).toBeLessThan(wideCanvas!.x);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowCanvas = await canvas.boundingBox();
  const narrowContent = await content.boundingBox();
  expect(narrowCanvas, "the canvas has no box on a narrow viewport").not.toBeNull();
  expect(narrowContent, "the content panel has no box on a narrow viewport").not.toBeNull();
  // One column below 1000px, with the canvas moved above the content panel.
  expect(narrowCanvas!.y).toBeLessThan(narrowContent!.y);
  expect(narrowCanvas!.width).toBeLessThanOrEqual(390);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${engine} needs a sideways scroll at 390px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);

  // The filmstrip is the one strip that is allowed to scroll, and it scrolls on its own.
  const filmstrip = page.getByRole("list", { name: "Slides" });
  await expect(filmstrip).toBeVisible();
  const filmstripOverflowX = await filmstrip.evaluate(
    (element) => getComputedStyle(element).overflowX,
  );
  expect(filmstripOverflowX).toBe("auto");

  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Slide 3: Give every page one job" }).click();
  await expect(
    page.getByRole("textbox", { name: "Headline", exact: true }),
  ).toHaveValue("Give every page one job");
});

test("local draft storage and the blob download path exist in this engine", async ({
  page,
}, testInfo) => {
  const engine = engineOf(testInfo.project.name);
  await openLocalDraft(page, `local-browsers-capabilities-${engine}`);

  // The three browser capabilities the product depends on outside of plain DOM work:
  // IndexedDB carries every anonymous draft, and the export centre downloads a file by
  // creating an object URL and clicking an anchor that carries a download attribute.
  const capabilities = await page.evaluate(() => {
    const anchor = document.createElement("a");
    const url = URL.createObjectURL(new Blob(["orincard"], { type: "text/plain" }));
    URL.revokeObjectURL(url);
    return {
      indexedDb: typeof indexedDB !== "undefined",
      objectUrl: url.length > 0,
      downloadAttribute: "download" in anchor,
      structuredClone: typeof structuredClone === "function",
    };
  });
  expect(capabilities).toEqual({
    indexedDb: true,
    objectUrl: true,
    downloadAttribute: true,
    structuredClone: true,
  });

  const draftCount = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("orincard-local-drafts", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database.transaction("drafts", "readonly").objectStore("drafts").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
  expect(draftCount, `${engine} stored no local draft row`).toBeGreaterThan(0);
});

const runCloudDownload = process.env.ORINCARD_RUN_BROWSERS_E2E === "1";

test.describe("signed-in download", () => {
  test.skip(
    !runCloudDownload,
    "Set ORINCARD_RUN_BROWSERS_E2E=1 to run the real signed-in download against the development project.",
  );
  function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new Error(
        `ORINCARD_RUN_BROWSERS_E2E=1 is missing required variable: ${name}. ` +
          "Configure it in your own shell against the development project.",
      );
    }
    return value;
  }

  test("a real export downloads through the browser fallback", async ({ page }, testInfo) => {
    const engine = engineOf(testInfo.project.name);
    const email = required("ORINCARD_AUTH_TEST_EMAIL");
    const password = required("ORINCARD_AUTH_TEST_PASSWORD");
    const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    const passwordField = page.getByLabel("Password");
    await passwordField.fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await passwordField.fill("").catch(() => undefined);
    await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });

    await page.goto("/exports");
    await expect(page.getByRole("heading", { level: 1, name: "Exports" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    const readyDownloads = page.getByRole("button", { name: "Download" });
    const readyCount = await readyDownloads.count();
    if (readyCount === 0) {
      throw new Error(
        "The development account has no export in the ready state, so there is nothing real to " +
          "download. Produce one with the export acceptance first; this case never passes on an " +
          "empty history.",
      );
    }

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      readyDownloads.first().click(),
    ]);
    expect(download.suggestedFilename(), `${engine} produced a nameless download`).not.toHaveLength(
      0,
    );
    const path = await download.path();
    expect(path, `${engine} did not write the downloaded file to disk`).not.toBeNull();
    await download.delete();
  });
});
