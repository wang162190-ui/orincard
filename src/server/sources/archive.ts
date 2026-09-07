import JSZip from "jszip";
import type { SourceParseFailureCode } from "./index";

// T041. Everything in this module reads a container that a stranger uploaded, so it is
// written to distrust its input twice over.
//
// The ZIP side never asks a decompressor how big an entry is: it reads the central
// directory itself, applies the entry, size and ratio caps against the *declared* sizes,
// and only then hands the entries it accepted to jszip for inflation. A zip bomb is
// therefore refused before a single byte is expanded.
//
// The XML side is a hand written reader rather than a parser dependency. PPTX needs
// elements, attributes and text and nothing else, so there is no entity expansion, no
// DTD, no external subset and no resolver in the code at all — XXE has no surface here
// rather than a mitigation. docs/licenses/parsers.md records the same decision.

export type ArchiveRejection =
  | "not-a-zip"
  | "malformed-directory"
  | "zip64"
  | "encrypted-entry"
  | "unsupported-method"
  | "too-many-entries"
  | "entry-too-large"
  | "archive-too-large"
  | "compression-ratio"
  | "path-traversal"
  | "size-mismatch"
  | "missing-entry"
  | "xml-doctype"
  | "xml-entity"
  | "xml-processing-instruction"
  | "xml-too-deep"
  | "xml-too-large"
  | "xml-malformed";

// The reason is a fixed identifier, never a fragment of the file: it is safe to log and
// safe to put in a Trigger payload.
export class ArchiveError extends Error {
  constructor(
    readonly code: SourceParseFailureCode,
    readonly reason: ArchiveRejection,
  ) {
    super(`archive rejected: ${reason}`);
    this.name = "ArchiveError";
  }
}

export interface ZipLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxEntryBytes: number;
  readonly maxCompressionRatio: number;
}

export const ZIP_LIMITS: ZipLimits = {
  // A deck this large is already refused upstream by the upload limits; the cap is here
  // so this module is safe on its own.
  maxArchiveBytes: 32 * 1_024 * 1_024,
  // A 200 slide deck with layouts, masters, themes, notes and media stays well under it.
  maxEntries: 2_048,
  // What the whole archive is allowed to become once expanded.
  maxTotalBytes: 128 * 1_024 * 1_024,
  // What any single member is allowed to become once expanded.
  maxEntryBytes: 32 * 1_024 * 1_024,
  // Deflate reaches about 1000:1 on a run of identical bytes, which is exactly the shape
  // of a zip bomb. Real slide XML and media stay far below this.
  maxCompressionRatio: 200,
};

export interface ArchiveEntry {
  readonly path: string;
  readonly bytes: number;
  readonly compressedBytes: number;
  readonly directory: boolean;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_END_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;

function isUnsafePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.includes("\\") || path.includes("\0")) return true;
  if (path.startsWith("/")) return true;
  // A Windows drive or UNC prefix is as absolute as a leading slash.
  if (/^[a-zA-Z]:/.test(path)) return true;
  return path.split("/").some((segment) => segment === ".." || segment === ".");
}

// Reads the central directory only. Nothing is inflated here, so the declared sizes can
// be checked before any work proportional to them is done.
export function readZipDirectory(
  data: Buffer,
  limits: ZipLimits = ZIP_LIMITS,
): ArchiveEntry[] {
  if (data.byteLength > limits.maxArchiveBytes) {
    throw new ArchiveError("SOURCE_TOO_LARGE", "archive-too-large");
  }
  if (data.byteLength < 22 || data.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw new ArchiveError("SOURCE_UNSUPPORTED_FORMAT", "not-a-zip");
  }

  let end = -1;
  const earliest = Math.max(0, data.byteLength - MAX_END_COMMENT - 22);
  for (let offset = data.byteLength - 22; offset >= earliest; offset -= 1) {
    if (data.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new ArchiveError("SOURCE_MALFORMED", "malformed-directory");

  const declaredCount = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  const directoryOffset = data.readUInt32LE(end + 16);
  // Zip64 hides the real sizes in an extra field. Rather than grow a second size parser
  // that the caps would have to be repeated in, an archive that needs it is refused.
  if (
    declaredCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new ArchiveError("SOURCE_TOO_LARGE", "zip64");
  }
  if (declaredCount > limits.maxEntries) {
    throw new ArchiveError("SOURCE_TOO_LARGE", "too-many-entries");
  }
  if (directoryOffset + directorySize > data.byteLength) {
    throw new ArchiveError("SOURCE_MALFORMED", "malformed-directory");
  }

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  let totalBytes = 0;
  let totalCompressedBytes = 0;

  for (let index = 0; index < declaredCount; index += 1) {
    if (cursor + 46 > data.byteLength || data.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new ArchiveError("SOURCE_MALFORMED", "malformed-directory");
    }
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedBytes = data.readUInt32LE(cursor + 20);
    const bytes = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > data.byteLength) {
      throw new ArchiveError("SOURCE_MALFORMED", "malformed-directory");
    }
    const path = data.subarray(nameStart, nameEnd).toString("utf8");

    // Bit 0 marks a password protected member; we cannot read it and will not guess.
    if ((flags & 0x1) !== 0) {
      throw new ArchiveError("SOURCE_ENCRYPTED", "encrypted-entry");
    }
    if (method !== STORED && method !== DEFLATED) {
      throw new ArchiveError("SOURCE_UNSUPPORTED_FORMAT", "unsupported-method");
    }
    if (bytes === 0xffffffff || compressedBytes === 0xffffffff) {
      throw new ArchiveError("SOURCE_TOO_LARGE", "zip64");
    }
    if (isUnsafePath(path)) {
      // Nothing is ever written to disk from here, but a traversal name is a signal the
      // archive was built to attack a consumer, so the whole container is refused.
      throw new ArchiveError("SOURCE_MALFORMED", "path-traversal");
    }
    if (seen.has(path)) {
      // A duplicate name lets one reader see a different part than another.
      throw new ArchiveError("SOURCE_MALFORMED", "malformed-directory");
    }
    seen.add(path);

    const directory = path.endsWith("/");
    if (!directory) {
      if (bytes > limits.maxEntryBytes) {
        throw new ArchiveError("SOURCE_TOO_LARGE", "entry-too-large");
      }
      totalBytes += bytes;
      totalCompressedBytes += compressedBytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new ArchiveError("SOURCE_TOO_LARGE", "archive-too-large");
      }
      if (compressedBytes > 0 && bytes / compressedBytes > limits.maxCompressionRatio) {
        throw new ArchiveError("SOURCE_TOO_LARGE", "compression-ratio");
      }
    }
    entries.push({ path, bytes, compressedBytes, directory });
    cursor = nameEnd + extraLength + commentLength;
  }

  if (
    totalCompressedBytes > 0 &&
    totalBytes / totalCompressedBytes > limits.maxCompressionRatio
  ) {
    // Caught here as well as per entry: many small members can add up to the same bomb.
    throw new ArchiveError("SOURCE_TOO_LARGE", "compression-ratio");
  }
  return entries;
}

export interface ArchiveReader {
  readonly entries: readonly ArchiveEntry[];
  has(path: string): boolean;
  entry(path: string): ArchiveEntry | undefined;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
}

export async function openArchive(
  data: Buffer,
  limits: ZipLimits = ZIP_LIMITS,
): Promise<ArchiveReader> {
  const entries = readZipDirectory(data, limits);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: true });
  } catch {
    throw new ArchiveError("SOURCE_MALFORMED", "malformed-directory");
  }

  async function read(path: string): Promise<Buffer> {
    const declared = byPath.get(path);
    const file = zip.file(path);
    if (!declared || declared.directory || !file) {
      throw new ArchiveError("SOURCE_MALFORMED", "missing-entry");
    }
    const content = Buffer.from(await file.async("nodebuffer"));
    // The caps above were applied to what the directory claimed. If inflation disagrees
    // with the claim, the claim was a lie and the archive is refused rather than trusted.
    if (content.byteLength !== declared.bytes) {
      throw new ArchiveError("SOURCE_MALFORMED", "size-mismatch");
    }
    return content;
  }

  return {
    entries,
    has: (path) => byPath.has(path) && !byPath.get(path)!.directory,
    entry: (path) => byPath.get(path),
    readBinary: read,
    async readText(path) {
      const content = await read(path);
      const text = content.toString("utf8");
      // Strip the byte order mark Office sometimes writes ahead of the XML declaration.
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    },
  };
}

// --------------------------------------------------------------------------------
// Restricted XML
// --------------------------------------------------------------------------------

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

export interface XmlLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxElements: number;
}

export const XML_LIMITS: XmlLimits = {
  maxBytes: 16 * 1_024 * 1_024,
  maxDepth: 128,
  maxElements: 200_000,
};

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// The only references this reader understands are the five XML predefines and numeric
// character references. A document that declares its own entity has already been refused
// by the DOCTYPE check; anything else that looks like an entity is refused here, so a
// crafted reference can never resolve to a file or a URL.
function decodeReferences(value: string): string {
  return value.replace(/&([^;<&\s]{1,32});/g, (_match, reference: string) => {
    const named = NAMED_REFERENCES[reference];
    if (named !== undefined) return named;
    const numeric = /^#(x[0-9a-fA-F]{1,6}|[0-9]{1,7})$/.exec(reference);
    if (numeric) {
      const code = numeric[1]!.startsWith("x")
        ? Number.parseInt(numeric[1]!.slice(1), 16)
        : Number.parseInt(numeric[1]!, 10);
      if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    throw new ArchiveError("SOURCE_MALFORMED", "xml-entity");
  });
}

const ATTRIBUTE = /([A-Za-z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    attributes[match[1]!] = decodeReferences(match[3] ?? match[4] ?? "");
  }
  return attributes;
}

export function parseRestrictedXml(source: string, limits: XmlLimits = XML_LIMITS): XmlElement {
  if (Buffer.byteLength(source, "utf8") > limits.maxBytes) {
    throw new ArchiveError("SOURCE_TOO_LARGE", "xml-too-large");
  }
  // Checked before tokenizing so a document type declaration cannot hide behind a
  // malformed prologue: no DOCTYPE means no internal subset and no external subset,
  // which is where entity expansion and XXE would have to be declared.
  if (/<!DOCTYPE/i.test(source)) throw new ArchiveError("SOURCE_MALFORMED", "xml-doctype");
  if (/<!ENTITY/i.test(source)) throw new ArchiveError("SOURCE_MALFORMED", "xml-entity");

  interface Frame {
    name: string;
    attributes: Record<string, string>;
    children: XmlElement[];
    text: string;
  }
  const stack: Frame[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  let cursor = 0;

  const addText = (value: string) => {
    if (stack.length === 0) return;
    const decoded = decodeReferences(value);
    if (decoded.length > 0) stack[stack.length - 1]!.text += decoded;
  };

  const close = (frame: Frame) => {
    const element: XmlElement = {
      name: frame.name,
      attributes: frame.attributes,
      children: frame.children,
      text: frame.text,
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else root = element;
  };

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      addText(source.slice(cursor));
      break;
    }
    if (open > cursor) addText(source.slice(cursor, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0) throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
      if (stack.length > 0) stack[stack.length - 1]!.text += source.slice(open + 9, end);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end < 0) throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
      // The XML declaration is the only instruction we accept. Everything else — an
      // xml-stylesheet above all — is a pointer at something outside this file.
      if (!/^<\?xml\s/i.test(source.slice(open, end + 2))) {
        throw new ArchiveError("SOURCE_MALFORMED", "xml-processing-instruction");
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      throw new ArchiveError("SOURCE_MALFORMED", "xml-doctype");
    }

    const end = source.indexOf(">", open);
    if (end < 0) throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
    const raw = source.slice(open + 1, end);

    if (raw.startsWith("/")) {
      const frame = stack.pop();
      if (!frame || frame.name !== raw.slice(1).trim()) {
        throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
      }
      close(frame);
      cursor = end + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([A-Za-z_][-\w.]*(?::[A-Za-z_][-\w.]*)?)/.exec(body);
    if (!nameMatch) throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
    elements += 1;
    if (elements > limits.maxElements) {
      throw new ArchiveError("SOURCE_TOO_LARGE", "xml-too-large");
    }
    const frame: Frame = {
      name: nameMatch[1]!,
      attributes: readAttributes(body.slice(nameMatch[1]!.length)),
      children: [],
      text: "",
    };
    if (selfClosing) {
      close(frame);
    } else {
      stack.push(frame);
      if (stack.length > limits.maxDepth) {
        throw new ArchiveError("SOURCE_TOO_LARGE", "xml-too-deep");
      }
    }
    cursor = end + 1;
  }

  if (stack.length > 0 || !root) throw new ArchiveError("SOURCE_MALFORMED", "xml-malformed");
  return root;
}

export function findElements(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (child.name === name) found.push(child);
      walk(child);
    }
  };
  walk(element);
  return found;
}

export function findElement(element: XmlElement, name: string): XmlElement | undefined {
  return findElements(element, name)[0];
}
