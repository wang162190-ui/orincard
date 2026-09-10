import { expect, test, type Locator, type Page } from "@playwright/test";

// T093 可访问性验收。
// 这个文件挂在 chromium / firefox / webkit 三个 Playwright project 上（见 playwright.config.ts
// 的 CROSS_BROWSER_SPECS），所以它只断言不需要凭据、不花供应商预算的路径：营销首页、工作台外壳、
// 创建表单、本地草稿编辑器和导出入口。断言全部走 getByRole / getByLabel，即读屏软件看到的那棵树，
// 不引入 axe 之类的新依赖。
//
// 键盘部分是真的按键：焦点从新导航后的 document.body 出发，靠 Tab / Shift+Tab 走到目标，
// 走不到就显式失败，不用 element.focus() 把过程绕过去。

const NARROW_LIMIT = 80;

/**
 * 反复按同一个键直到 target 拿到焦点，返回按了几下。
 * 走不到就抛错并点名目标，避免"键盘流"实际上是程序化 focus() 假装出来的。
 */
async function focusByKey(
  page: Page,
  target: Locator,
  key: "Tab" | "Shift+Tab",
  description: string,
  limit = NARROW_LIMIT,
): Promise<number> {
  for (let presses = 0; presses <= limit; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return presses;
    }
    await page.keyboard.press(key);
  }
  throw new Error(
    `${description} was not reachable with ${limit} ${key} presses; keyboard-only use is broken here.`,
  );
}

async function outlineOfFocused(page: Page): Promise<{ style: string; width: number }> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) {
      return { style: "none", width: 0 };
    }
    const computed = getComputedStyle(element);
    return {
      style: computed.outlineStyle,
      width: Number.parseFloat(computed.outlineWidth) || 0,
    };
  });
}

test("the marketing entry exposes landmarks, one first-level heading and named navigation", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Public navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Footer navigation" })).toBeVisible();

  // The brand link carries an accessible name of its own; the crane mark is aria-hidden,
  // so a screen reader never has to read a decorative polygon.
  await expect(page.getByRole("link", { name: "Orincard home" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your first carousel" })).toHaveAttribute(
    "href",
    "/create",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the workspace shell names its navigation and marks the current page", async ({ page }) => {
  await page.goto("/create");

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Workspace" })).toHaveAttribute("href", "/");
  await expect(navigation.getByRole("link", { name: "New carousel" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(navigation.getByRole("link", { name: "Workspace" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Create a carousel" })).toBeVisible();
});

test("every create control is reachable by its own label and submission stays gated", async ({
  page,
}) => {
  await page.goto("/create");

  const tabs = page.getByRole("tablist", { name: "Source type" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(6);
  await expect(page.getByRole("tab", { name: "Topic" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Text" })).toHaveAttribute("aria-selected", "false");

  await expect(page.getByRole("group", { name: "Generation options" })).toBeVisible();
  for (const label of [
    "Platform",
    "Template",
    "Language",
    "Content format",
    "Number of slides",
    "Instructions",
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }

  const generate = page.getByRole("button", { name: "Generate carousel" });
  await expect(page.getByLabel("Topic", { exact: true })).toBeVisible();
  await expect(generate).toBeDisabled();
  await page.getByLabel("Topic", { exact: true }).fill("A calm weekly planning ritual");
  await expect(generate).toBeEnabled();

  // Switching the source kind renames the field instead of leaving a nameless input behind.
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByLabel("Source text", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "URL" }).click();
  await expect(page.getByLabel("Public link", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "PDF" }).click();
  await expect(page.getByLabel("PDF file", { exact: true })).toBeVisible();
  await expect(page.getByLabel("I have the rights to use this file.")).not.toBeChecked();
});

test("Tab walks the create form in reading order and every stop shows a visible focus ring", async ({
  page,
}) => {
  await page.goto("/create");
  // The submit button is disabled until the form has a source, and a disabled button is not
  // a tab stop, so the topic is filled first and the whole order is then checked in one walk.
  await page.getByLabel("Topic", { exact: true }).fill("A calm weekly planning ritual");

  const expectedOrder: readonly { locator: Locator; description: string }[] = [
    { locator: page.getByRole("tab", { name: "Text" }), description: "the Text source tab" },
    { locator: page.getByRole("tab", { name: "URL" }), description: "the URL source tab" },
    { locator: page.getByRole("tab", { name: "PDF" }), description: "the PDF source tab" },
    { locator: page.getByRole("tab", { name: "Slides" }), description: "the Slides source tab" },
    { locator: page.getByRole("tab", { name: "Video" }), description: "the Video source tab" },
    { locator: page.getByLabel("Topic", { exact: true }), description: "the topic field" },
    { locator: page.getByLabel("Platform", { exact: true }), description: "the platform select" },
    { locator: page.getByLabel("Template", { exact: true }), description: "the template select" },
    { locator: page.getByLabel("Language", { exact: true }), description: "the language field" },
    {
      locator: page.getByLabel("Content format", { exact: true }),
      description: "the content format select",
    },
    {
      locator: page.getByLabel("Number of slides", { exact: true }),
      description: "the slide count field",
    },
    {
      locator: page.getByLabel("Instructions", { exact: true }),
      description: "the instructions field",
    },
    {
      locator: page.getByRole("button", { name: "Generate carousel" }),
      description: "the submit button",
    },
  ];

  await focusByKey(page, page.getByRole("tab", { name: "Topic" }), "Tab", "the Topic source tab");
  for (const stop of expectedOrder) {
    await page.keyboard.press("Tab");
    await expect(stop.locator, `${stop.description} is out of reading order`).toBeFocused();
    const outline = await outlineOfFocused(page);
    expect(outline.style, `${stop.description} has no visible focus ring`).not.toBe("none");
    expect(outline.width, `${stop.description} has a zero-width focus ring`).toBeGreaterThan(0);
  }
});

test("a keyboard-only path selects a slide, edits it and survives a reload", async ({
  page,
}, testInfo) => {
  // A draft id per engine keeps the three projects from reading each other's IndexedDB rows.
  const draftId = `local-a11y-keyboard-${testInfo.project.name}`;
  const headline = `Keyboard edit ${testInfo.project.name}`;

  await page.goto(`/editor/${draftId}`);
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  const secondSlide = page.getByRole("button", { name: "Slide 2: Lead with the conclusion" });
  await focusByKey(page, secondSlide, "Tab", "the second slide in the filmstrip");
  await page.keyboard.press("Enter");
  await expect(secondSlide).toHaveAttribute("aria-pressed", "true");

  const headlineField = page.getByLabel("Headline", { exact: true });
  await focusByKey(page, headlineField, "Shift+Tab", "the headline field");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(headline);
  await expect(headlineField).toHaveValue(headline);
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  await page.reload();
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  await expect(page.getByRole("button", { name: `Slide 2: ${headline}` })).toBeVisible();
});

test("the export entry keeps its heading and announces its state in a live region", async ({
  page,
}) => {
  await page.goto("/exports");

  await expect(page.getByRole("heading", { level: 1, name: "Exports" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();

  // Signed out, the export history request is rejected and the page says so in an alert
  // region instead of rendering an empty box that a screen reader would skip over.
  // The signed-in download itself is covered by the cloud-gated case in browsers.spec.ts.
  await expect(page.getByRole("alert")).toHaveText("Exports are temporarily unavailable.");
});
