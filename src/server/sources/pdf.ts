import { randomUUID } from "node:crypto";
import {
  sourceParseFailure,
  sourceParseResult,
  type SourceParseLimits,
  type SourceParseResult,
  type SourceParser,
  type SourceSegment,
} from "./index";
import {
  OCR_EXECUTABLES,
  OCR_LIMITS,
  SourceToolError,
  createTesseractPageOcr,
  missingExecutables,
  runCommand,
  type CommandRunner,
  type PageOcr,
} from "./ocr";

// T040. A PDF reaches this module as a file already downloaded and validated by T038, so
// the parser only decides which of five shapes it is looking at: a real text layer, a
// scan that needs OCR, a blank document, an encrypted document, or one with more pages
// than we are willing to read. AC-002 forbids the sixth outcome — an empty success.

export const PDF_EXECUTABLES = ["pdfinfo", "pdftotext", ...OCR_EXECUTABLES] as const;

export const PDF_PARSE_LIMITS: SourceParseLimits = {
  maxBytes: 25 * 1_024 * 1_024,
  // One segment per page, so the segment cap is also the page cap for what we keep.
  maxSegments: 200,
  maxCharacters: 400_000,
  timeoutMs: 120_000,
};

// Above the read cap we still parse, but only the leading pages, and the result says so
// through metadata.truncated. Above the hard cap the document is refused outright: the
// user gets a split-the-file instruction instead of a silently partial deck.
export const PDF_MAX_PAGES = 2_000;

// A page holding fewer readable characters than this is treated as having no usable text
// layer and becomes an OCR candidate. Its extracted text is still kept if OCR finds less.
export const PDF_TEXT_LAYER_MIN_CHARACTERS = 8;

const PDFINFO_TIMEOUT_MS = 20_000;
const PDFTOTEXT_TIMEOUT_MS = 60_000;

export interface PdfParseInput {
  readonly filePath: string;
  readonly byteLength?: number;
  readonly title?: string;
}

interface PdfInfo {
  readonly pageCount: number;
  readonly encrypted: boolean;
  readonly extractable: boolean;
  readonly title?: string;
}

export function parsePdfInfo(stdout: string): PdfInfo | undefined {
  const pages = /^Pages:\s+(\d+)\s*$/m.exec(stdout);
  if (!pages) return undefined;
  const encryptedLine = /^Encrypted:\s+(.*)$/m.exec(stdout)?.[1]?.trim() ?? "no";
  const encrypted = encryptedLine.startsWith("yes");
  const titleLine = /^Title:\s+(.*)$/m.exec(stdout)?.[1]?.trim();
  return {
    pageCount: Number.parseInt(pages[1]!, 10),
    encrypted,
    // poppler prints the permission flags next to "yes". An owner password that still
    // allows copying leaves the text layer readable, so only a copy-protected document
    // is rejected as encrypted; anything else would refuse files we can legitimately read.
    extractable: !encrypted || !/copy:no/.test(encryptedLine),
    title: titleLine && titleLine.length > 0 ? titleLine : undefined,
  };
}

// pdftotext separates pages with a form feed and appends one after the last page.
export function splitPdfPages(text: string): string[] {
  const pages = text.split("\f");
  if (pages.length > 1 && pages[pages.length - 1] === "") pages.pop();
  return pages;
}

function normalizePageText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toolFailure(error: SourceToolError): SourceParseResult {
  if (error.reason === "timeout") return sourceParseFailure("SOURCE_TIMEOUT");
  return sourceParseFailure("SOURCE_UNAVAILABLE", {
    action: "retry-later",
    message: "This file could not be read right now. Try again in a moment.",
  });
}

export function createPdfSourceParser(options: {
  readonly runner?: CommandRunner;
  readonly ocr?: PageOcr | null;
  readonly createId?: () => string;
  readonly now?: () => number;
} = {}): SourceParser<PdfParseInput> {
  const runner = options.runner ?? runCommand;
  const ocr = options.ocr === undefined ? createTesseractPageOcr({ runner }) : options.ocr;
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => Date.now());

  return {
    kind: "pdf",
    async parse(input, limits = PDF_PARSE_LIMITS): Promise<SourceParseResult> {
      const deadline = now() + limits.timeoutMs;
      const remaining = (cap: number) => Math.min(cap, Math.max(deadline - now(), 0));

      if (input.byteLength !== undefined && input.byteLength > limits.maxBytes) {
        return sourceParseFailure("SOURCE_TOO_LARGE");
      }

      try {
        const info = await runner("pdfinfo", ["-enc", "UTF-8", input.filePath], {
          timeoutMs: remaining(PDFINFO_TIMEOUT_MS),
          maxOutputBytes: 256 * 1_024,
        });
        if (info.timedOut) return sourceParseFailure("SOURCE_TIMEOUT");
        if (info.code !== 0) {
          // poppler answers a wrong or missing password with this one message. Everything
          // else that stops pdfinfo means the container is not a readable PDF at all.
          return /incorrect password|encrypted/i.test(info.stderr)
            ? sourceParseFailure("SOURCE_ENCRYPTED")
            : sourceParseFailure("SOURCE_MALFORMED");
        }
        const parsed = parsePdfInfo(info.stdout.toString("utf8"));
        if (!parsed || !Number.isFinite(parsed.pageCount) || parsed.pageCount <= 0) {
          return sourceParseFailure("SOURCE_MALFORMED");
        }
        if (!parsed.extractable) return sourceParseFailure("SOURCE_ENCRYPTED");
        if (parsed.pageCount > PDF_MAX_PAGES) {
          return sourceParseFailure("SOURCE_TOO_LARGE", {
            action: "split-input",
            message: `This PDF has more than ${PDF_MAX_PAGES} pages. Split it and import the parts separately.`,
          });
        }

        const readPages = Math.min(parsed.pageCount, limits.maxSegments);
        let truncated = readPages < parsed.pageCount;

        const extracted = await runner(
          "pdftotext",
          [
            "-enc",
            "UTF-8",
            "-eol",
            "unix",
            "-q",
            "-f",
            "1",
            "-l",
            String(readPages),
            input.filePath,
            "-",
          ],
          { timeoutMs: remaining(PDFTOTEXT_TIMEOUT_MS), maxOutputBytes: 16 * 1_024 * 1_024 },
        );
        if (extracted.timedOut) return sourceParseFailure("SOURCE_TIMEOUT");
        if (extracted.code !== 0) {
          return /incorrect password|encrypted/i.test(extracted.stderr)
            ? sourceParseFailure("SOURCE_ENCRYPTED")
            : sourceParseFailure("SOURCE_MALFORMED");
        }
        if (extracted.truncated) truncated = true;

        const pageTexts = splitPdfPages(extracted.stdout.toString("utf8"))
          .slice(0, readPages)
          .map(normalizePageText);
        while (pageTexts.length < readPages) pageTexts.push("");

        // Only pages that came back without a usable text layer are rasterized, and only
        // up to the OCR budget. Everything else is already readable and costs nothing.
        const candidates = pageTexts
          .map((text, index) => ({ page: index + 1, text }))
          .filter((page) => Array.from(page.text).length < PDF_TEXT_LAYER_MIN_CHARACTERS);
        const ocrTargets = ocr ? candidates.slice(0, OCR_LIMITS.maxPages) : [];
        if (ocr && candidates.length > ocrTargets.length) truncated = true;

        let ocrPageCount = 0;
        let inkWithoutText = false;
        for (const target of ocrTargets) {
          if (!ocr) break;
          if (remaining(OCR_LIMITS.perPageTimeoutMs) <= 0) {
            return sourceParseFailure("SOURCE_TIMEOUT");
          }
          const outcome = await ocr.recognize({
            filePath: input.filePath,
            page: target.page,
            timeoutMs: remaining(OCR_LIMITS.perPageTimeoutMs),
          });
          const recognized = normalizePageText(outcome.text);
          if (recognized.length > Array.from(target.text).length) {
            pageTexts[target.page - 1] = recognized;
            ocrPageCount += 1;
          } else if (outcome.hasInk && recognized.length === 0) {
            inkWithoutText = true;
          }
        }

        let characterBudget = limits.maxCharacters;
        const segments: SourceSegment[] = [];
        for (const [index, text] of pageTexts.entries()) {
          if (text.length === 0) continue;
          if (characterBudget <= 0) {
            truncated = true;
            break;
          }
          const characters = Array.from(text);
          const kept =
            characters.length > characterBudget
              ? characters.slice(0, characterBudget).join("")
              : text;
          if (characters.length > characterBudget) truncated = true;
          characterBudget -= Math.min(characters.length, characterBudget);
          segments.push({
            segmentId: createId(),
            text: kept,
            locator: { kind: "page", page: index + 1 },
          });
        }

        // The one invariant AC-002 turns on: when nothing readable came out, the result is
        // a typed failure with an alternative action, never ok:true with no segments.
        // A page carrying ink we could not read is a scan (paste the text); a page with no
        // marks at all is an empty document. With OCR switched off we cannot tell the two
        // apart, so we report the one that does not claim the document was empty.
        const emptyCode =
          ocr === null || inkWithoutText ? "SOURCE_NO_TEXT_LAYER" : "SOURCE_EMPTY";

        return sourceParseResult(
          segments,
          {
            title: input.title ?? parsed.title,
            pageCount: parsed.pageCount,
            ...(ocrPageCount > 0 ? { ocrPageCount } : {}),
            ...(truncated ? { truncated: true } : {}),
          },
          emptyCode,
        );
      } catch (error) {
        if (error instanceof SourceToolError) return toolFailure(error);
        throw error;
      }
    },
  };
}

export async function missingPdfExecutables(
  runner: CommandRunner = runCommand,
): Promise<string[]> {
  return missingExecutables(PDF_EXECUTABLES, runner);
}
