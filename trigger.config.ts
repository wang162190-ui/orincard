import { additionalFiles, additionalPackages, aptGet } from "@trigger.dev/build/extensions/core";
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
      playwright({ browsers: ["chromium"], version: "1.57.0" }),
      // render-deck reads the slide stylesheet off disk at run time; the bundle only
      // carries JavaScript, so ship the file itself into the worker container.
      additionalFiles({ files: ["src/render/slide.css"] }),
      aptGet({ packages: ["qpdf"] }),
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
