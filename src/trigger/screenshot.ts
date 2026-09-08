import { createHash } from "node:crypto";
import { task } from "@trigger.dev/sdk";
import { chromium } from "playwright";
import { z } from "zod";
import { createNodeDnsResolver, isPublicWebTarget } from "../server/sources/safe-fetch";
import { createAdminSupabaseClient } from "../server/supabase";
import { SCREENSHOT_TASK_ID } from "./dispatch";

export { SCREENSHOT_TASK_ID };
const payloadSchema = z.object({ assetId: z.string().uuid(), schemaVersion: z.literal(1) }).strict();

export function validateScreenshotPayload(payload: unknown) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Screenshot payload must contain only an asset reference.");
  return parsed.data;
}

export async function executeScreenshot(assetId: string) {
  const client = createAdminSupabaseClient();
  const { data: asset, error } = await client
    .from("assets")
    .select("id,owner_id,rights,state")
    .eq("id", assetId).eq("kind", "screenshot").eq("state", "pending_upload").maybeSingle();
  if (error || !asset) return { assetId, state: "skipped" as const };
  const publicUrl = typeof (asset.rights as Record<string, unknown>).publicUrl === "string"
    ? (asset.rights as Record<string, string>).publicUrl : "";
  const fail = async (code: string) => {
    await client.from("assets").update({ state: "failed", error_code: code }).eq("id", asset.id).eq("state", "pending_upload");
    return { assetId, state: "failed" as const };
  };
  const resolver = createNodeDnsResolver();
  if (!(await isPublicWebTarget(publicUrl, resolver))) return fail("SCREENSHOT_BLOCKED");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: true });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      // Every request is independently checked; a safe document cannot pull a private
      // image, script, frame, redirect or font through the browser.
      if (await isPublicWebTarget(route.request().url(), resolver)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const png = Buffer.from(await page.screenshot({ type: "png", fullPage: true, animations: "disabled", timeout: 20_000 }));
    await context.close();
    if (png.byteLength < 24 || png.byteLength > 50 * 1024 * 1024) return fail("SCREENSHOT_FAILED");
    const width = png.readUInt32BE(16); const height = png.readUInt32BE(20);
    const objectKey = `${asset.owner_id}/${asset.id}/screenshot.png`;
    const { error: uploadError } = await client.storage.from("assets").upload(objectKey, png, { contentType: "image/png", upsert: false });
    if (uploadError) return fail("SCREENSHOT_FAILED");
    const { error: updateError } = await client.from("assets").update({ object_key: objectKey, mime: "image/png", bytes: png.byteLength, sha256: createHash("sha256").update(png).digest("hex"), width, height, state: "ready", error_code: null }).eq("id", asset.id).eq("state", "pending_upload");
    if (updateError) { await client.storage.from("assets").remove([objectKey]); return fail("SCREENSHOT_FAILED"); }
    return { assetId, state: "ready" as const };
  } catch { return fail("SCREENSHOT_FAILED"); }
  finally { await browser.close(); }
}

export const screenshotTask = task({ id: SCREENSHOT_TASK_ID, maxDuration: 60, run: async (payload: unknown) => executeScreenshot(validateScreenshotPayload(payload).assetId) });
