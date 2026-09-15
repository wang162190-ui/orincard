import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh-Hans.json";

vi.mock("next-intl/server", async () => (await import("../helpers/intl-server")).createIntlServerStub());

import { AssistantPanel } from "../../src/features/editor/assistant";
import { AIProposal } from "../../src/features/editor/ai-proposal";

// 与 agent-panel.test.tsx 同一套路：用真实词条文件渲染，key 少一个就渲染不出文案、用例直接红。
function render(node: ReactNode, locale: "en" | "zh-Hans" = "en"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}>
      {node}
    </NextIntlClientProvider>,
  );
}

const PROPOSAL = {
  proposalJobId: "00000000-0000-4000-8000-000000000032",
  projectId: "00000000-0000-4000-8000-000000000001",
  projectRevision: 4,
  slideId: "slide-2",
  baseSlideRevision: 3,
  field: "title" as const,
  before: "Write for one person",
  after: "Write for the one person who replied",
};

describe("editor assistant", () => {
  it("opens with a question box and no proposal, because nothing has been asked yet", () => {
    const markup = render(<AssistantPanel projectId={PROPOSAL.projectId} projectRevision={4} />);

    expect(markup).toContain("Ask about this carousel");
    expect(markup).toContain("Revision 4");
    expect(markup).toContain("Ask about this carousel to get started.");
    // 关键契约：还没有提议的时候，界面上不能出现任何「应用」入口。
    expect(markup).not.toContain("Accept");
    expect(markup).not.toContain("AI rewrite proposal");
  });

  it("states plainly that it reads the carousel and never writes it", () => {
    const markup = render(<AssistantPanel projectId={PROPOSAL.projectId} projectRevision={4} />);
    expect(markup).toContain("it never writes it");
  });

  it("renders a proposal as a before/after diff with both a reject and an accept", () => {
    // 面板内部的提议渲染就是这个组件；单独渲染它，确认 diff 两侧都在、且拒绝排在接受前面。
    const markup = render(
      <AIProposal onAccept={() => {}} onReject={() => {}} proposal={PROPOSAL} />,
    );

    expect(markup).toContain(PROPOSAL.before);
    expect(markup).toContain(PROPOSAL.after);
    expect(markup.indexOf("Reject")).toBeLessThan(markup.indexOf("Accept"));
  });

  it("renders both locales from the shipped message files", () => {
    expect(render(<AssistantPanel projectId={PROPOSAL.projectId} projectRevision={4} />, "zh-Hans"))
      .toContain("助手只读这份卡片，不会替你写");
    expect(Object.keys(en.Assistant).sort()).toEqual(Object.keys(zh.Assistant).sort());
  });

  it("keeps the conflict wording honest about nothing being written", () => {
    for (const catalog of [en.Assistant, zh.Assistant]) {
      expect(catalog.conflictDetail).toBeTruthy();
      expect(catalog.applyFailed).toBeTruthy();
      // 冲突与失败两条都必须明说「什么都没有写入」，这是 AC-012 的验收语气，不是随手文案。
      expect(`${catalog.conflict}${catalog.conflictDetail}`).toMatch(/Nothing was written|什么都没有写入/);
      expect(catalog.applyFailed).toMatch(/Nothing was written|什么都没有写入/);
      // 额度用尽时不能说「稍后重试」——模型根本没被调用，也没有扣费。
      expect(catalog.blocked).toMatch(/No model was called|模型没有被调用/);
    }
  });
});
