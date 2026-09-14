import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";

// `setRequestLocale` 是请求作用域的静态渲染开关，在 Next 的 react-server 条件外不可用
// （vitest 解析到 next-intl 的 react-client 出口，它会直接抛错）。这里只把这一个调用
// 短路掉，被测的东西（渲染出的 lang 属性、metadata）仍然跑真实代码。
vi.mock("next-intl/server", async () => (await import("../helpers/intl-server")).createIntlServerStub());
// 语言切换器用的 `useRouter` 要求 app router 已挂载——真实 SSR 里它是挂载的，
// renderToStaticMarkup 里没有。这里只短路 router 本身；切换器真的能不能切，
// 由 tests/e2e/marketing.spec.ts 在真实浏览器里点一次来验证，不靠这个 mock 下结论。
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
}));
import CreatePage from "../../src/app/[locale]/create/page";
import LocaleLayout, { generateMetadata, generateStaticParams } from "../../src/app/[locale]/layout";
import HomePage from "../../src/app/[locale]/page";
import { WorkspaceShell } from "../../src/components/workspace-shell";

// 用真实的 messages/en.json 渲染：这样断言里的英文来自词条文件本身，
// key 打错或漏翻会直接让用例失败，而不是悄悄渲染出占位符。
function render(node: ReactNode): string {
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
}

describe("application routes", () => {
  it("defines the approved product metadata and the rendered document language", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ locale: "en" }) });
    expect(metadata.title).toBe("Orincard — Create Social Carousels with AI");
    expect(metadata.description).toContain("editable LinkedIn, Instagram, and TikTok");
    expect(metadata.icons.icon).toMatch(/^data:image\/svg\+xml/);

    // `lang` 必须跟着渲染的语言走。中文页挂着 lang="en" 会让屏幕阅读器用英文读中文，
    // 也会让搜索引擎把中文页判成英文页。
    for (const locale of ["en", "zh-Hans"]) {
      const markup = renderToStaticMarkup(await LocaleLayout({ children: <p>Route content</p>, params: Promise.resolve({ locale }) }) as React.ReactElement);
      expect(markup).toContain(`<html lang="${locale}">`);
    }
    expect(generateStaticParams()).toEqual([{ locale: "en" }, { locale: "zh-Hans" }]);
  });

  it("renders the root as the public marketing page with a working create entry", () => {
    const markup = render(<HomePage />);

    expect(markup).toContain("Turn what you know into a carousel worth saving.");
    expect(markup).toContain("Join the waitlist");
    expect(markup).toContain('href="/create"');
    expect(markup).not.toContain("Prototype map");
    expect(markup).not.toContain(".html");
  });

  it("renders the create route with every approved source type", () => {
    const markup = render(<CreatePage />);

    expect(markup).toContain('data-page="create"');
    expect(markup).toContain("Create a carousel");
    for (const source of ["Topic", "Text", "URL", "Video", "PDF", "Slides"]) {
      expect(markup).toContain(source);
    }
  });
});

describe("workspace shell", () => {
  it("uses the approved crane, rail, and current-page navigation semantics", () => {
    const markup = render(
      <WorkspaceShell current="create" title="New carousel">
        <p>Content</p>
      </WorkspaceShell>,
    );

    expect(markup).toContain('class="app"');
    expect(markup).toContain('class="rail"');
    expect(markup).toContain('aria-label="Main navigation"');
    expect(markup).toContain('aria-label="Orincard home"');
    expect(markup).toContain('aria-label="New carousel"');
    const createLink = markup.match(/<a[^>]*href="\/create"[^>]*>/)?.[0];
    expect(createLink).toContain('aria-current="page"');
  });

  it("does not link primary navigation to unimplemented or prototype routes", () => {
    const markup = render(
      <WorkspaceShell current="workspace" title="Workspace">
        <p>Content</p>
      </WorkspaceShell>,
    );
    const hrefs = [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(hrefs)).toEqual(new Set(["/", "/create"]));
    expect(markup).not.toContain("Prototype");
    expect(markup).not.toContain("Projects");
    expect(markup).not.toContain("Brand Kits");
    expect(markup).not.toContain("Editor");
  });
});
