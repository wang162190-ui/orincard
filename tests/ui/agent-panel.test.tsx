import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh-Hans.json";

vi.mock("next-intl/server", async () => (await import("../helpers/intl-server")).createIntlServerStub());
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/agent",
}));

import AgentPage from "../../src/app/[locale]/(workspace)/agent/page";
import WorkspaceLayout from "../../src/app/[locale]/(workspace)/layout";
import { AgentPanel } from "../../src/features/agent/agent-panel";

// 用真实的词条文件渲染：key 少一个就渲染不出对应文案，用例直接红，
// 而不是悄悄渲染出 key 本身。两种语言都渲染一次，漏翻一边同样会被抓到。
function render(node: ReactNode, locale: "en" | "zh-Hans" = "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe("agent panel", () => {
  it("opens with a request form and no plan, because planning has not run yet", () => {
    const markup = render(<AgentPanel />);

    expect(markup).toContain("Describe what you want");
    expect(markup).toContain("Your request");
    expect(markup).toContain("Plan it");
    // 关键契约：还没有计划的时候，界面上不能出现任何「确认并执行」的入口。
    expect(markup).not.toContain("Confirm and run");
    expect(markup).not.toContain("Execution");
  });

  it("renders both locales from the shipped message files", () => {
    expect(render(<AgentPanel />, "zh-Hans")).toContain("说清你想要什么");
    expect(en.AgentPanel && zh.AgentPanel).toBeTruthy();
    expect(Object.keys(en.AgentPanel).sort()).toEqual(Object.keys(zh.AgentPanel).sort());
  });

  // 侧边栏现在归 (workspace)/layout.tsx，页面自己只渲染标题栏和正文——所以这条要把
  // 页面套回 layout 里才是真实的挂载形态。这也顺带验证了两半拼起来仍然是原来那棵树。
  it("mounts inside the workspace shell and lights up its own rail entry", async () => {
    const markup = render(<WorkspaceLayout>{await AgentPage()}</WorkspaceLayout>);

    expect(markup).toContain('href="/agent"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("AI agent");
  });
});
