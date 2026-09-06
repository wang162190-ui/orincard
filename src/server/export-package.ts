import { createHash } from "node:crypto";
import JSZip from "jszip";
import type {
  BasicExportFormat,
  RenderedPage,
} from "../render/render-deck";

export const BASIC_RENDERER_VERSION = "b04-v1";

export type ExportManifest = {
  readonly schemaVersion: 1;
  readonly format: BasicExportFormat;
  readonly width: number;
  readonly height: number;
  readonly pageCount: number;
  readonly documentHash: string;
  readonly rendererVersion: string;
  readonly files: readonly {
    readonly name: string;
    readonly slideId?: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
};

export type PackagedBasicExport = {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mime: string;
  readonly manifest: ExportManifest;
  readonly sha256: string;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function packageBasicExport(input: {
  readonly format: BasicExportFormat;
  readonly width: number;
  readonly height: number;
  readonly slideIds: readonly string[];
  readonly pages?: readonly RenderedPage[];
  readonly pdf?: Buffer;
  readonly pdfPages?: number;
  readonly documentHash: string;
  readonly rendererVersion: string;
}): Promise<PackagedBasicExport> {
  if (input.format === "pdf") {
    if (!input.pdf || input.pdfPages !== input.slideIds.length) {
      throw new Error("PDF bytes and verified page count are required.");
    }
    const files = [{
      name: "orincard.pdf",
      bytes: input.pdf.byteLength,
      sha256: sha256(input.pdf),
    }];
    const manifest: ExportManifest = {
      schemaVersion: 1,
      format: input.format,
      width: input.width,
      height: input.height,
      pageCount: input.pdfPages,
      documentHash: input.documentHash,
      rendererVersion: input.rendererVersion,
      files,
    };
    return {
      bytes: input.pdf,
      filename: "orincard.pdf",
      mime: "application/pdf",
      manifest,
      sha256: files[0].sha256,
    };
  }

  if (
    !input.pages ||
    input.pages.length !== input.slideIds.length ||
    input.pages.some((page, index) => page.slideId !== input.slideIds[index])
  ) {
    throw new Error("Every slide must have one ordered rendered image.");
  }
  const extension = input.format === "png_zip" ? "png" : "jpg";
  const zip = new JSZip();
  const files = input.pages.map((page, index) => {
    const name = `${String(index + 1).padStart(2, "0")}.${extension}`;
    zip.file(name, page.bytes);
    return {
      name,
      slideId: page.slideId,
      bytes: page.bytes.byteLength,
      sha256: sha256(page.bytes),
    };
  });
  const manifest: ExportManifest = {
    schemaVersion: 1,
    format: input.format,
    width: input.width,
    height: input.height,
    pageCount: input.pages.length,
    documentHash: input.documentHash,
    rendererVersion: input.rendererVersion,
    files,
  };
  zip.file("manifest.json", JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    bytes,
    filename: `orincard-${extension}.zip`,
    mime: "application/zip",
    manifest,
    sha256: sha256(bytes),
  };
}
