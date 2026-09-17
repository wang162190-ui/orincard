import { describe, expect, it } from "vitest";
import { legalPublicationDecision, parseTrustedMarkdown, readContent } from "../../src/server/content";

const approvedPolicy = () => parseTrustedMarkdown(
  "---\ntitle: Approved policy\ndescription: Approved policy fixture\npublicationStatus: approved\npolicyVersion: policy-2026-09-10\n---\n\n## Scope\n\nApproved policy text.\n",
  { kind: "legal", slug: "privacy" },
);

// 三份正文在 2026-09-17 由产品所有者签成 approved（版本号 <slug>-2026-09-17），
// 所以「草稿」这组断言换成了「已发布」。门禁函数本身对草稿的行为没变，改用一份合成草稿来测。
const draftPolicy = () => parseTrustedMarkdown(
  "---\ntitle: Draft policy\ndescription: Draft policy fixture\npublicationStatus: draft\npolicyVersion: policy-draft-2026-09-10\n---\n\n## Scope\n\nDraft policy text.\n",
  { kind: "legal", slug: "privacy" },
);

describe("T083 legal policy publication gate", () => {
  it.each([
    ["privacy", "What we process"],
    ["terms", "Plans, renewal, and failed payments"],
    ["affiliate", "Commission"],
  ] as const)("loads the %s policy as approved text carrying its own version", async (slug, heading) => {
    const policy = await readContent("legal", slug);

    expect(policy.publicationStatus).toBe("approved");
    expect(policy.policyVersion).toBe(`${slug}-2026-09-17`);
    expect(policy.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.blocks).toContainEqual(expect.objectContaining({ kind: "heading", text: heading }));
    expect(policy.blocks.some((block) => block.kind === "paragraph" && /not .*?(?:legally reviewed|approved)/i.test(block.text))).toBe(false);
  });

  it("blocks a draft even when approval-shaped evidence is supplied", () => {
    const policy = draftPolicy();
    expect(legalPublicationDecision(policy, {
      slug: policy.slug,
      policyVersion: policy.policyVersion!,
      contentHash: policy.contentHash!,
      approvedBy: "Legal Reviewer",
      approvedAt: "2026-09-10T08:00:00.000Z",
      approvalId: "legal-approval-123",
    })).toEqual({ publishable: false, reason: "DRAFT_CONTENT" });
  });

  it("requires human evidence tied to the exact approved text and version", () => {
    const policy = approvedPolicy();
    const evidence = {
      slug: policy.slug,
      policyVersion: policy.policyVersion!,
      contentHash: policy.contentHash!,
      approvedBy: "Legal Reviewer",
      approvedAt: "2026-09-10T08:00:00.000Z",
      approvalId: "legal-approval-123",
    };

    expect(legalPublicationDecision(policy)).toEqual({ publishable: false, reason: "APPROVAL_REQUIRED" });
    expect(legalPublicationDecision(policy, { ...evidence, contentHash: "0".repeat(64) })).toEqual({ publishable: false, reason: "APPROVAL_MISMATCH" });
    expect(legalPublicationDecision(policy, { ...evidence, approvedBy: "AI" })).toEqual({ publishable: false, reason: "APPROVAL_MISMATCH" });
    expect(legalPublicationDecision(policy, evidence)).toEqual({ publishable: true, reason: "APPROVED" });
  });

  it("rejects legal content without explicit publication metadata", () => {
    expect(() => parseTrustedMarkdown(
      "---\ntitle: Policy\ndescription: Missing gate metadata\n---\n\nPolicy text.\n",
      { kind: "legal", slug: "privacy" },
    )).toThrow("Legal content is missing publication metadata.");
  });
});
