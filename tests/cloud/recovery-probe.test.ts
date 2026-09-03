import { createHash } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk";
import JSZip from "jszip";
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

describe("foundation recoverability", () => {
  it("keeps PPTX text editable and round-trips the PDF attachment", async () => {
    const output = await runProbe();
    const pptx = Buffer.from(output.artifacts.pptxBase64, "base64");
    const archive = await JSZip.loadAsync(pptx);
    const slideXml = await archive.file("ppt/slides/slide1.xml")?.async("text");

    expect(slideXml).toContain(output.checks.pptxEditableText);
    expect(slideXml).toContain("This text must remain editable.");
    expect(output.checks.attachmentName).toBe("orincard-project.json");
    expect(output.checks.recoveryMatches).toBe(true);
    expect(output.hashes.pptxSha256).toBe(
      createHash("sha256").update(pptx).digest("hex"),
    );
    expect(output.metrics.pptxBytes).toBe(pptx.byteLength);
  }, 180_000);
});
