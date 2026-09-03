import { createHash } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import type { foundationRenderProbe } from "../../src/trigger/probe";
import { requireCloudProbe } from "../setup";

async function runProbe() {
  requireCloudProbe(["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_ID"]);
  const handle = await tasks.trigger<typeof foundationRenderProbe>(
    "orincard-foundation-render-probe",
    { probe: true },
    { idempotencyKey: "b01-foundation-render-probe-v1" },
  );
  const run = await runs.poll(handle, { pollIntervalMs: 1_000 });
  if (!run.isSuccess || !run.output) {
    throw new Error(`Foundation cloud probe failed with status ${run.status}.`);
  }
  return run.output;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("foundation cloud renderer", () => {
  it("renders real PNG and PDF artifacts in cloud Chromium", async () => {
    const output = await runProbe();
    const png = Buffer.from(output.artifacts.pngBase64, "base64");
    const pdf = Buffer.from(output.artifacts.pdfBase64, "base64");

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(360);
    expect(png.readUInt32BE(20)).toBe(450);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(output.checks.pdfPages).toBe(1);
    expect(output.hashes.pngSha256).toBe(sha256(png));
    expect(output.hashes.pdfSha256).toBe(sha256(pdf));
    expect(output.metrics.pngBytes).toBe(png.byteLength);
    expect(output.metrics.pdfBytes).toBe(pdf.byteLength);
    expect(output.checks.chromiumVersion).not.toHaveLength(0);
    expect(output.checks.qpdfVersion).toContain("qpdf");
  }, 180_000);
});
