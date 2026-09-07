import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The process boundary for every external parser tool. B05 deliberately ships no npm
// parser: poppler and tesseract are installed by trigger.config.ts and driven as short
// lived child processes, so this module owns spawning, bounding and killing them.
// See docs/licenses/parsers.md for why tesseract.js and pdfjs-dist were rejected.

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  // Kept only so a caller can pattern match a known tool message. It is never copied
  // into a failure message, a log line or a Trigger payload: tool stderr can echo the
  // file path and, for some tools, fragments of the document itself.
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface CommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

// A tool that is missing, crashed or was killed is an infrastructure fault, not a verdict
// about the document. It must never be reported as "this file has no text".
export class SourceToolError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: "missing" | "failed" | "timeout",
  ) {
    super(`${tool} ${reason}`);
    this.name = "SourceToolError";
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4_096;

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new SourceToolError(command, "missing"));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) return;
      const room = maxOutputBytes - stdoutBytes;
      if (chunk.length > room) {
        stdout.push(chunk.subarray(0, room));
        stdoutBytes = maxOutputBytes;
        truncated = true;
        // A tool that keeps producing past the cap is stopped rather than allowed to
        // exhaust the worker: an inflated page count can make pdftotext unbounded.
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderr += chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes).toString("utf8");
      stderrBytes += chunk.length;
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new SourceToolError(command, error.code === "ENOENT" ? "missing" : "failed"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr, timedOut, truncated });
    });
  });
}

// Used by the parsers and by tests to report a missing prerequisite by name instead of
// letting the run degrade into a wrong verdict about the document.
export async function missingExecutables(
  names: readonly string[],
  runner: CommandRunner = runCommand,
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of names) {
    try {
      const result = await runner(name, ["--version"], { timeoutMs: 10_000 });
      // pdfinfo and friends answer --version on stderr with a non-zero code on some
      // builds, so only a spawn failure counts as missing.
      if (result.timedOut) missing.push(name);
    } catch (error) {
      if (error instanceof SourceToolError && error.reason === "missing") {
        missing.push(name);
        continue;
      }
      throw error;
    }
  }
  return missing;
}

export const OCR_EXECUTABLES = ["pdftoppm", "tesseract"] as const;

export const OCR_LIMITS = {
  // OCR is the most expensive path in the parser, so it is rationed rather than applied
  // to every page: only pages that carry ink but no text layer are rasterized, and only
  // this many of them in one source.
  maxPages: 10,
  rasterDpi: 150,
  perPageTimeoutMs: 45_000,
  rasterTimeoutMs: 30_000,
  // A page render at 150 dpi on A4 grey is about 2 MB; the cap leaves room for a large
  // page without letting a crafted MediaBox turn one page into gigabytes.
  maxRasterBytes: 64 * 1_024 * 1_024,
  maxCharactersPerPage: 20_000,
  // Below this level a grey sample counts as ink. Anti-aliased type reaches 0.
  inkThreshold: 250,
  // Enough ink pixels to be marks on paper rather than scanner noise or a stray hairline.
  minInkPixels: 32,
} as const;

export const OCR_LANGUAGES = "eng+chi_sim";

export interface OcrPageRequest {
  readonly filePath: string;
  readonly page: number;
  readonly timeoutMs?: number;
}

export interface OcrPageOutcome {
  readonly page: number;
  // Whether the rendered page has any marks at all. A page with no ink is genuinely
  // blank; a page with ink but no OCR text is a scan we could not read. AC-002 needs
  // those two told apart, because they deserve different alternative actions.
  readonly hasInk: boolean;
  readonly text: string;
}

export interface PageOcr {
  recognize(request: OcrPageRequest): Promise<OcrPageOutcome>;
}

interface GreyRaster {
  readonly width: number;
  readonly height: number;
  readonly samples: Buffer;
}

// Minimal binary PGM (P5) reader. pdftoppm -gray writes raw 8-bit samples with a three
// field ASCII header, which is cheap to inspect for ink without decoding an image format.
export function readGreyRaster(raster: Buffer): GreyRaster | undefined {
  const fields: string[] = [];
  let cursor = 0;
  const isSpace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
  while (fields.length < 4 && cursor < raster.length) {
    while (cursor < raster.length && isSpace(raster[cursor]!)) cursor += 1;
    if (raster[cursor] === 0x23) {
      while (cursor < raster.length && raster[cursor] !== 10) cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < raster.length && !isSpace(raster[cursor]!)) cursor += 1;
    fields.push(raster.subarray(start, cursor).toString("latin1"));
  }
  if (fields.length < 4 || fields[0] !== "P5") return undefined;
  const width = Number.parseInt(fields[1]!, 10);
  const height = Number.parseInt(fields[2]!, 10);
  const maxValue = Number.parseInt(fields[3]!, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || maxValue !== 255) return undefined;
  return { width, height, samples: raster.subarray(cursor + 1) };
}

export function rasterHasInk(
  raster: Buffer,
  limits: { readonly inkThreshold: number; readonly minInkPixels: number } = OCR_LIMITS,
): boolean {
  const parsed = readGreyRaster(raster);
  if (!parsed) return false;
  let ink = 0;
  for (const sample of parsed.samples) {
    if (sample < limits.inkThreshold) {
      ink += 1;
      if (ink >= limits.minInkPixels) return true;
    }
  }
  return false;
}

function decodeOcrText(stdout: Buffer, maxCharacters: number): string {
  const text = stdout
    .toString("utf8")
    // Tesseract emits a page separator and ragged spacing; collapse it so a page of
    // whitespace cannot pass the contract's "has text" check.
    .replace(/\f/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return Array.from(text).slice(0, maxCharacters).join("");
}

export function createTesseractPageOcr(options: {
  readonly runner?: CommandRunner;
  readonly languages?: string;
  readonly limits?: typeof OCR_LIMITS;
  readonly makeTempDirectory?: () => Promise<string>;
} = {}): PageOcr {
  const runner = options.runner ?? runCommand;
  const languages = options.languages ?? OCR_LANGUAGES;
  const limits = options.limits ?? OCR_LIMITS;
  const makeTempDirectory =
    options.makeTempDirectory ?? (() => mkdtemp(join(tmpdir(), "orincard-ocr-")));

  return {
    async recognize(request) {
      const budget = request.timeoutMs ?? limits.perPageTimeoutMs;
      const directory = await makeTempDirectory();
      const prefix = join(directory, "page");
      try {
        const render = await runner(
          "pdftoppm",
          [
            "-gray",
            "-r",
            String(limits.rasterDpi),
            "-f",
            String(request.page),
            "-l",
            String(request.page),
            "-singlefile",
            request.filePath,
            prefix,
          ],
          {
            timeoutMs: Math.min(budget, limits.rasterTimeoutMs),
            maxOutputBytes: limits.maxRasterBytes,
          },
        );
        if (render.timedOut) throw new SourceToolError("pdftoppm", "timeout");
        if (render.code !== 0) throw new SourceToolError("pdftoppm", "failed");

        let raster: Buffer;
        try {
          raster = await readFile(`${prefix}.pgm`);
        } catch {
          throw new SourceToolError("pdftoppm", "failed");
        }
        if (raster.byteLength > limits.maxRasterBytes) {
          throw new SourceToolError("pdftoppm", "failed");
        }
        if (!rasterHasInk(raster, limits)) {
          // No marks on the page: skip tesseract entirely. This is what keeps a blank
          // PDF from being reported as an unreadable scan.
          return { page: request.page, hasInk: false, text: "" };
        }

        const recognized = await runner(
          "tesseract",
          [`${prefix}.pgm`, "stdout", "-l", languages],
          { timeoutMs: budget, maxOutputBytes: 8 * 1_024 * 1_024 },
        );
        if (recognized.timedOut) throw new SourceToolError("tesseract", "timeout");
        if (recognized.code !== 0) throw new SourceToolError("tesseract", "failed");
        return {
          page: request.page,
          hasInk: true,
          text: decodeOcrText(recognized.stdout, limits.maxCharactersPerPage),
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
