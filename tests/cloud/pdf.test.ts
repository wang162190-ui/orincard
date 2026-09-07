import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PDF_EXECUTABLES,
  PDF_MAX_PAGES,
  PDF_PARSE_LIMITS,
  createPdfSourceParser,
  missingPdfExecutables,
  parsePdfInfo,
  splitPdfPages,
  type PdfParseInput,
} from "../../src/server/sources/pdf";
import {
  OCR_LIMITS,
  createTesseractPageOcr,
  rasterHasInk,
  readGreyRaster,
  runCommand,
  type CommandResult,
  type CommandRunner,
  type PageOcr,
} from "../../src/server/sources/ocr";

const INPUT: PdfParseInput = { filePath: "/tmp/orincard-fixture.pdf" };

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    code: 0,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

function info(lines: Readonly<Record<string, string>>): CommandResult {
  const body = Object.entries(lines)
    .map(([key, value]) => `${key}:${" ".repeat(Math.max(1, 17 - key.length))}${value}`)
    .join("\n");
  return result({ stdout: Buffer.from(`${body}\n`, "utf8") });
}

function pages(...texts: readonly string[]): CommandResult {
  return result({ stdout: Buffer.from(`${texts.join("\f")}\f`, "utf8") });
}

// A runner that answers pdfinfo and pdftotext from a script, so the classification
// decisions can be exercised without a real document on disk.
function scriptedRunner(script: {
  readonly pdfinfo: CommandResult | (() => never);
  readonly pdftotext?: CommandResult | (() => never);
}): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = async (command) => {
    calls.push(command);
    const entry = command === "pdfinfo" ? script.pdfinfo : script.pdftotext;
    if (!entry) throw new Error(`unexpected command ${command}`);
    return typeof entry === "function" ? entry() : entry;
  };
  return { runner, calls };
}

function stubOcr(outcomes: Readonly<Record<number, { hasInk: boolean; text: string }>>): {
  ocr: PageOcr;
  recognize: ReturnType<typeof vi.fn>;
} {
  const recognize = vi.fn(async (request: { page: number }) => ({
    page: request.page,
    hasInk: outcomes[request.page]?.hasInk ?? false,
    text: outcomes[request.page]?.text ?? "",
  }));
  return { ocr: { recognize }, recognize };
}

let sequence = 0;
const parser = (options: Parameters<typeof createPdfSourceParser>[0]) =>
  createPdfSourceParser({ createId: () => `segment-${(sequence += 1)}`, ...options });

describe("T040 pdfinfo and pdftotext readers", () => {
  it("reads the page count, the title and the copy permission out of pdfinfo", () => {
    expect(
      parsePdfInfo("Title:           Quarter review\nPages:           12\nEncrypted:       no\n"),
    ).toEqual({ pageCount: 12, encrypted: false, extractable: true, title: "Quarter review" });
    expect(
      parsePdfInfo("Pages:           3\nEncrypted:       yes (print:yes copy:no change:no)\n"),
    ).toMatchObject({ encrypted: true, extractable: false });
    // An owner password that still allows copying leaves a readable text layer, so it is
    // not treated as an encrypted document we have to refuse.
    expect(
      parsePdfInfo("Pages:           3\nEncrypted:       yes (print:no copy:yes change:no)\n"),
    ).toMatchObject({ encrypted: true, extractable: true });
    expect(parsePdfInfo("Command Line Error: Incorrect password")).toBeUndefined();
  });

  it("splits pdftotext output on the form feed without inventing a trailing page", () => {
    expect(splitPdfPages("one\f")).toEqual(["one"]);
    expect(splitPdfPages("one\ftwo\f")).toEqual(["one", "two"]);
    expect(splitPdfPages("\f")).toEqual([""]);
  });
});

describe("T040 PDF source parser classification", () => {
  it("keeps one segment per page with a page locator for a real text layer", async () => {
    const { runner } = scriptedRunner({
      pdfinfo: info({ Title: "Deck", Pages: "2", Encrypted: "no" }),
      pdftotext: pages("First page text\n\n", "Second page text\n"),
    });
    const parsed = await parser({ runner, ocr: null }).parse(INPUT, PDF_PARSE_LIMITS);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments.map((segment) => segment.text)).toEqual([
      "First page text",
      "Second page text",
    ]);
    expect(parsed.segments.map((segment) => segment.locator)).toEqual([
      { kind: "page", page: 1 },
      { kind: "page", page: 2 },
    ]);
    expect(parsed.metadata).toMatchObject({ pageCount: 2, title: "Deck" });
    expect(parsed.metadata.ocrPageCount).toBeUndefined();
    expect(parsed.metadata.truncated).toBeUndefined();
  });

  it("skips a page with a usable text layer instead of paying for OCR", async () => {
    const { runner } = scriptedRunner({
      pdfinfo: info({ Pages: "2", Encrypted: "no" }),
      pdftotext: pages("A readable paragraph of body text.", ""),
    });
    const { ocr, recognize } = stubOcr({ 2: { hasInk: true, text: "Recovered by OCR" } });
    const parsed = await parser({ runner, ocr }).parse(INPUT, PDF_PARSE_LIMITS);

    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0]?.[0]).toMatchObject({ page: 2 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments.map((segment) => segment.text)).toEqual([
      "A readable paragraph of body text.",
      "Recovered by OCR",
    ]);
    expect(parsed.metadata.ocrPageCount).toBe(1);
  });

  it("reports a scan whose OCR came back empty as a missing text layer, not a success", async () => {
    const { runner } = scriptedRunner({
      pdfinfo: info({ Pages: "2", Encrypted: "no" }),
      pdftotext: pages("", ""),
    });
    const { ocr } = stubOcr({ 1: { hasInk: true, text: "" }, 2: { hasInk: true, text: "  \n " } });
    const parsed = await parser({ runner, ocr }).parse(INPUT, PDF_PARSE_LIMITS);

    // AC-002: a scan we could not read must never arrive as ok:true with no segments.
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("SOURCE_NO_TEXT_LAYER");
    expect(parsed.action).toBe("paste-text");
  });

  it("tells a blank document apart from a scan by the ink on the rendered page", async () => {
    const { runner } = scriptedRunner({
      pdfinfo: info({ Pages: "1", Encrypted: "no" }),
      pdftotext: pages(""),
    });
    const { ocr } = stubOcr({ 1: { hasInk: false, text: "" } });
    const parsed = await parser({ runner, ocr }).parse(INPUT, PDF_PARSE_LIMITS);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("SOURCE_EMPTY");
    expect(parsed.action).toBe("paste-text");
  });

  it("refuses a password protected document from either poppler tool", async () => {
    const refused = await parser({
      runner: scriptedRunner({
        pdfinfo: result({ code: 1, stderr: "Command Line Error: Incorrect password" }),
      }).runner,
      ocr: null,
    }).parse(INPUT, PDF_PARSE_LIMITS);
    expect(refused).toMatchObject({
      ok: false,
      code: "SOURCE_ENCRYPTED",
      action: "remove-pdf-protection",
    });

    const copyProtected = await parser({
      runner: scriptedRunner({
        pdfinfo: info({ Pages: "4", Encrypted: "yes (print:yes copy:no change:no)" }),
      }).runner,
      ocr: null,
    }).parse(INPUT, PDF_PARSE_LIMITS);
    expect(copyProtected).toMatchObject({ ok: false, code: "SOURCE_ENCRYPTED" });
  });

  it("reports an unreadable container as malformed rather than as an empty document", async () => {
    const parsed = await parser({
      runner: scriptedRunner({
        pdfinfo: result({ code: 1, stderr: "Syntax Error: Couldn't find trailer dictionary" }),
      }).runner,
      ocr: null,
    }).parse(INPUT, PDF_PARSE_LIMITS);
    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_MALFORMED", action: "upload-file" });
  });

  it("refuses a document past the hard page ceiling with a split instruction", async () => {
    const { runner, calls } = scriptedRunner({
      pdfinfo: info({ Pages: String(PDF_MAX_PAGES + 1), Encrypted: "no" }),
    });
    const parsed = await parser({ runner, ocr: null }).parse(INPUT, PDF_PARSE_LIMITS);

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_TOO_LARGE", action: "split-input" });
    // The refusal happens before any text is pulled out of the file.
    expect(calls).toEqual(["pdfinfo"]);
  });

  it("truncates a long document to the segment cap and says so in metadata", async () => {
    const limits = { ...PDF_PARSE_LIMITS, maxSegments: 3 };
    const { runner } = scriptedRunner({
      pdfinfo: info({ Pages: "40", Encrypted: "no" }),
      pdftotext: pages("Page one", "Page two", "Page three"),
    });
    const parsed = await parser({ runner, ocr: null }).parse(INPUT, limits);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.metadata).toMatchObject({ pageCount: 40, truncated: true });
  });

  it("stops at the character budget instead of returning the whole document", async () => {
    const limits = { ...PDF_PARSE_LIMITS, maxCharacters: 12 };
    const { runner } = scriptedRunner({
      pdfinfo: info({ Pages: "2", Encrypted: "no" }),
      pdftotext: pages("0123456789abcdef", "second page"),
    });
    const parsed = await parser({ runner, ocr: null }).parse(INPUT, limits);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.metadata.characterCount).toBe(12);
    expect(parsed.metadata.truncated).toBe(true);
  });

  it("refuses a file over the byte limit before spawning any tool", async () => {
    const { runner, calls } = scriptedRunner({ pdfinfo: info({ Pages: "1", Encrypted: "no" }) });
    const parsed = await parser({ runner, ocr: null }).parse(
      { ...INPUT, byteLength: PDF_PARSE_LIMITS.maxBytes + 1 },
      PDF_PARSE_LIMITS,
    );

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_TOO_LARGE" });
    expect(calls).toEqual([]);
  });

  it("caps OCR to its page budget and marks the rest as truncated", async () => {
    const pageCount = OCR_LIMITS.maxPages + 4;
    const { runner } = scriptedRunner({
      pdfinfo: info({ Pages: String(pageCount), Encrypted: "no" }),
      pdftotext: pages(...Array.from({ length: pageCount }, () => "")),
    });
    const outcomes: Record<number, { hasInk: boolean; text: string }> = {};
    for (let page = 1; page <= pageCount; page += 1) {
      outcomes[page] = { hasInk: true, text: `Scanned page ${page}` };
    }
    const { ocr, recognize } = stubOcr(outcomes);
    const parsed = await parser({ runner, ocr }).parse(INPUT, PDF_PARSE_LIMITS);

    expect(recognize).toHaveBeenCalledTimes(OCR_LIMITS.maxPages);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(OCR_LIMITS.maxPages);
    expect(parsed.metadata).toMatchObject({
      pageCount,
      ocrPageCount: OCR_LIMITS.maxPages,
      truncated: true,
    });
  });

  it("separates a timeout and a broken tool from a verdict about the document", async () => {
    const timedOut = await parser({
      runner: scriptedRunner({ pdfinfo: result({ code: null, timedOut: true }) }).runner,
      ocr: null,
    }).parse(INPUT, PDF_PARSE_LIMITS);
    expect(timedOut).toMatchObject({
      ok: false,
      code: "SOURCE_TIMEOUT",
      action: "retry-later",
    });

    const runner: CommandRunner = async () => {
      const { SourceToolError } = await import("../../src/server/sources/ocr");
      throw new SourceToolError("pdfinfo", "missing");
    };
    const broken = await parser({ runner, ocr: null }).parse(INPUT, PDF_PARSE_LIMITS);
    expect(broken).toMatchObject({
      ok: false,
      code: "SOURCE_UNAVAILABLE",
      action: "retry-later",
    });
  });

  it("never copies tool output or document text into the reported failure", async () => {
    const { runner } = scriptedRunner({
      pdfinfo: result({
        code: 1,
        stderr: "Syntax Error (12345): /Users/secret/Quarterly salary review.pdf is damaged",
      }),
    });
    const parsed = await parser({ runner, ocr: null }).parse(INPUT, PDF_PARSE_LIMITS);

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("salary");
    expect(serialized).not.toContain("orincard-fixture.pdf");
  });
});

describe("T040 grey raster ink detection", () => {
  function pgm(width: number, height: number, fill: (index: number) => number): Buffer {
    const samples = Buffer.alloc(width * height);
    for (let index = 0; index < samples.length; index += 1) samples[index] = fill(index);
    return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`, "latin1"), samples]);
  }

  it("parses the binary PGM header pdftoppm -gray writes", () => {
    const parsed = readGreyRaster(pgm(4, 3, () => 255));
    expect(parsed).toMatchObject({ width: 4, height: 3 });
    expect(parsed?.samples).toHaveLength(12);
    expect(readGreyRaster(Buffer.from("P6\n4 3\n255\n", "latin1"))).toBeUndefined();
    expect(readGreyRaster(Buffer.from("not an image", "latin1"))).toBeUndefined();
  });

  it("calls a fully white page blank and a page with marks inked", () => {
    expect(rasterHasInk(pgm(100, 100, () => 255))).toBe(false);
    // Fewer marks than the noise floor still counts as blank.
    expect(rasterHasInk(pgm(100, 100, (index) => (index < OCR_LIMITS.minInkPixels - 1 ? 0 : 255)))).toBe(
      false,
    );
    expect(rasterHasInk(pgm(100, 100, (index) => (index < 4_000 ? 12 : 255)))).toBe(true);
  });
});

describe("T040 tesseract page OCR", () => {
  it("does not spend a tesseract run on a page with no ink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orincard-ocr-test-"));
    const blank = Buffer.concat([
      Buffer.from("P5\n40 40\n255\n", "latin1"),
      Buffer.alloc(1_600, 255),
    ]);
    await writeFile(join(directory, "page.pgm"), blank);
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      return result();
    };

    const outcome = await createTesseractPageOcr({
      runner,
      makeTempDirectory: async () => directory,
    }).recognize({ filePath: INPUT.filePath, page: 1 });

    expect(outcome).toEqual({ page: 1, hasInk: false, text: "" });
    expect(calls).toEqual(["pdftoppm"]);
  });

  it("bounds the recognized text and normalizes the tesseract page break", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orincard-ocr-test-"));
    const inked = Buffer.concat([
      Buffer.from("P5\n40 40\n255\n", "latin1"),
      Buffer.alloc(1_600, 0),
    ]);
    await writeFile(join(directory, "page.pgm"), inked);
    const runner: CommandRunner = async (command) =>
      command === "pdftoppm"
        ? result()
        : result({ stdout: Buffer.from(`  first  line \n\n\n\nsecond\f`, "utf8") });

    const outcome = await createTesseractPageOcr({
      runner,
      makeTempDirectory: async () => directory,
    }).recognize({ filePath: INPUT.filePath, page: 3 });

    expect(outcome.hasInk).toBe(true);
    expect(outcome.text).toBe("first line\n\nsecond");
  });
});

// ---------------------------------------------------------------------------
// The live half. poppler and tesseract are installed by trigger.config.ts inside the
// worker container and by `brew install poppler tesseract tesseract-lang` on a
// development machine. docs/licenses/parsers.md requires that a missing executable makes
// this file fail with the name of what is missing: skipping would report a green run for
// a parser nobody actually exercised.
// ---------------------------------------------------------------------------

const live = process.env.ORINCARD_RUN_PDF_CLOUD === "1" ? describe : describe.skip;

function pdfDocument(objects: readonly (string | Buffer)[], trailerExtra = ""): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    const head = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    offsets.push(offset);
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const entry of offsets) xref += `${String(entry).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

// Fixtures are written at run time on purpose: B04 already paid for committing large
// binaries, and every shape below is a few hundred bytes of generated PDF syntax.
function textPdf(pageLines: readonly (readonly string[])[]): Buffer {
  const objects: (string | Buffer)[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    "",
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  const pageIds: number[] = [];
  pageLines.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    pageIds.push(pageId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    const stream = `BT /F1 24 Tf 72 700 Td 30 TL\n${lines
      .map((line) => `(${line}) Tj T*`)
      .join("\n")}\nET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects[1] = `<< /Type /Pages /Count ${pageLines.length} /Kids [${pageIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] >>`;
  return pdfDocument(objects);
}

function emptyPagePdf(): Buffer {
  return pdfDocument([
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>`,
    `<< /Length 0 >>\nstream\n\nendstream`,
  ]);
}

// A standard security handler dictionary with a user password we do not know. poppler
// tries the empty password, fails the check and stops — the same path a real protected
// upload takes, without needing qpdf, which is not a development machine prerequisite.
function encryptedPdf(): Buffer {
  return pdfDocument(
    [
      `<< /Type /Catalog /Pages 2 0 R >>`,
      `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>`,
      `<< /Length 0 >>\nstream\n\nendstream`,
      `<< /Filter /Standard /V 1 /R 2 /P -1 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`,
    ],
    `/Encrypt 5 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>] `,
  );
}

// A scan is built by rendering a text PDF to a grey raster and wrapping that raster back
// into a PDF as an image. The result carries no text layer at all, which is exactly the
// shape OCR exists for.
async function scannedPdf(directory: string, source: Buffer): Promise<Buffer> {
  const sourcePath = join(directory, "scan-source.pdf");
  await writeFile(sourcePath, source);
  const prefix = join(directory, "scan-render");
  const render = await runCommand(
    "pdftoppm",
    ["-gray", "-r", "150", "-f", "1", "-l", "1", "-singlefile", sourcePath, prefix],
    { timeoutMs: 60_000 },
  );
  expect(render.code).toBe(0);
  const raster = await readFile(`${prefix}.pgm`);
  const parsed = readGreyRaster(raster);
  expect(parsed).toBeDefined();
  const compressed = deflateSync(parsed!.samples, { level: 9 });
  const content = `q 612 0 0 792 0 0 cm /Im0 Do Q`;
  return pdfDocument([
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Count 1 /Kids [3 0 R] >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${parsed!.width} /Height ${parsed!.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
        "latin1",
      ),
      compressed,
      Buffer.from("\nendstream", "latin1"),
    ]),
  ]);
}

live("T040 real poppler and tesseract PDF parsing", () => {
  let directory = "";

  beforeAll(async () => {
    const missing = await missingPdfExecutables();
    if (missing.length > 0) {
      throw new Error(
        `ORINCARD_RUN_PDF_CLOUD=1 requires these executables on PATH: ${missing.join(", ")}. ` +
          `Install them with "brew install poppler tesseract tesseract-lang" (expected: ${PDF_EXECUTABLES.join(", ")}).`,
      );
    }
    directory = await mkdtemp(join(tmpdir(), "orincard-pdf-fixture-"));
  }, 60_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fixture(name: string, bytes: Buffer): Promise<PdfParseInput> {
    const filePath = join(directory, name);
    await writeFile(filePath, bytes);
    return { filePath, byteLength: bytes.byteLength };
  }

  it("reads a real text layer page by page", async () => {
    const input = await fixture(
      "text.pdf",
      textPdf([
        ["Orincard text layer page one", "Second line of the page"],
        ["Page two of the same document"],
      ]),
    );
    const parsed = await createPdfSourceParser().parse(input, PDF_PARSE_LIMITS);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.text).toContain("Orincard text layer page one");
    expect(parsed.segments[1]?.locator).toEqual({ kind: "page", page: 2 });
    expect(parsed.metadata.pageCount).toBe(2);
    expect(parsed.metadata.ocrPageCount).toBeUndefined();
  }, 60_000);

  it("recovers a scan through OCR and records how many pages it cost", async () => {
    const input = await fixture(
      "scanned.pdf",
      await scannedPdf(directory, textPdf([["Orincard scanned page", "Optical character recovery"]])),
    );
    // Without OCR the same file has to fail rather than come back as an empty success.
    const withoutOcr = await createPdfSourceParser({ ocr: null }).parse(input, PDF_PARSE_LIMITS);
    expect(withoutOcr).toMatchObject({ ok: false, code: "SOURCE_NO_TEXT_LAYER" });

    const parsed = await createPdfSourceParser().parse(input, PDF_PARSE_LIMITS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments[0]?.text.toLowerCase()).toContain("orincard");
    expect(parsed.metadata.ocrPageCount).toBe(1);
    expect(parsed.metadata.pageCount).toBe(1);
  }, 180_000);

  it("reports a page with nothing on it as empty, not as an unreadable scan", async () => {
    const input = await fixture("blank.pdf", emptyPagePdf());
    const parsed = await createPdfSourceParser().parse(input, PDF_PARSE_LIMITS);

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_EMPTY", action: "paste-text" });
  }, 120_000);

  it("refuses a password protected document from real poppler", async () => {
    const input = await fixture("encrypted.pdf", encryptedPdf());
    const parsed = await createPdfSourceParser().parse(input, PDF_PARSE_LIMITS);

    expect(parsed).toMatchObject({
      ok: false,
      code: "SOURCE_ENCRYPTED",
      action: "remove-pdf-protection",
    });
  }, 60_000);

  it("keeps the leading pages of an over-long document and flags the truncation", async () => {
    const pageCount = 12;
    const input = await fixture(
      "many.pdf",
      textPdf(Array.from({ length: pageCount }, (_, index) => [`Page number ${index + 1} content`])),
    );
    const parsed = await createPdfSourceParser().parse(input, {
      ...PDF_PARSE_LIMITS,
      maxSegments: 4,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(4);
    expect(parsed.segments[3]?.text).toContain("Page number 4");
    expect(parsed.metadata).toMatchObject({ pageCount, truncated: true });
  }, 120_000);
});
