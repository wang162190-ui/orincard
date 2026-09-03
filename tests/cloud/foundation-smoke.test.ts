import { runs, tasks } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import type { foundationRenderProbe } from "../../src/trigger/probe";
import { requireCloudProbe } from "../setup";

describe("B01 foundation smoke", () => {
  it("completes the real cloud render and recovery loop", async () => {
    requireCloudProbe(["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_ID"]);
    const handle = await tasks.trigger<typeof foundationRenderProbe>(
      "orincard-foundation-render-probe",
      { probe: true },
      { idempotencyKey: "b01-foundation-render-probe-v1" },
    );
    const run = await runs.poll(handle, { pollIntervalMs: 1_000 });

    expect(run.isSuccess, `cloud run ended as ${run.status}`).toBe(true);
    expect(run.output).toBeDefined();
    expect(run.output?.checks.recoveryMatches).toBe(true);
    expect(run.output?.checks.pdfPages).toBe(1);
    expect(run.output?.metrics.elapsedMs).toBeGreaterThan(0);
    expect(run.output?.metrics.elapsedMs).toBeLessThan(120_000);
    expect(run.output?.metrics.rssBytes).toBeGreaterThan(0);
    expect(run.output?.metrics.pngBytes).toBeGreaterThan(0);
    expect(run.output?.metrics.pdfBytes).toBeGreaterThan(0);
    expect(run.output?.metrics.pptxBytes).toBeGreaterThan(0);
    expect(run.output?.hashes.pngSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.output?.hashes.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.output?.hashes.pptxSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 180_000);
});
