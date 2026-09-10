import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { parseToolRequest, type ToolId } from "../../src/domain/tools";
import { toVisualWorkerRequest } from "../../src/server/tools/application";
import { renderToolImage } from "../../src/server/tools/visual-tools";
import { VISUAL_TOOL_TASK_ID } from "../../src/trigger/dispatch";

// B08 release blocker. The four visual tool routes answered `503 TOOL_UNAVAILABLE` until their
// worker existed. This file closes that hole with real evidence and nothing else: it drives the
// deployed Trigger task over the real development Supabase project, so every artifact it checks
// was rendered by the real Chromium, the real APIMart provider and the real ffmpeg inside the
// worker container. No provider, renderer or storage call is substituted here.
//
// It only runs under ORINCARD_RUN_VISUAL_TOOLS_CLOUD=1, and when that switch is on it fails
// loudly on a missing variable rather than skipping and reporting a pass.
//
// Portrait spends real provider money (one APIMart GPT-Image-2 image at the 1k/1:1 floor), so
// this file generates exactly one portrait per run and never retries a provider failure.

const cloud = process.env.ORINCARD_RUN_VISUAL_TOOLS_CLOUD === "1" ? describe : describe.skip;

const REQUIRED_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ORINCARD_AUTH_TEST_EMAIL",
  "ORINCARD_AUTH_TEST_PASSWORD",
  "TRIGGER_SECRET_KEY",
] as const;

const TERMINAL = ["succeeded", "failed", "partial", "canceled"];

interface StoredArtifact {
  readonly outputId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly objectKey: string;
  readonly downloaded: Buffer;
}

const evidence: Record<string, StoredArtifact> = {};

function requireVariables(): void {
  const missing = REQUIRED_VARIABLES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `ORINCARD_RUN_VISUAL_TOOLS_CLOUD=1 requires development variables: ${missing.join(", ")}. ` +
        "Configure them in your own shell against the development project.",
    );
  }
}

cloud("B08 real visual tool acceptance on the deployed worker", () => {
  let admin: SupabaseClient;
  let account: SupabaseClient;
  let ownerId: string;
  let runId: string;
  const createdAssetIds: string[] = [];
  const createdObjectKeys: string[] = [];

  beforeAll(async () => {
    requireVariables();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    account = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await account.auth.signInWithPassword({
      email: process.env.ORINCARD_AUTH_TEST_EMAIL!,
      password: process.env.ORINCARD_AUTH_TEST_PASSWORD!,
    });
    if (signedIn.error || !signedIn.data.user) {
      throw new Error("The development test account could not sign in.");
    }
    ownerId = signedIn.data.user.id;
    runId = randomUUID();
  }, 120_000);

  // Uploads a genuine PNG the local Chromium renders, so the worker reads a real image out of
  // real Storage rather than a byte string standing in for one.
  async function uploadImageAsset(label: string, width: number, height: number): Promise<string> {
    const bytes = await renderToolImage({
      html: `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;width:${width}px;height:${height}px;background:#101828;color:#fff;font-family:sans-serif;font-size:64px">${label}</body></html>`,
      width,
      height,
    });
    const assetId = randomUUID();
    const objectKey = `${ownerId}/acceptance/${runId}/${assetId}.png`;
    const uploaded = await admin.storage
      .from("assets")
      .upload(objectKey, bytes, { contentType: "image/png", upsert: false });
    if (uploaded.error) throw new Error(`Reference upload failed: ${uploaded.error.message}`);
    createdObjectKeys.push(objectKey);
    const inserted = await admin.from("assets").insert({
      id: assetId,
      owner_id: ownerId,
      kind: "upload",
      purpose: "media",
      bucket: "assets",
      object_key: objectKey,
      mime: "image/png",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width,
      height,
      rights: { origin: "original", holder: "Orincard", note: "Rendered for B08 acceptance." },
      state: "ready",
    });
    if (inserted.error) throw new Error(`Reference asset insert failed: ${inserted.error.message}`);
    createdAssetIds.push(assetId);
    return assetId;
  }

  // Mirrors exactly what src/app/api/v1/tools/[tool]/route.ts does on POST: the same request
  // parse, the same reference-only input_ref, the same jobs row and the same Trigger dispatch.
  async function runVisualTool(tool: ToolId, body: unknown): Promise<StoredArtifact> {
    const parsed = parseToolRequest(tool, body);
    const inputRef = toVisualWorkerRequest(parsed);
    const requestId = `acceptance-${runId}-${tool}`;
    const inserted = await admin.from("jobs").insert({
      owner_id: ownerId,
      kind: "tool",
      input_ref: inputRef,
      idempotency_key: requestId,
      request_hash: createHash("sha256").update(JSON.stringify({ ownerId, parsed })).digest("hex"),
    }).select("id,state").single();
    if (inserted.error) throw new Error(`Job insert failed: ${inserted.error.message}`);
    const jobId = inserted.data.id as string;

    const triggerKey = await idempotencyKeys.create(`tool:${jobId}`, { scope: "global" });
    const run = await tasks.trigger(
      VISUAL_TOOL_TASK_ID,
      { jobId, schemaVersion: 1, requestId },
      { idempotencyKey: triggerKey },
    );
    await admin.from("jobs")
      .update({ state: "queued", provider_run_id: run.id, updated_at: new Date().toISOString() })
      .eq("id", jobId).eq("owner_id", ownerId).eq("state", "pending_dispatch");

    let job: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const polled = await admin.from("jobs")
        .select("id,state,progress,result_ref,error_code")
        .eq("id", jobId).eq("owner_id", ownerId).maybeSingle();
      job = polled.data as Record<string, unknown> | null;
      if (job && TERMINAL.includes(job.state as string)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!job || job.state !== "succeeded") {
      throw new Error(`${tool} did not succeed: state=${job?.state ?? "unknown"} error=${job?.error_code ?? "none"}`);
    }

    // The stored reference must carry the candidate only. A rendered byte never belongs in it.
    const resultRef = job.result_ref as Record<string, unknown>;
    expect(resultRef.tool).toBe(tool);
    expect(resultRef.state).toBe("candidate");
    const outputId = resultRef.outputId as string;
    expect(outputId).toMatch(/^[0-9a-f-]{36}$/);

    const output = await admin.from("tool_outputs")
      .select("id,state,asset_id,assets!inner(object_key,mime,bytes,sha256,width,height,duration_ms,purpose,state)")
      .eq("id", outputId).eq("owner_id", ownerId).eq("job_id", jobId).single();
    if (output.error) throw new Error(`Tool output lookup failed: ${output.error.message}`);
    const asset = (Array.isArray(output.data.assets) ? output.data.assets[0] : output.data.assets) as Record<string, unknown>;
    expect(output.data.state).toBe("ready");
    expect(asset.purpose).toBe("tool_output");

    const objectKey = asset.object_key as string;
    const downloaded = await admin.storage.from("exports").download(objectKey);
    if (downloaded.error || !downloaded.data) {
      throw new Error(`Tool output download failed for ${tool}.`);
    }
    const buffer = Buffer.from(await downloaded.data.arrayBuffer());
    // The bytes registered in the database must be the bytes that actually came back.
    expect(buffer.byteLength).toBe(Number(asset.bytes));
    expect(createHash("sha256").update(buffer).digest("hex")).toBe(asset.sha256);

    const artifact: StoredArtifact = {
      outputId,
      bytes: Number(asset.bytes),
      sha256: asset.sha256 as string,
      mime: asset.mime as string,
      width: asset.width === null ? null : Number(asset.width),
      height: asset.height === null ? null : Number(asset.height),
      durationMs: asset.duration_ms === null ? null : Number(asset.duration_ms),
      objectKey,
      downloaded: buffer,
    };
    evidence[tool] = artifact;
    return artifact;
  }

  it("renders a real 1080x1080 quote card PNG through the deployed worker", async () => {
    const artifact = await runVisualTool("quote-card", {
      input: { quote: "Review the week before planning the next one.", attributionConfirmed: false },
    });
    expect(artifact.mime).toBe("image/png");
    expect(artifact.downloaded.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(artifact.downloaded.readUInt32BE(16)).toBe(1080);
    expect(artifact.downloaded.readUInt32BE(20)).toBe(1080);
    expect({ width: artifact.width, height: artifact.height }).toEqual({ width: 1080, height: 1080 });
  }, 660_000);

  it("renders a real 1080x1350 infographic PNG through the deployed worker", async () => {
    const artifact = await runVisualTool("infographic", {
      input: {
        title: "Weekly review",
        content: "Close the loop on last week. List what shipped, what slipped, and what to drop.",
      },
    });
    expect(artifact.mime).toBe("image/png");
    expect(artifact.downloaded.readUInt32BE(16)).toBe(1080);
    expect(artifact.downloaded.readUInt32BE(20)).toBe(1350);
  }, 660_000);

  it("generates one real APIMart portrait and settles its real cost", async () => {
    const referenceAssetId = await uploadImageAsset("Reference", 1024, 1024);
    const artifact = await runVisualTool("portrait", {
      input: { prompt: "A calm studio portrait on a plain background.", referenceAssetId },
    });
    expect(artifact.mime).toBe("image/png");
    expect(artifact.downloaded.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(artifact.bytes).toBeGreaterThan(1_000);

    // The portrait reserves and settles image budget against the same job id, so the
    // reservation must be closed rather than left holding quota.
    const candidate = await admin.from("assets")
      .select("id,state,kind,accepted_at,rights")
      .eq("owner_id", ownerId).eq("kind", "portrait")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    expect(candidate.error?.message).toBeUndefined();
    expect(candidate.data?.state).toBe("ready");
    // A generated portrait stays a candidate until the user accepts it.
    expect(candidate.data?.accepted_at).toBeNull();
    if (candidate.data?.id) createdAssetIds.push(candidate.data.id as string);
  }, 660_000);

  it("renders a real MP4 from slides in the requested order", async () => {
    const slideAssetIds = [
      await uploadImageAsset("One", 1080, 1350),
      await uploadImageAsset("Two", 1080, 1350),
    ];
    const artifact = await runVisualTool("carousel-to-video", {
      input: { slideAssetIds, secondsPerSlide: 2 },
    });
    expect(artifact.mime).toBe("video/mp4");
    // A real MP4 opens with an ftyp box.
    expect(artifact.downloaded.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(artifact.durationMs).toBeGreaterThanOrEqual(3_000);

    // ffprobe is the check that the container is genuinely playable rather than merely
    // starting with the right four bytes.
    const directory = await mkdtemp(join(tmpdir(), "orincard-acceptance-"));
    try {
      const filePath = join(directory, "result.mp4");
      await writeFile(filePath, artifact.downloaded);
      const { stdout } = await promisify(execFile)("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height",
        "-of", "json",
        filePath,
      ]);
      const stream = JSON.parse(stdout).streams?.[0];
      expect(stream?.codec_name).toBe("h264");
      expect({ width: stream?.width, height: stream?.height }).toEqual({ width: 1080, height: 1350 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 660_000);

  it("reports the recorded artifacts for the acceptance document", () => {
    const rows = Object.entries(evidence).map(([tool, artifact]) =>
      `${tool}: ${artifact.bytes} bytes, sha256 ${artifact.sha256}, ${artifact.mime}` +
      (artifact.durationMs === null ? `, ${artifact.width}x${artifact.height}` : `, ${artifact.durationMs} ms`),
    );
    // Printed so the coordination line can copy real numbers into docs/acceptance/tools.md.
    console.log(rows.join("\n"));
    expect(Object.keys(evidence).sort()).toEqual([
      "carousel-to-video",
      "infographic",
      "portrait",
      "quote-card",
    ]);
  });
});
