import { describe, expect, it } from "vitest";
import { legalPublicationDecision, parseTrustedMarkdown, readContent } from "../../src/server/content";

const approvedPolicy = () => parseTrustedMarkdown(
  "---\ntitle: Approved policy\ndescription: Approved policy fixture\npublicationStatus: approved\npolicyVersion: policy-2026-09-10\n---\n\n## Scope\n\nApproved policy text.\n",
  { kind: "legal", slug: "privacy" },
);

describe("T083 legal policy publication gate", () => {
  it.each([
    ["privacy", "Information covered by this draft"],
    ["terms", "Plans and billing"],
    ["affiliate", "Commission draft"],
  ] as const)("loads the %s policy as a versioned review draft", async (slug, heading) => {
    const policy = await readContent("legal", slug);

    expect(policy.publicationStatus).toBe("draft");
    expect(policy.policyVersion).toContain("draft-2026-09-10");
    expect(policy.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(policy.blocks).toContainEqual(expect.objectContaining({ kind: "heading", text: heading }));
    expect(policy.blocks.some((block) => block.kind === "paragraph" && /not .*?(?:legally reviewed|approved)/i.test(block.text))).toBe(true);
  });

  it("blocks a draft even when approval-shaped evidence is supplied", async () => {
    const policy = await readContent("legal", "privacy");
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
