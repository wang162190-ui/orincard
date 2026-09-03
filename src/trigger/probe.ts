import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task } from "@trigger.dev/sdk";
import { chromium } from "playwright";
import PptxGenJS from "pptxgenjs";

const PROBE_TITLE = "Orincard editable probe";
const RECOVERY_FILENAME = "orincard-project.json";

type CommandResult = {
  stdout: Buffer;
  stderr: Buffer;
};

export type FoundationProbeOutput = {
  artifacts: {
    pngBase64: string;
    pdfBase64: string;
    pptxBase64: string;
  };
  checks: {
    chromiumVersion: string;
    qpdfVersion: string;
    pdfPages: number;
    attachmentName: string;
    recoveryMatches: boolean;
    pptxEditableText: string;
  };
  metrics: {
    elapsedMs: number;
    rssBytes: number;
    pngBytes: number;
    pdfBytes: number;
    pptxBytes: number;
  };
  hashes: {
    pngSha256: string;
    pdfSha256: string;
    pptxSha256: string;
  };
};

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (code === 0) {
        resolve(result);
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code ?? "unknown"}: ${result.stderr.toString("utf8").trim()}`,
        ),
      );
    });
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export const foundationRenderProbe = task({
  id: "orincard-foundation-render-probe",
  maxDuration: 120,
  run: async (_payload: { probe: true }): Promise<FoundationProbeOutput> => {
    const startedAt = Date.now();
    const directory = await mkdtemp(join(tmpdir(), "orincard-foundation-"));
    const inputPdfPath = join(directory, "carousel.pdf");
    const recoveryPath = join(directory, RECOVERY_FILENAME);
    const recoverablePdfPath = join(directory, "carousel-recoverable.pdf");
    const pptxPath = join(directory, "carousel.pptx");
    const recoveryDocument = {
      schemaVersion: 1,
      title: "Orincard recovery probe",
      slideIds: ["local-probe-slide"],
    };

    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({
        viewport: { width: 360, height: 450 },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<!doctype html>
        <html>
          <head>
            <style>
              * { box-sizing: border-box; }
              html, body { margin: 0; width: 360px; height: 450px; }
              body {
                display: grid;
                place-items: center;
                padding: 36px;
                color: #11110e;
                background: #f6f1e7;
                font-family: Arial, sans-serif;
              }
              main { border: 2px solid #11110e; border-radius: 24px; padding: 28px; }
              p { color: #44443f; line-height: 1.4; }
            </style>
          </head>
          <body>
            <main>
              <h1>${PROBE_TITLE}</h1>
              <p>One renderer, three export paths, one recoverable project.</p>
            </main>
          </body>
        </html>`,
        { waitUntil: "load" },
      );

      const png = await page.screenshot({ type: "png" });
      await page.pdf({
        path: inputPdfPath,
        width: "360px",
        height: "450px",
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });

      const pptx = new PptxGenJS();
      pptx.layout = "LAYOUT_WIDE";
      pptx.author = "Orincard";
      pptx.subject = "Foundation render probe";
      pptx.title = PROBE_TITLE;
      const slide = pptx.addSlide();
      slide.background = { color: "F6F1E7" };
      slide.addText(PROBE_TITLE, {
        x: 0.75,
        y: 0.75,
        w: 11.8,
        h: 0.8,
        fontFace: "Arial",
        fontSize: 30,
        bold: true,
        color: "11110E",
      });
      slide.addText("This text must remain editable.", {
        x: 0.75,
        y: 1.8,
        w: 11.8,
        h: 0.5,
        fontFace: "Arial",
        fontSize: 18,
        color: "44443F",
      });
      await pptx.writeFile({ fileName: pptxPath });

      await writeFile(recoveryPath, JSON.stringify(recoveryDocument));
      await runCommand("qpdf", [
        inputPdfPath,
        "--add-attachment",
        recoveryPath,
        `--key=${RECOVERY_FILENAME}`,
        `--filename=${RECOVERY_FILENAME}`,
        "--mimetype=application/json",
        "--",
        recoverablePdfPath,
      ]);

      const [qpdfVersionResult, pageCountResult, recoveredResult] = await Promise.all([
        runCommand("qpdf", ["--version"]),
        runCommand("qpdf", [recoverablePdfPath, "--show-npages"]),
        runCommand("qpdf", [
          recoverablePdfPath,
          `--show-attachment=${RECOVERY_FILENAME}`,
        ]),
      ]);
      const [pdf, pptxBuffer] = await Promise.all([
        readFile(recoverablePdfPath),
        readFile(pptxPath),
      ]);
      const recoveredDocument = JSON.parse(recoveredResult.stdout.toString("utf8")) as unknown;

      return {
        artifacts: {
          pngBase64: png.toString("base64"),
          pdfBase64: pdf.toString("base64"),
          pptxBase64: pptxBuffer.toString("base64"),
        },
        checks: {
          chromiumVersion: browser.version(),
          qpdfVersion: qpdfVersionResult.stdout.toString("utf8").trim(),
          pdfPages: Number.parseInt(pageCountResult.stdout.toString("utf8").trim(), 10),
          attachmentName: RECOVERY_FILENAME,
          recoveryMatches: JSON.stringify(recoveredDocument) === JSON.stringify(recoveryDocument),
          pptxEditableText: PROBE_TITLE,
        },
        metrics: {
          elapsedMs: Date.now() - startedAt,
          rssBytes: process.memoryUsage().rss,
          pngBytes: png.byteLength,
          pdfBytes: pdf.byteLength,
          pptxBytes: pptxBuffer.byteLength,
        },
        hashes: {
          pngSha256: sha256(png),
          pdfSha256: sha256(pdf),
          pptxSha256: sha256(pptxBuffer),
        },
      };
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
