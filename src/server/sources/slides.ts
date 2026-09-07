import { randomUUID } from "node:crypto";
import {
  ArchiveError,
  XML_LIMITS,
  ZIP_LIMITS,
  findElements,
  openArchive,
  parseRestrictedXml,
  type ArchiveReader,
  type XmlElement,
  type XmlLimits,
  type ZipLimits,
} from "./archive";
import {
  sourceParseFailure,
  sourceParseResult,
  type SourceParseLimits,
  type SourceParseResult,
  type SourceParser,
  type SourceSegment,
} from "./index";

// T041. A .pptx is an OPC package: a ZIP holding XML parts wired together by relationship
// files. This module reads it through archive.ts, which is the only thing allowed to
// touch the untrusted bytes, and turns it into ordered slide text plus the media each
// slide keeps.
//
// Slide order comes from p:sldIdLst in presentation.xml, not from the file names inside
// the ZIP: PowerPoint reorders slides by rewriting that list and leaves slide7.xml sitting
// in second position. Reading the directory listing instead would silently reorder a deck.

export const SLIDES_PARSE_LIMITS: SourceParseLimits = {
  maxBytes: 32 * 1_024 * 1_024,
  maxSegments: 200,
  maxCharacters: 400_000,
  timeoutMs: 60_000,
};

export const SLIDES_MAX_TEXT_PER_SLIDE = 20_000;

const PRESENTATION_PART = "ppt/presentation.xml";
const PRESENTATION_RELS = "ppt/_rels/presentation.xml.rels";
const CONTENT_TYPES = "[Content_Types].xml";
const CORE_PROPERTIES = "docProps/core.xml";
const SLIDE_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const IMAGE_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  webp: "image/webp",
  emf: "image/emf",
  wmf: "image/wmf",
};

export interface SlidesParseInput {
  readonly data: Buffer;
  readonly fileName?: string;
  readonly title?: string;
}

export interface SlideImage {
  readonly path: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface ParsedSlide {
  readonly slide: number;
  readonly part: string;
  readonly paragraphs: readonly string[];
  readonly text: string;
  readonly images: readonly SlideImage[];
}

export interface ParsedPresentation {
  readonly title?: string;
  readonly slides: readonly ParsedSlide[];
  readonly slideCount: number;
  readonly truncated: boolean;
  // Relationship targets that point outside the package. They are counted so a caller can
  // see they existed, and are never resolved, fetched or turned into a slide part.
  readonly externalReferences: number;
}

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

function normalizePartPath(base: string, target: string): string | undefined {
  const absolute = target.startsWith("/");
  const parts = (absolute ? target.slice(1) : `${base}/${target}`).split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // A relationship may legitimately climb one directory (../media/image1.png), but
      // never past the package root.
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.length > 0 ? stack.join("/") : undefined;
}

// A target is only a part of this package when it is a relative path inside it. A URL, a
// UNC share or anything with a scheme is a pointer at another machine and is dropped
// before it can be read.
function isExternalTarget(target: string, mode: string | undefined): boolean {
  if (mode === "External") return true;
  if (target.startsWith("//") || target.startsWith("\\\\")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

async function readRelationships(
  archive: ArchiveReader,
  path: string,
  xmlLimits: XmlLimits,
): Promise<{ readonly map: Map<string, Relationship>; readonly external: number }> {
  const map = new Map<string, Relationship>();
  if (!archive.has(path)) return { map, external: 0 };
  const root = parseRestrictedXml(await archive.readText(path), xmlLimits);
  let external = 0;
  for (const node of findElements(root, "Relationship")) {
    const id = node.attributes.Id;
    const target = node.attributes.Target;
    const type = node.attributes.Type ?? "";
    if (!id || !target) continue;
    const isExternal = isExternalTarget(target, node.attributes.TargetMode);
    if (isExternal) external += 1;
    map.set(id, { id, type, target, external: isExternal });
  }
  return { map, external };
}

function slideText(root: XmlElement): string[] {
  const paragraphs: string[] = [];
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (child.name === "a:p") {
        // a:t holds the run text, a:br a manual line break inside one paragraph.
        const line = collectRuns(child).replace(/[ \t]+/g, " ").trim();
        if (line.length > 0) paragraphs.push(line);
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return paragraphs;
}

function collectRuns(paragraph: XmlElement): string {
  let text = "";
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (child.name === "a:t") {
        text += child.text;
        continue;
      }
      if (child.name === "a:br") {
        text += "\n";
        continue;
      }
      walk(child);
    }
  };
  walk(paragraph);
  return text;
}

function mediaTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MEDIA_TYPES[extension] ?? "application/octet-stream";
}

function unsupportedDeck(reason: string): never {
  throw new UnsupportedDeckError(reason);
}

// Separate from ArchiveError because the answer is different: the container was read fine,
// it just is not a .pptx, and the user needs a conversion instruction rather than a
// smaller or repaired file.
export class UnsupportedDeckError extends Error {
  constructor(readonly instruction: string) {
    super("unsupported presentation format");
    this.name = "UnsupportedDeckError";
  }
}

function rejectForeignFormat(entries: readonly { path: string }[]): void {
  const paths = new Set(entries.map((entry) => entry.path));
  const hasPrefix = (prefix: string) =>
    entries.some((entry) => entry.path.startsWith(prefix));
  if (
    paths.has("index.apxl") ||
    paths.has("index.apxl.gz") ||
    paths.has("Metadata/DocumentIdentifier") ||
    hasPrefix("Index/")
  ) {
    unsupportedDeck("Keynote files can't be imported. Export the deck as .pptx and try again.");
  }
  if (paths.has("mimetype") || paths.has("content.xml")) {
    unsupportedDeck(
      "OpenDocument presentations can't be imported. Export the deck as .pptx and try again.",
    );
  }
  if (!paths.has(CONTENT_TYPES) || !paths.has(PRESENTATION_PART)) {
    unsupportedDeck("This file isn't a PowerPoint deck. Convert it to .pptx and try again.");
  }
}

export async function readPresentation(
  data: Buffer,
  limits: SourceParseLimits = SLIDES_PARSE_LIMITS,
  containers: { readonly zip?: ZipLimits; readonly xml?: XmlLimits } = {},
): Promise<ParsedPresentation> {
  const zipLimits = containers.zip ?? { ...ZIP_LIMITS, maxArchiveBytes: limits.maxBytes };
  const xmlLimits = containers.xml ?? XML_LIMITS;

  // The old binary .ppt is an OLE compound file, not a ZIP, so it never reaches the
  // archive reader and would otherwise surface as "not a zip".
  if (data.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    unsupportedDeck("The .ppt format can't be imported. Save the deck as .pptx and try again.");
  }

  const archive = await openArchive(data, zipLimits);
  rejectForeignFormat(archive.entries);

  const presentation = parseRestrictedXml(await archive.readText(PRESENTATION_PART), xmlLimits);
  const { map: relationships, external } = await readRelationships(
    archive,
    PRESENTATION_RELS,
    xmlLimits,
  );

  const order = findElements(presentation, "p:sldId")
    .map((node) => node.attributes["r:id"])
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const parts: string[] = [];
  for (const id of order) {
    const relationship = relationships.get(id);
    if (!relationship || relationship.type !== SLIDE_RELATIONSHIP) continue;
    if (relationship.external) {
      // A slide that lives somewhere else is not a deck we can read, and following the
      // link is exactly what this parser must never do.
      throw new ArchiveError("SOURCE_MALFORMED", "path-traversal");
    }
    const part = normalizePartPath("ppt", relationship.target);
    if (!part || !archive.has(part)) {
      throw new ArchiveError("SOURCE_MALFORMED", "missing-entry");
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    unsupportedDeck("This deck has no slides to import. Check the file and upload it again.");
  }

  const slideCount = parts.length;
  const kept = parts.slice(0, limits.maxSegments);
  let externalReferences = external;
  const slides: ParsedSlide[] = [];

  for (const [index, part] of kept.entries()) {
    const root = parseRestrictedXml(await archive.readText(part), xmlLimits);
    const paragraphs = slideText(root);
    const directory = part.slice(0, part.lastIndexOf("/"));
    const name = part.slice(part.lastIndexOf("/") + 1);
    const slideRels = await readRelationships(
      archive,
      `${directory}/_rels/${name}.rels`,
      xmlLimits,
    );
    externalReferences += slideRels.external;

    const images: SlideImage[] = [];
    for (const relationship of slideRels.map.values()) {
      if (relationship.type !== IMAGE_RELATIONSHIP || relationship.external) continue;
      const target = normalizePartPath(directory, relationship.target);
      const entry = target ? archive.entry(target) : undefined;
      if (!entry || entry.directory) continue;
      images.push({ path: target!, bytes: entry.bytes, mediaType: mediaTypeFor(target!) });
    }

    const text = Array.from(paragraphs.join("\n"))
      .slice(0, SLIDES_MAX_TEXT_PER_SLIDE)
      .join("");
    slides.push({ slide: index + 1, part, paragraphs, text, images });
  }

  let title: string | undefined;
  if (archive.has(CORE_PROPERTIES)) {
    const core = parseRestrictedXml(await archive.readText(CORE_PROPERTIES), xmlLimits);
    const value = findElements(core, "dc:title")[0]?.text.trim();
    if (value) title = value;
  }

  return {
    title,
    slides,
    slideCount,
    truncated: kept.length < slideCount,
    externalReferences,
  };
}

export function createSlidesSourceParser(
  options: { readonly createId?: () => string } = {},
): SourceParser<SlidesParseInput> {
  const createId = options.createId ?? randomUUID;

  return {
    kind: "slides",
    async parse(input, limits = SLIDES_PARSE_LIMITS): Promise<SourceParseResult> {
      if (input.data.byteLength > limits.maxBytes) {
        return sourceParseFailure("SOURCE_TOO_LARGE");
      }
      let presentation: ParsedPresentation;
      try {
        presentation = await readPresentation(input.data, limits);
      } catch (error) {
        if (error instanceof UnsupportedDeckError) {
          return sourceParseFailure("SOURCE_UNSUPPORTED_FORMAT", {
            action: "convert-to-pptx",
            message: error.instruction,
          });
        }
        if (error instanceof ArchiveError) return sourceParseFailure(error.code);
        throw error;
      }

      let characterBudget = limits.maxCharacters;
      let truncated = presentation.truncated;
      const segments: SourceSegment[] = [];
      for (const slide of presentation.slides) {
        if (slide.text.trim().length === 0) continue;
        if (characterBudget <= 0) {
          truncated = true;
          break;
        }
        const characters = Array.from(slide.text);
        if (characters.length > characterBudget) truncated = true;
        const text = characters.slice(0, characterBudget).join("");
        characterBudget -= Math.min(characters.length, characterBudget);
        // The locator carries the slide's position in the deck, so a slide that holds
        // only a picture still leaves the numbering of the ones around it correct.
        segments.push({
          segmentId: createId(),
          text,
          locator: { kind: "slide", slide: slide.slide },
        });
      }

      return sourceParseResult(
        segments,
        {
          title: input.title ?? presentation.title,
          slideCount: presentation.slideCount,
          ...(truncated ? { truncated: true } : {}),
        },
        // A deck of nothing but pictures has no text to generate from. It fails with the
        // paste-the-text alternative rather than arriving as an accepted empty source.
        "SOURCE_NO_TEXT_LAYER",
      );
    },
  };
}
