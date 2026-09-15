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
  // 三个下拉用 getByRole 按可访问名断言。它们的 <label> 包住了 <select>，label 的纯文本因此
  // 连着选项文字（"Platform" + "LinkedIn…"），getByLabel 的精确匹配对不上；而读屏软件读的是
  // 可访问名，实测就是 "Platform"。这里断言可访问名，才是这条用例要证的东西。
  // Language 也是包住 <select> 的 label，和上面三个是同一种，得按可访问名断言。
  for (const name of ["Platform", "Template", "Language", "Content format"]) {
    await expect(page.getByRole("combobox", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  await expect(page.getByLabel("Number of slides", { exact: true })).toBeVisible();

  const generate = page.getByRole("button", { name: "Generate carousel" });
  await expect(page.getByLabel("Topic", { exact: true })).toBeVisible();
  await expect(generate).toBeDisabled();
  await page.getByLabel("Topic", { exact: true }).fill("A calm weekly planning ritual");
  await expect(generate).toBeEnabled();

  // Switching the source kind renames the field instead of leaving a nameless input behind.
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByRole("textbox", { name: "Source text", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "URL" }).click();
  await expect(page.getByLabel("Public link", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "PDF" }).click();
  await expect(page.getByLabel("PDF file", { exact: true })).toBeVisible();
  await expect(page.getByLabel("I have the rights to use this file.")).not.toBeChecked();
});

// macOS 的系统默认（AppleKeyboardUIMode 未设置）只让 Tab 停在文本框和列表上，按钮、链接、
// role=tab 一律不进 Tab 序。Safari/WebKit 照办，Chrome 与 Firefox 不照办。这是操作系统惯例，
// 对所有网站一视同仁，不是本页的缺陷；依赖键盘的 Mac 用户要开"全键盘控制"，开了之后 Safari
// 的 Tab 序与另两个引擎一致。所以下面按引擎分流：三个引擎都验读序，但 WebKit 上只验它真的
// 会停的那些控件。这一条如实记在 docs/acceptance/browsers.md，不当作已通过的按钮可达性证据。
const WEBKIT_SKIPS_BUTTONS = "webkit";

test("Tab walks the create form in reading order and every stop shows a visible focus ring", async ({
  page,
}, testInfo) => {
  const buttonsAreTabStops = testInfo.project.name !== WEBKIT_SKIPS_BUTTONS;
  await page.goto("/create");
  // The submit button is disabled until the form has a source, and a disabled button is not
  // a tab stop, so the topic is filled first and the whole order is then checked in one walk.
  await page.getByLabel("Topic", { exact: true }).fill("A calm weekly planning ritual");

  const sourceTabs: readonly { locator: Locator; description: string }[] = [
    { locator: page.getByRole("tab", { name: "Text" }), description: "the Text source tab" },
    { locator: page.getByRole("tab", { name: "URL" }), description: "the URL source tab" },
    { locator: page.getByRole("tab", { name: "PDF" }), description: "the PDF source tab" },
    { locator: page.getByRole("tab", { name: "Slides" }), description: "the Slides source tab" },
    { locator: page.getByRole("tab", { name: "Video" }), description: "the Video source tab" },
  ];

  const expectedOrder: readonly { locator: Locator; description: string }[] = [
    ...(buttonsAreTabStops ? sourceTabs : []),
    { locator: page.getByLabel("Topic", { exact: true }), description: "the topic field" },
    {
      locator: page.getByRole("combobox", { name: "Platform", exact: true }),
      description: "the platform select",
    },
    {
      locator: page.getByRole("combobox", { name: "Template", exact: true }),
      description: "the template select",
    },
    {
      locator: page.getByRole("combobox", { name: "Language", exact: true }),
      description: "the language select",
    },
    {
      locator: page.getByRole("combobox", { name: "Content format", exact: true }),
      description: "the content format select",
    },
    {
      locator: page.getByLabel("Number of slides", { exact: true }),
      description: "the slide count field",
    },
    {
      locator: page.getByRole("textbox", { name: "Instructions", exact: true }),
      description: "the instructions field",
    },
    ...(buttonsAreTabStops
      ? [
          {
            locator: page.getByRole("button", { name: "Generate carousel" }),
            description: "the submit button",
          },
        ]
      : []),
  ];

  // 填完 Topic 后焦点停在表单中段。Firefox 无头模式走到最后一个可聚焦元素（Generate carousel）
  // 就不再往前走——它本该把焦点交给浏览器界面，无头下没有界面，于是原地不动。所以这里先把焦点
  // 收回文档开头，从一个确定的起点走，而不是指望焦点绕回顶部。这不放宽断言：下面整条读序照走。
  // 点一下不可聚焦的一级标题，把顺序焦点的起点挪回页面顶部；blur() 不行，Firefox 记的是起点元素
  // 而不是当前焦点。
  await page.getByRole("heading", { level: 1, name: "Create a carousel" }).click();
  if (buttonsAreTabStops) {
    await focusByKey(page, page.getByRole("tab", { name: "Topic" }), "Tab", "the Topic source tab");
  }
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
  // 这条流程的第一步是用 Tab 走到胶片条里的幻灯片按钮。在 macOS 系统默认下 WebKit 根本不让 Tab
  // 停在按钮上（见上面那段说明），所以这条用例在 WebKit 上无法执行，如实记为 skipped 而不是
  // 改用鼠标点击后仍宣称"纯键盘"。chromium 与 firefox 上它真实跑通，证据以那两个引擎为准；
  // WebKit 的这一条限制写进 docs/acceptance/browsers.md。
  test.skip(
    testInfo.project.name === WEBKIT_SKIPS_BUTTONS,
    "WebKit follows the macOS Full Keyboard Access default, where buttons are not tab stops; " +
      "this path cannot be driven by keyboard alone on this engine.",
  );

  // A draft id per engine keeps the three projects from reading each other's IndexedDB rows.
  const draftId = `local-a11y-keyboard-${testInfo.project.name}`;
  const headline = `Keyboard edit ${testInfo.project.name}`;

  await page.goto(`/editor/${draftId}`);
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  const secondSlide = page.getByRole("button", { name: "Slide 2: Lead with the conclusion" });
  await focusByKey(page, secondSlide, "Tab", "the second slide in the filmstrip");
  await page.keyboard.press("Enter");
  await expect(secondSlide).toHaveAttribute("aria-pressed", "true");

  const headlineField = page.getByRole("textbox", { name: "Headline", exact: true });
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
  // 在 main 内取这条播报：Next 自己在文档末尾挂了一个空的 route announcer，它也是 role="alert"，
  // 不限定范围就会把框架噪声一起断言进来。
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Exports are temporarily unavailable.",
  );
});
