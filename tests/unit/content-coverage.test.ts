import { describe, expect, it } from "vitest";
import { listContent, readContent } from "../../src/server/content";

describe("T077 help and guide coverage", () => {
  it("covers input, editing, export, recovery, and billing with readable trusted content", async () => {
    expect(listContent("help")).toEqual(["getting-started", "export-and-restore", "billing-and-cancellation"]);
    expect(listContent("guide")).toEqual(["text-to-carousel"]);
    const documents = await Promise.all([
      readContent("help", "getting-started"),
      readContent("help", "export-and-restore"),
      readContent("help", "billing-and-cancellation"),
      readContent("guide", "text-to-carousel"),
    ]);
    const text = documents.flatMap((document) => document.blocks.map((block) => block.kind === "list" ? block.items.join(" ") : block.text)).join(" ").toLowerCase();
    for (const subject of ["input", "edit", "export", "restore", "billing"]) expect(text).toContain(subject);
    expect(documents.every((document) => document.blocks.length >= 4)).toBe(true);
  });

  it("keeps the current waitlist limitation explicit", async () => {
    const billing = await readContent("help", "billing-and-cancellation");
    const text = billing.blocks.map((block) => block.kind === "list" ? block.items.join(" ") : block.text).join(" ");
    expect(text).toContain("does not submit or store an email");
    expect(text).not.toMatch(/\$\d+/);
  });
});
