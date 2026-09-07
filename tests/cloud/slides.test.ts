import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  ArchiveError,
  ZIP_LIMITS,
  openArchive,
  parseRestrictedXml,
  readZipDirectory,
} from "../../src/server/sources/archive";
import {
  SLIDES_PARSE_LIMITS,
  createSlidesSourceParser,
  readPresentation,
} from "../../src/server/sources/slides";

const RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

let sequence = 0;
const parser = () =>
  createSlidesSourceParser({ createId: () => `segment-${(sequence += 1)}` });

// Every fixture is generated here with the jszip that is already a dependency. Nothing
// binary is committed: a .pptx is a few kilobytes of XML that is cheaper to write than to
// store, and B04 already paid for putting large binaries in the repository.
interface DeckSlide {
  readonly paragraphs?: readonly (readonly string[])[];
  readonly images?: readonly { readonly name: string; readonly bytes: number }[];
  readonly externalImage?: string;
  readonly xml?: string;
}

interface DeckOptions {
  readonly slides: readonly DeckSlide[];
  readonly title?: string;
  // Written into p:sldIdLst so the reader has to honour the declared order rather than
  // the order the parts happen to sit in inside the ZIP.
  readonly order?: readonly number[];
  readonly extraFiles?: Readonly<Record<string, string | Buffer>>;
  readonly omit?: readonly string[];
  readonly presentationRels?: string;
}

function slideXml(paragraphs: readonly (readonly string[])[]): string {
  const shapes = paragraphs
    .map(
      (runs, index) => `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Text ${index + 1}"/></p:nvSpPr><p:txBody><a:bodyPr/>` +
        `<a:p>${runs.map((run) => `<a:r><a:rPr lang="en-US"/><a:t>${run}</a:t></a:r>`).join("")}</a:p></p:txBody></p:sp>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
}

async function deck(options: DeckOptions): Promise<Buffer> {
  const zip = new JSZip();
  const count = options.slides.length;
  const order = options.order ?? options.slides.map((_, index) => index + 1);
  const omit = new Set(options.omit ?? []);

  const add = (path: string, content: string | Buffer) => {
    if (!omit.has(path)) zip.file(path, content);
  };

  add(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
  );
  add(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  add(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${options.title ?? "Untitled deck"}</dc:title></cp:coreProperties>`,
  );
  add(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${RELATIONSHIP_NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${order
      .map((slide, index) => `<p:sldId id="${256 + index}" r:id="rId${slide}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
  );
  add(
    "ppt/_rels/presentation.xml.rels",
    options.presentationRels ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from(
        { length: count },
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIP_NS}/slide" Target="slides/slide${index + 1}.xml"/>`,
      ).join("")}</Relationships>`,
  );

  options.slides.forEach((slide, index) => {
    const number = index + 1;
    add(`ppt/slides/slide${number}.xml`, slide.xml ?? slideXml(slide.paragraphs ?? []));
    const relationships: string[] = [];
    (slide.images ?? []).forEach((image, imageIndex) => {
      zip.file(`ppt/media/${image.name}`, Buffer.alloc(image.bytes, 0x21 + imageIndex));
      relationships.push(
        `<Relationship Id="rId${imageIndex + 1}" Type="${RELATIONSHIP_NS}/image" Target="../media/${image.name}"/>`,
      );
    });
    if (slide.externalImage) {
      relationships.push(
        `<Relationship Id="rIdExternal" Type="${RELATIONSHIP_NS}/image" Target="${slide.externalImage}" TargetMode="External"/>`,
      );
    }
    if (relationships.length > 0) {
      add(
        `ppt/slides/_rels/slide${number}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`,
      );
    }
  });

  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("T041 restricted zip reader", () => {
  it("reads the central directory of a real archive without inflating it", async () => {
    const bytes = await deck({ slides: [{ paragraphs: [["Hello"]] }] });
    const entries = readZipDirectory(bytes);

    expect(entries.map((entry) => entry.path)).toContain("ppt/presentation.xml");
    expect(entries.every((entry) => entry.bytes >= 0)).toBe(true);
  });

  it("refuses a zip bomb on the declared size before anything is expanded", async () => {
    const zip = new JSZip();
    // 40 MB of one repeated byte deflates to a few kilobytes: the classic bomb shape.
    zip.file("bomb.bin", Buffer.alloc(40 * 1_024 * 1_024, 0));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    expect(bytes.byteLength).toBeLessThan(1_024 * 1_024);
    expect(() => readZipDirectory(bytes)).toThrowError(ArchiveError);
    try {
      readZipDirectory(bytes);
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_TOO_LARGE", reason: "entry-too-large" });
    }
  });

  it("refuses an archive that expands past the total budget across many members", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 12; index += 1) {
      zip.file(`part${index}.bin`, Buffer.alloc(1_024 * 1_024, 0));
    }
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const limits = { ...ZIP_LIMITS, maxTotalBytes: 4 * 1_024 * 1_024, maxEntryBytes: 8 * 1_024 * 1_024 };

    try {
      readZipDirectory(bytes, limits);
      expect.unreachable("the archive should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_TOO_LARGE" });
    }
  });

  it("refuses an entry whose compression ratio can only be a bomb", async () => {
    const zip = new JSZip();
    zip.file("run.bin", Buffer.alloc(2 * 1_024 * 1_024, 0));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const limits = { ...ZIP_LIMITS, maxEntryBytes: 64 * 1_024 * 1_024, maxTotalBytes: 64 * 1_024 * 1_024 };

    try {
      readZipDirectory(bytes, limits);
      expect.unreachable("the archive should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_TOO_LARGE", reason: "compression-ratio" });
    }
  });

  it("refuses a member whose name climbs out of the archive", async () => {
    for (const name of ["../escape.xml", "/etc/passwd", "ppt/../../escape.xml", "C:/escape.xml"]) {
      const zip = new JSZip();
      zip.file(name, "x");
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      try {
        readZipDirectory(bytes);
        expect.unreachable(`${name} should have been refused`);
      } catch (error) {
        expect(error).toMatchObject({ code: "SOURCE_MALFORMED", reason: "path-traversal" });
      }
    }
  });

  it("refuses something that is not a zip at all", async () => {
    try {
      readZipDirectory(Buffer.from("<html>not a deck</html>", "utf8"));
      expect.unreachable("a non-archive should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_UNSUPPORTED_FORMAT", reason: "not-a-zip" });
    }
  });

  it("reads a member back and checks it against the size the directory declared", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hello deck");
    const archive = await openArchive(await zip.generateAsync({ type: "nodebuffer" }));

    await expect(archive.readText("hello.txt")).resolves.toBe("hello deck");
    await expect(archive.readText("missing.txt")).rejects.toMatchObject({
      reason: "missing-entry",
    });
  });
});

describe("T041 restricted XML reader", () => {
  it("reads elements, attributes and text without any entity machinery", () => {
    const root = parseRestrictedXml(
      `<?xml version="1.0"?><a:root xmlns:a="urn:x"><a:t id="1">A &amp; B</a:t><a:t>&#65;</a:t></a:root>`,
    );
    expect(root.name).toBe("a:root");
    expect(root.children.map((child) => child.text)).toEqual(["A & B", "A"]);
    expect(root.children[0]?.attributes.id).toBe("1");
  });

  it("refuses a document type declaration outright, which is where XXE has to live", () => {
    const xxe =
      `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><t>&xxe;</t>`;
    expect(() => parseRestrictedXml(xxe)).toThrowError(ArchiveError);
    try {
      parseRestrictedXml(xxe);
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_MALFORMED", reason: "xml-doctype" });
    }
  });

  it("refuses a billion laughs expansion before it can be expanded", () => {
    const laughs =
      `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
    try {
      parseRestrictedXml(laughs);
      expect.unreachable("the expansion should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ reason: "xml-doctype" });
    }
  });

  it("refuses an undeclared entity reference and a stylesheet instruction", () => {
    try {
      parseRestrictedXml(`<t>&secret;</t>`);
      expect.unreachable("an unknown entity should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ reason: "xml-entity" });
    }
    try {
      parseRestrictedXml(`<?xml version="1.0"?><?xml-stylesheet href="http://evil.test/x.xsl"?><t>a</t>`);
      expect.unreachable("an external instruction should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ reason: "xml-processing-instruction" });
    }
  });

  it("bounds nesting depth and element count", () => {
    const deep = `${"<a>".repeat(300)}x${"</a>".repeat(300)}`;
    try {
      parseRestrictedXml(deep);
      expect.unreachable("a deep document should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_TOO_LARGE", reason: "xml-too-deep" });
    }
    try {
      parseRestrictedXml(`<r>${"<a/>".repeat(50)}</r>`, {
        maxBytes: 1_024 * 1_024,
        maxDepth: 8,
        maxElements: 10,
      });
      expect.unreachable("too many elements should have been refused");
    } catch (error) {
      expect(error).toMatchObject({ reason: "xml-too-large" });
    }
  });

  it("refuses a mismatched or unterminated tag rather than guessing", () => {
    expect(() => parseRestrictedXml("<a><b></a></b>")).toThrowError(ArchiveError);
    expect(() => parseRestrictedXml("<a>text")).toThrowError(ArchiveError);
  });
});

describe("T041 PPTX source parser", () => {
  it("keeps the declared slide order, not the order of the parts in the zip", async () => {
    const bytes = await deck({
      title: "Quarter review",
      slides: [
        { paragraphs: [["First slide title"]] },
        { paragraphs: [["Second slide title"]] },
        { paragraphs: [["Third slide title"]] },
      ],
      // PowerPoint reorders by rewriting this list; slide3.xml genuinely comes first.
      order: [3, 1, 2],
    });

    const presentation = await readPresentation(bytes);
    expect(presentation.slides.map((slide) => slide.part)).toEqual([
      "ppt/slides/slide3.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
    ]);

    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments.map((segment) => segment.text)).toEqual([
      "Third slide title",
      "First slide title",
      "Second slide title",
    ]);
    expect(parsed.segments.map((segment) => segment.locator)).toEqual([
      { kind: "slide", slide: 1 },
      { kind: "slide", slide: 2 },
      { kind: "slide", slide: 3 },
    ]);
    expect(parsed.metadata).toMatchObject({ slideCount: 3, title: "Quarter review" });
  });

  it("joins the runs of a paragraph and keeps paragraphs on separate lines", async () => {
    const bytes = await deck({
      slides: [{ paragraphs: [["Split ", "across ", "runs"], ["A second paragraph"]] }],
    });
    const presentation = await readPresentation(bytes);

    expect(presentation.slides[0]?.paragraphs).toEqual([
      "Split across runs",
      "A second paragraph",
    ]);
    expect(presentation.slides[0]?.text).toBe("Split across runs\nA second paragraph");
  });

  it("keeps the pictures a slide references alongside its text", async () => {
    const bytes = await deck({
      slides: [
        {
          paragraphs: [["Slide with art"]],
          images: [
            { name: "image1.png", bytes: 512 },
            { name: "image2.png", bytes: 1_024 },
          ],
        },
      ],
    });
    const presentation = await readPresentation(bytes);

    expect(presentation.slides[0]?.images).toEqual([
      { path: "ppt/media/image1.png", bytes: 512, mediaType: "image/png" },
      { path: "ppt/media/image2.png", bytes: 1_024, mediaType: "image/png" },
    ]);
  });

  it("never resolves or fetches an externally linked picture", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bytes = await deck({
      slides: [
        {
          paragraphs: [["Slide with a remote picture"]],
          images: [{ name: "image1.png", bytes: 64 }],
          externalImage: "https://evil.test/tracker.png",
        },
      ],
    });
    const presentation = await readPresentation(bytes);

    expect(presentation.externalReferences).toBe(1);
    // The external target is counted and then dropped: it is not in the retained media
    // and nothing on this path is allowed to go to the network.
    expect(presentation.slides[0]?.images).toEqual([
      { path: "ppt/media/image1.png", bytes: 64, mediaType: "image/png" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a deck whose slide list points at another machine", async () => {
    const bytes = await deck({
      slides: [{ paragraphs: [["Local slide"]] }],
      presentationRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/slide" Target="https://evil.test/slide1.xml" TargetMode="External"/></Relationships>`,
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_MALFORMED" });
  });

  it("refuses a relationship target that climbs out of the package", async () => {
    const bytes = await deck({
      slides: [{ paragraphs: [["Local slide"]] }],
      presentationRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIP_NS}/slide" Target="../../../etc/passwd"/></Relationships>`,
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_MALFORMED" });
  });

  it("refuses a slide part carrying an XXE payload instead of reading around it", async () => {
    const bytes = await deck({
      slides: [
        {
          xml: `<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><p:sld xmlns:a="urn:a" xmlns:p="urn:p"><a:p><a:r><a:t>&xxe;</a:t></a:r></a:p></p:sld>`,
        },
      ],
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_MALFORMED", action: "upload-file" });
  });

  it("gives a Keynote file a conversion instruction rather than a parse error", async () => {
    const zip = new JSZip();
    zip.file("index.apxl", "<keynote/>");
    zip.file("Metadata/DocumentIdentifier", "0000");
    const parsed = await parser().parse(
      { data: await zip.generateAsync({ type: "nodebuffer" }) },
      SLIDES_PARSE_LIMITS,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("SOURCE_UNSUPPORTED_FORMAT");
    expect(parsed.action).toBe("convert-to-pptx");
    expect(parsed.message).toContain("Keynote");
    expect(parsed.message).toContain(".pptx");
  });

  it("names the format in the instruction for .ppt and OpenDocument decks", async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    const oldFormat = await parser().parse({ data: ole }, SLIDES_PARSE_LIMITS);
    expect(oldFormat).toMatchObject({ ok: false, code: "SOURCE_UNSUPPORTED_FORMAT" });
    if (!oldFormat.ok) expect(oldFormat.message).toContain(".ppt");

    const zip = new JSZip();
    zip.file("mimetype", "application/vnd.oasis.opendocument.presentation");
    zip.file("content.xml", "<office/>");
    const openDocument = await parser().parse(
      { data: await zip.generateAsync({ type: "nodebuffer" }) },
      SLIDES_PARSE_LIMITS,
    );
    expect(openDocument).toMatchObject({
      ok: false,
      code: "SOURCE_UNSUPPORTED_FORMAT",
      action: "convert-to-pptx",
    });
  });

  it("refuses a deck of pictures with no text instead of accepting an empty source", async () => {
    const bytes = await deck({
      slides: [
        { images: [{ name: "image1.png", bytes: 128 }] },
        { paragraphs: [[" "], ["   "]] },
      ],
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    // AC-002 again: nothing readable means a typed failure with a next step.
    expect(parsed).toMatchObject({
      ok: false,
      code: "SOURCE_NO_TEXT_LAYER",
      action: "paste-text",
    });
  });

  it("keeps the slide numbering true when a picture-only slide sits in the middle", async () => {
    const bytes = await deck({
      slides: [
        { paragraphs: [["Opening"]] },
        { images: [{ name: "image1.png", bytes: 64 }] },
        { paragraphs: [["Closing"]] },
      ],
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments.map((segment) => segment.locator)).toEqual([
      { kind: "slide", slide: 1 },
      { kind: "slide", slide: 3 },
    ]);
    expect(parsed.metadata.slideCount).toBe(3);
  });

  it("truncates a deck past the segment cap and says so", async () => {
    const bytes = await deck({
      slides: Array.from({ length: 6 }, (_, index) => ({
        paragraphs: [[`Slide ${index + 1}`]],
      })),
    });
    const parsed = await parser().parse(
      { data: bytes },
      { ...SLIDES_PARSE_LIMITS, maxSegments: 2 },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.metadata).toMatchObject({ slideCount: 6, truncated: true });
  });

  it("refuses a package with a missing part rather than importing a partial deck", async () => {
    const bytes = await deck({
      slides: [{ paragraphs: [["Only slide"]] }],
      omit: ["ppt/slides/slide1.xml"],
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_MALFORMED" });
  });

  it("refuses a file over the size limit before opening the archive", async () => {
    const parsed = await parser().parse(
      { data: Buffer.alloc(64) },
      { ...SLIDES_PARSE_LIMITS, maxBytes: 32 },
    );
    expect(parsed).toMatchObject({ ok: false, code: "SOURCE_TOO_LARGE" });
  });

  it("never copies slide text or a member name into the reported failure", async () => {
    const bytes = await deck({
      slides: [
        {
          xml: `<?xml version="1.0"?><!DOCTYPE p:sld><p:sld xmlns:a="urn:a" xmlns:p="urn:p"><a:p><a:r><a:t>Confidential salary table</a:t></a:r></a:p></p:sld>`,
        },
      ],
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("Confidential");
    expect(serialized).not.toContain("slide1.xml");
  });
});

// This file needs no credentials and no system tool: a .pptx is a ZIP of XML and both
// halves are built here. The switch stays for symmetry with the other cloud suites, and
// guards the one case that costs real time — a full size deck.
const live = process.env.ORINCARD_RUN_SLIDES_CLOUD === "1" ? describe : describe.skip;

live("T041 full size deck", () => {
  it("parses a two hundred slide deck within the segment cap", async () => {
    const bytes = await deck({
      slides: Array.from({ length: 200 }, (_, index) => ({
        paragraphs: [[`Slide ${index + 1} heading`], [`Body copy for slide ${index + 1}`]],
        images: index % 3 === 0 ? [{ name: `image${index + 1}.png`, bytes: 2_048 }] : [],
      })),
    });
    const parsed = await parser().parse({ data: bytes }, SLIDES_PARSE_LIMITS);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.segments).toHaveLength(200);
    expect(parsed.metadata.slideCount).toBe(200);
    expect(parsed.metadata.truncated).toBeUndefined();
  }, 120_000);
});
