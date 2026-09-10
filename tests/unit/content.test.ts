import { describe, expect, it } from "vitest";
import { ContentNotFoundError, listContent, parseTrustedMarkdown, readContent } from "../../src/server/content";

describe("T076 trusted content", () => {
  it("reads the allowlisted getting-started help article", async () => {
    const article = await readContent("help", "getting-started");
    expect(article.title).toBe("Getting started with Orincard");
    expect(article.blocks.filter((block) => block.kind === "heading").map((block) => block.text)).toEqual(expect.arrayContaining(["Choose an input", "Export", "Restore a project", "Manage billing"]));
    expect(listContent("help")).toEqual(["getting-started"]);
  });

  it.each(["../project", "..%2fproject", "/etc/passwd", "getting_started", "Getting-Started"])("rejects a non-catalog or traversal slug: %s", async (slug) => {
    await expect(readContent("help", slug)).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "export const metadata = {}",
    "{dangerousExpression()}",
    "```html\n<div>unsafe</div>\n```",
  ])("rejects raw HTML and executable MDX", (body) => {
    expect(() => parseTrustedMarkdown(`---\ntitle: Unsafe\ndescription: Unsafe content\n---\n\n${body}\n`, { kind: "help", slug: "unsafe" })).toThrow();
  });

  it("parses only headings, paragraphs, and lists as inert text", () => {
    const content = parseTrustedMarkdown("---\ntitle: Safe\ndescription: Safe content\n---\n\n## Heading\n\nA paragraph.\n\n- One\n- Two\n", { kind: "guide", slug: "safe" });
    expect(content.blocks).toEqual([{ kind: "heading", level: 2, text: "Heading" }, { kind: "paragraph", text: "A paragraph." }, { kind: "list", ordered: false, items: ["One", "Two"] }]);
  });
});
