import { additionalFiles, additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { playwright } from "@trigger.dev/build/extensions/playwright";
import { defineConfig } from "@trigger.dev/sdk";

export const TRIGGER_PROJECT_ID = "proj_bhwgeecxnhxxjrkmdqvh";

// 本地开发和公开站是两个 Trigger 项目（`--project-ref` 选目标），但共用这一份配置。
// 只有这四个变量对两边都一样，无条件同步。
const SHARED_VARS = ["VOLCENGINE_SPEECH_API_KEY", "AI_TRANSCRIBE_MODEL", "APIMART_API_KEY", "STRIPE_SECRET_KEY"];

// 其余变量只在 APP_ENV=production 时同步，也就是只在带 `--env-file` 指向生产值的那次
// deploy 里。没有这道闸，任何一次本地 deploy 都会把开发库的 ref 和密钥覆盖到公开站的
// worker 上——那正是 src/server/environment.ts 的两条断言想挡住的事。
const PUBLIC_ONLY_VARS = [
  "APP_ENV",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_PRODUCTION_PROJECT_REF",
  "DEEPSEEK_API_KEY",
  "AI_TEXT_MODEL",
  "AI_IMAGE_MODEL",
  "PEXELS_API_KEY",
  "AI_MONTHLY_BUDGET_USD",
  "USER_JOB_CONCURRENCY",
  "EXPORT_CONCURRENCY",
  "BILLING_LIVE_ENABLED",
  "AFFILIATE_PAYOUTS_ENABLED",
];

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
        [...SHARED_VARS, ...(process.env.APP_ENV === "production" ? PUBLIC_ONLY_VARS : [])].flatMap((name) =>
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
