import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export type ContentKind = "help" | "guide" | "legal";

export type ContentBlock =
  | { readonly kind: "heading"; readonly level: 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] };

export type ContentDocument = {
  readonly kind: ContentKind;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly blocks: readonly ContentBlock[];
  readonly publicationStatus?: "draft" | "approved";
  readonly policyVersion?: string;
  readonly contentHash?: string;
};

type CatalogEntry = {
  readonly kind: ContentKind;
  readonly slug: string;
  readonly file: string;
};

const CONTENT_ROOT = resolve(process.cwd(), "content");
const CATALOG: readonly CatalogEntry[] = [
  { kind: "help", slug: "getting-started", file: "help/getting-started.mdx" },
  { kind: "help", slug: "export-and-restore", file: "help/export-and-restore.mdx" },
  { kind: "help", slug: "billing-and-cancellation", file: "help/billing-and-cancellation.mdx" },
  { kind: "guide", slug: "text-to-carousel", file: "guides/text-to-carousel.mdx" },
  { kind: "legal", slug: "privacy", file: "legal/privacy.mdx" },
  { kind: "legal", slug: "terms", file: "legal/terms.mdx" },
  { kind: "legal", slug: "affiliate", file: "legal/affiliate.mdx" },
];

export class ContentNotFoundError extends Error {
  constructor() {
    super("Content not found.");
    this.name = "ContentNotFoundError";
  }
}

function frontmatter(source: string) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("Trusted content needs frontmatter.");
  const metadata: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("Trusted content has invalid frontmatter.");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!["title", "description", "publicationStatus", "policyVersion"].includes(key) || !value) throw new Error("Trusted content has invalid frontmatter.");
    metadata[key] = value;
  }
  if (!metadata.title || !metadata.description) throw new Error("Trusted content is missing metadata.");
  return { metadata, body: match[2] };
}

function rejectExecutableMarkup(source: string) {
  if (
    /<\/?[a-z][^>]*>/i.test(source) ||
    /^\s*(import|export)\s/m.test(source) ||
    /\{[\s\S]*\}/.test(source) ||
    /^\s*```(?:html|jsx|tsx|javascript|js)\b/im.test(source)
  ) {
    throw new Error("Executable or raw HTML content is not allowed.");
  }
}

export function parseTrustedMarkdown(source: string, identity: { readonly kind: ContentKind; readonly slug: string }): ContentDocument {
  rejectExecutableMarkup(source);
  const { metadata, body } = frontmatter(source.replaceAll("\r\n", "\n"));
  const blocks: ContentBlock[] = [];
  const lines = body.split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    paragraph = [];
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length as 2 | 3, text: heading[2] });
      continue;
    }
    const item = line.match(/^(?:([-*])|(\d+)\.)\s+(.+)$/);
    if (item) {
      const ordered = Boolean(item[2]);
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(item[3]);
      continue;
    }
    if (line.startsWith("#") || line.startsWith(">") || line.startsWith("```")) throw new Error("Trusted content uses an unsupported Markdown construct.");
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  if (blocks.length === 0) throw new Error("Trusted content is empty.");
  if (identity.kind === "legal" && (!(["draft", "approved"] as const).includes(metadata.publicationStatus as "draft" | "approved") || !metadata.policyVersion)) throw new Error("Legal content is missing publication metadata.");
  return {
    ...identity,
    title: metadata.title,
    description: metadata.description,
    blocks,
    ...(identity.kind === "legal" ? {
      publicationStatus: metadata.publicationStatus as "draft" | "approved",
      policyVersion: metadata.policyVersion,
      contentHash: createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex"),
    } : {}),
  };
}

export type LegalApprovalEvidence = {
  readonly slug: string;
  readonly policyVersion: string;
  readonly contentHash: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalId: string;
};

export function legalPublicationDecision(document: ContentDocument, evidence?: LegalApprovalEvidence) {
  if (document.kind !== "legal") return { publishable: false as const, reason: "NOT_LEGAL_CONTENT" as const };
  if (document.publicationStatus !== "approved") return { publishable: false as const, reason: "DRAFT_CONTENT" as const };
  if (!evidence) return { publishable: false as const, reason: "APPROVAL_REQUIRED" as const };
  const approvedAt = Date.parse(evidence.approvedAt);
  if (
    evidence.slug !== document.slug ||
    evidence.policyVersion !== document.policyVersion ||
    evidence.contentHash !== document.contentHash ||
    !evidence.approvalId.startsWith("legal-approval-") ||
    evidence.approvedBy.trim().length < 3 ||
    /^(ai|automation|system)$/i.test(evidence.approvedBy.trim()) ||
    !Number.isFinite(approvedAt)
  ) return { publishable: false as const, reason: "APPROVAL_MISMATCH" as const };
  return { publishable: true as const, reason: "APPROVED" as const };
}

export function listContent(kind: ContentKind) {
  return CATALOG.filter((entry) => entry.kind === kind).map(({ slug }) => slug);
}

export async function readContent(kind: ContentKind, slug: string): Promise<ContentDocument> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ContentNotFoundError();
  const entry = CATALOG.find((candidate) => candidate.kind === kind && candidate.slug === slug);
  if (!entry) throw new ContentNotFoundError();
  const source = await readFile(resolve(CONTENT_ROOT, entry.file), "utf8");
  return parseTrustedMarkdown(source, { kind, slug });
}
