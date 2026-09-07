import { randomUUID } from "node:crypto";
import {
  sourceParseFailure,
  sourceParseResult,
  type SourceParseLimits,
  type SourceParseResult,
  type SourceParser,
  type SourceSegment,
} from "./index";
import type { SafeFetchFailureReason, SafeFetchResult, SafeFetcher } from "./safe-fetch";

export interface UrlSourceParserOptions {
  readonly fetch: SafeFetcher;
  readonly createId?: () => string;
}

// Only the references a browser would render identically. There is deliberately no
// mechanism for a document to declare its own entities: an internal DTD subset is
// discarded with the doctype, and an undeclared reference is left as literal text, so
// `<!ENTITY xxe SYSTEM "file:///etc/passwd">` can never resolve to anything.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
};

// Elements whose text content is code, styling or an alternative rendering: keeping any
// of it would put script bodies and CSS into the generated deck.
const DISCARDED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "audio",
  "video",
  "form",
  "select",
  "textarea",
  "button",
];

const BLOCK_ELEMENTS = [
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
];

const BLOCK_PATTERN = new RegExp(`</?(?:${BLOCK_ELEMENTS.join("|")})(?:\\s[^>]*)?/?>`, "gi");

function decodeReferences(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      // Surrogates and C0/C1 controls are never legitimate page text.
      if (code >= 0xd800 && code <= 0xdfff) return "";
      if (code < 0x20 && code !== 0x09 && code !== 0x0a) return "";
      if (code >= 0x7f && code <= 0x9f) return "";
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    // An unknown reference stays literal. It is never looked up anywhere.
    return named ?? match;
  });
}

function stripElement(html: string, tag: string): string {
  return html.replace(
    new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}\\s*>|$)`, "gi"),
    " ",
  );
}

function extractTitle(html: string): string | undefined {
  const tag = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html);
  const candidate = tag?.[1] ?? /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i
    .exec(html)?.[0]
    ?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  if (!candidate) return undefined;
  const title = decodeReferences(candidate).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title.slice(0, 300) : undefined;
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[\t  ]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

function htmlToParagraphs(html: string): string[] {
  let working = html.replace(/^﻿/, "");
  working = working.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  // The doctype goes first, internal subset and all, so a declared entity is gone
  // before anything looks at references.
  working = working.replace(/<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi, " ");
  working = working.replace(/<\?[\s\S]*?(?:\?>|$)/g, " ");
  working = working.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, " ");
  for (const tag of DISCARDED_ELEMENTS) working = stripElement(working, tag);

  // Prefer the article body when the page marks one, otherwise the document body.
  const scoped =
    /<article(?:\s[^>]*)?>([\s\S]*?)<\/article\s*>/i.exec(working)?.[1] ??
    /<main(?:\s[^>]*)?>([\s\S]*?)<\/main\s*>/i.exec(working)?.[1] ??
    /<body(?:\s[^>]*)?>([\s\S]*?)<\/body\s*>/i.exec(working)?.[1] ??
    working;

  const marked = scoped.replace(BLOCK_PATTERN, "\n\n").replace(/<[^>]*>/g, "");
  return toParagraphs(decodeReferences(marked));
}

function isHtml(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "text/html" || essence === "application/xhtml+xml" || essence === "";
}

function isPlainText(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "text/plain" || essence === "text/markdown";
}

function failureFor(reason: SafeFetchFailureReason): SourceParseResult {
  switch (reason) {
    case "too-large":
      return sourceParseFailure("SOURCE_TOO_LARGE", {
        action: "paste-text",
        message: "This page is too large to import. Paste the part you need instead.",
      });
    case "timeout":
      return sourceParseFailure("SOURCE_TIMEOUT");
    case "unavailable":
      return sourceParseFailure("SOURCE_UNAVAILABLE");
    case "too-many-redirects":
      return sourceParseFailure("SOURCE_BLOCKED", {
        message: "This link redirects too many times. Paste the public text instead.",
      });
    default:
      // Both `blocked` and `unsupported-scheme` reach the user as the same sentence.
      // Telling them which private address a name resolved to would turn this parser
      // into a network scanner.
      return sourceParseFailure("SOURCE_BLOCKED");
  }
}

export function createUrlSourceParser(options: UrlSourceParserOptions): SourceParser<string> {
  const createId = options.createId ?? randomUUID;

  return {
    kind: "url",
    async parse(input: string, limits: SourceParseLimits): Promise<SourceParseResult> {
      const target = input.trim();
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return sourceParseFailure("SOURCE_BLOCKED", {
          action: "use-public-url",
          message: "That is not a complete web address. Use a public https:// link instead.",
        });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return sourceParseFailure("SOURCE_BLOCKED");
      }

      let fetched: SafeFetchResult;
      try {
        fetched = await options.fetch(target, {
          maxBytes: limits.maxBytes,
          timeoutMs: limits.timeoutMs,
        });
      } catch {
        return sourceParseFailure("SOURCE_UNAVAILABLE");
      }
      if (!fetched.ok) return failureFor(fetched.reason);

      // The row this becomes stores metadata.publicUrl, and the database refuses
      // anything that is not https, so an http final hop is rejected here with the
      // action that actually fixes it.
      if (!fetched.url.startsWith("https://")) {
        return sourceParseFailure("SOURCE_BLOCKED", {
          action: "use-public-url",
          message: "This link isn't served over HTTPS. Use a public https:// link instead.",
        });
      }

      const html = isHtml(fetched.contentType);
      if (!html && !isPlainText(fetched.contentType)) {
        return sourceParseFailure("SOURCE_UNSUPPORTED_FORMAT", {
          action: "upload-file",
          message: "This link isn't a readable web page. Upload the file instead.",
        });
      }

      const paragraphs = html ? htmlToParagraphs(fetched.body) : toParagraphs(fetched.body);

      const segments: SourceSegment[] = [];
      let characters = 0;
      let truncated = false;
      for (const paragraph of paragraphs) {
        if (segments.length >= limits.maxSegments) {
          truncated = true;
          break;
        }
        const length = Array.from(paragraph).length;
        if (characters + length > limits.maxCharacters) {
          truncated = true;
          break;
        }
        characters += length;
        segments.push({ segmentId: createId(), text: paragraph });
      }

      // Routed through the shared builder so a page with no readable body becomes a
      // typed failure rather than an accepted source with nothing in it.
      return sourceParseResult(segments, {
        title: html ? extractTitle(fetched.body) : undefined,
        publicUrl: fetched.url,
        ...(truncated ? { truncated: true } : {}),
      });
    },
  };
}
