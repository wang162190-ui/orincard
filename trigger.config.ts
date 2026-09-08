import { additionalFiles, additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { playwright } from "@trigger.dev/build/extensions/playwright";
import { defineConfig } from "@trigger.dev/sdk";

export const TRIGGER_PROJECT_ID = "proj_bhwgeecxnhxxjrkmdqvh";

export default defineConfig({
  project: TRIGGER_PROJECT_ID,
  runtime: "node-22",
  maxDuration: 300,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    extensions: [
      syncEnvVars(() =>
        ["VOLCENGINE_SPEECH_API_KEY", "AI_TRANSCRIBE_MODEL"].flatMap((name) =>
          process.env[name] ? [{ name, value: process.env[name], isSecret: true }] : [],
        ),
      ),
      playwright({ browsers: ["chromium"], version: "1.57.0" }),
      // render-deck reads the slide stylesheet off disk at run time; the bundle only
      // carries JavaScript, so ship the file itself into the worker container.
      additionalFiles({ files: ["src/render/slide.css"] }),
      // poppler-utils and tesseract cover the whole PDF source path as separate
      // processes: pdfinfo reports encryption and page count, pdftotext reads the text
      // layer, pdftoppm rasterises only the pages that turn out to be scans, tesseract
      // reads those. Installing them here keeps the OCR model data out of git and out of
      // the bundle, and nothing is fetched from a CDN while a task is running.
      // See docs/licenses/parsers.md for the licence review and the rejected npm route.
      //
      // ffmpeg joins them for the video source: ffprobe reports duration and which streams
      // exist, ffmpeg lifts an embedded subtitle track or cuts the audio into chunks on
      // exact second boundaries. Debian's build is the plain ffmpeg package, not the
      // -full/-nonfree variants, which keeps the container on redistributable codecs.
      aptGet({
        packages: [
          "qpdf",
          "poppler-utils",
          "tesseract-ocr",
          "tesseract-ocr-eng",
          "tesseract-ocr-chi-sim",
          "ffmpeg",
        ],
      }),
      additionalPackages({
        packages: [
          "@fontsource-variable/inter",
          "@fontsource-variable/source-serif-4",
          "@fontsource/noto-sans-sc",
        ],
      }),
    ],
  },
});
