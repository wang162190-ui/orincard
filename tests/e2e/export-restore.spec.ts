import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { CarouselDocument } from "../../src/domain/document";

const cloud = process.env.ORINCARD_RUN_B07_E2E === "1";
test.skip(!cloud, "Set ORINCARD_RUN_B07_E2E=1 for the real B07 acceptance run.");
test.use({ screenshot: "off", trace: "off" });
test.setTimeout(20 * 60_000);
const runFile = promisify(execFile);
const formats = ["png_zip", "jpg_zip", "pdf", "pptx", "mp4"] as const;

function countPdfPages(bytes: Buffer): number {
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    ? bytes.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0
    : 0;
}

type ExportRow = Readonly<{ id: string; job_id: string; format: typeof formats[number]; state: string; asset_id: string | null; manifest: Record<string, unknown> }>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`B07 acceptance is missing required variable: ${name}`);
  return value;
}

async function signIn(page: Page, appOrigin: string, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  const passwordField = page.getByLabel("Password");
  await passwordField.fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await passwordField.fill("").catch(() => undefined);
  await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });
}

async function createProject(page: Page, appOrigin: string, document: CarouselDocument) {
  const response = await page.request.post("/api/v1/projects", {
    headers: { origin: appOrigin, "idempotency-key": `b07-create-${randomUUID()}` },
    data: { document },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { data: { projectId: string; revision: number } }).data;
}

async function waitForExports(admin: SupabaseClient, ids: readonly string[]): Promise<ExportRow[]> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const result = await admin.from("exports").select("id,job_id,format,state,asset_id,manifest").in("id", [...ids]);
    expect(result.error?.message).toBeUndefined();
    const rows = (result.data ?? []) as ExportRow[];
    if (rows.length === ids.length && rows.every((row) => ["ready", "failed"].includes(row.state))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("B07 exports did not reach a terminal state within ten minutes.");
}

async function exportBytes(admin: SupabaseClient, row: ExportRow): Promise<Buffer> {
  expect(row.asset_id).toEqual(expect.any(String));
  const asset = await admin.from("assets").select("bucket,object_key,bytes,sha256").eq("id", row.asset_id!).single();
  expect(asset.error?.message).toBeUndefined();
  const object = await admin.storage.from(asset.data!.bucket).download(asset.data!.object_key);
  expect(object.error?.message).toBeUndefined();
  const bytes = Buffer.from(await object.data!.arrayBuffer());
  expect(bytes.byteLength).toBe(Number(asset.data!.bytes));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.data!.sha256);
  return bytes;
}

async function verifyExport(admin: SupabaseClient, row: ExportRow, slideCount: number): Promise<Buffer> {
  const bytes = await exportBytes(admin, row);
  expect(row.manifest).toMatchObject({ schemaVersion: 1, format: row.format, width: 1080, height: 1350, pageCount: slideCount });
  if (row.format === "png_zip" || row.format === "jpg_zip") {
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((name) => /\.(png|jpg)$/.test(name)).sort();
    expect(names).toHaveLength(slideCount);
    for (const name of names) {
      const image = Buffer.from(await zip.file(name)!.async("nodebuffer"));
      if (row.format === "png_zip") expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      else expect([image[0], image[1], image.at(-2), image.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    }
  } else if (row.format === "pdf") {
    expect(countPdfPages(bytes)).toBe(slideCount);
  } else if (row.format === "pptx") {
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(slideCount);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("<a:t>");
    expect(xml).toContain("Make one useful point at a time");
  } else {
    const directory = await mkdtemp(join(tmpdir(), "orincard-b07-e2e-"));
    try {
      const path = join(directory, "orincard.mp4");
      await writeFile(path, bytes);
      const probe = await runFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path]);
      const parsed = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration: string } };
      expect(parsed.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1350 });
      expect(Number(parsed.format.duration)).toBeCloseTo(slideCount, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return bytes;
}

function forbiddenPackageKeys(value: unknown, path = "root"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenPackageKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(/api.?key|secret|password|credential|payment|stripe|object_key|bucket|owner_id/i.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenPackageKeys(child, `${path}.${key}`),
  ]);
}

test("T061 real exports, partial retry, recovery, size rejection, and account privacy", async ({ page, browser }) => {
  const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
  required("TRIGGER_SECRET_KEY");
  const admin = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const secondaryContext = await browser.newContext({ baseURL: appOrigin });
  const secondary = await secondaryContext.newPage();
  const base = JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;
  const runId = randomUUID();
  const foreignMarker = `FOREIGN-B07-${runId}`;
  const projectIds: string[] = [];
  const exportIds: string[] = [];
  const assetIds: string[] = [];
  const storageObjects: Array<{ bucket: string; key: string }> = [];

  try {
    await signIn(page, appOrigin, required("ORINCARD_AUTH_TEST_EMAIL"), required("ORINCARD_AUTH_TEST_PASSWORD"));
    await signIn(secondary, appOrigin, required("ORINCARD_AUTH_SECONDARY_TEST_EMAIL"), required("ORINCARD_AUTH_SECONDARY_TEST_PASSWORD"));
    const project = await createProject(page, appOrigin, { ...base, title: `B07 acceptance ${runId}` });
    projectIds.push(project.projectId);
    const foreignProject = await createProject(secondary, appOrigin, { ...base, title: foreignMarker });
    projectIds.push(foreignProject.projectId);

    const firstBatch = await page.request.post(`/api/v1/projects/${project.projectId}/exports`, {
      headers: { origin: appOrigin, "idempotency-key": `b07-all-formats-${runId}` },
      data: { expectedRevision: project.revision, formats, options: { secondsPerSlide: 1, audioAssetId: randomUUID() }, confirmedWarnings: [] },
    });
    expect(firstBatch.status(), await firstBatch.text()).toBe(202);
    const created = (await firstBatch.json()) as { data: { exports: Array<{ exportId: string; jobId: string; format: typeof formats[number] }> } };
    exportIds.push(...created.data.exports.map((item) => item.exportId));
    const firstRows = await waitForExports(admin, exportIds);
    const mp4Failure = firstRows.find((row) => row.format === "mp4");
    expect(mp4Failure).toMatchObject({ state: "failed", asset_id: null });
    const successful = firstRows.filter((row) => row.format !== "mp4");
    expect(successful).toHaveLength(4);
    expect(successful.every((row) => row.state === "ready")).toBe(true);
    for (const row of successful) await verifyExport(admin, row, base.slides.length);

    const retry = await page.request.post(`/api/v1/projects/${project.projectId}/exports`, {
      headers: { origin: appOrigin, "idempotency-key": `b07-mp4-retry-${runId}` },
      data: { expectedRevision: project.revision, formats: ["mp4"], options: { secondsPerSlide: 1 }, confirmedWarnings: [] },
    });
    expect(retry.status(), await retry.text()).toBe(202);
    const retried = (await retry.json()) as { data: { exports: Array<{ exportId: string }> } };
    const retriedId = retried.data.exports[0]!.exportId;
    exportIds.push(retriedId);
    const retriedRow = (await waitForExports(admin, [retriedId]))[0]!;
    expect(retriedRow.state).toBe("ready");
    await verifyExport(admin, retriedRow, base.slides.length);
    const unchanged = await admin.from("exports").select("id,state,asset_id").in("id", successful.map((row) => row.id));
    expect(unchanged.data?.every((row) => row.state === "ready" && row.asset_id)).toBe(true);

    const pngRow = successful.find((row) => row.format === "png_zip")!;
    const pngZip = await exportBytes(admin, pngRow);
    const rendered = await JSZip.loadAsync(pngZip);
    const imageBytes = Buffer.from(await rendered.file("01.png")!.async("nodebuffer"));
    const oldAssetId = "local-recovery-image";
    const recoveryDocument = structuredClone(base);
    recoveryDocument.title = `Recovered B07 ${runId}`;
    recoveryDocument.assetRefs = [{ id: oldAssetId, kind: "upload", mimeType: "image/png", rightsStatus: "verified" }];
    recoveryDocument.slides[1] = { ...recoveryDocument.slides[1]!, mode: "text_image", assetSlots: [{ slotId: "hero", assetId: oldAssetId, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, opacity: 1, alt: "Recovered slide" }] };
    const recoveryZip = new JSZip();
    recoveryZip.file("manifest.json", JSON.stringify({ schemaVersion: 1 }));
    recoveryZip.file("project/document.json", JSON.stringify(recoveryDocument));
    recoveryZip.file(`project/assets/${oldAssetId}`, imageBytes);
    const recoveryBytes = Buffer.from(await recoveryZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const owner = await admin.from("projects").select("owner_id").eq("id", project.projectId).single();
    const sourceAssetId = randomUUID();
    const sourceKey = `${owner.data!.owner_id}/${sourceAssetId}/b07-recovery.zip`;
    await admin.storage.from("sources").upload(sourceKey, recoveryBytes, { contentType: "application/zip" }).then(({ error }) => expect(error?.message).toBeUndefined());
    storageObjects.push({ bucket: "sources", key: sourceKey });
    const sourceAsset = await admin.from("assets").insert({ id: sourceAssetId, owner_id: owner.data!.owner_id, kind: "upload", purpose: "source", bucket: "sources", object_key: sourceKey, mime: "application/zip", bytes: recoveryBytes.byteLength, sha256: createHash("sha256").update(recoveryBytes).digest("hex"), rights: { userConfirmed: true }, state: "ready" });
    expect(sourceAsset.error?.message).toBeUndefined();
    assetIds.push(sourceAssetId);
    const inspected = await page.request.post("/api/v1/imports/inspect", { headers: { origin: appOrigin }, data: { verifiedAssetId: sourceAssetId } });
    expect(inspected.status(), await inspected.text()).toBe(202);
    const preview = (await inspected.json()) as { data: { inspectionId: string; inspectionHash: string; missingAssets: string[] } };
    expect(preview.data.missingAssets).toEqual([]);
    const confirmed = await page.request.post(`/api/v1/imports/${preview.data.inspectionId}/confirm`, { headers: { origin: appOrigin }, data: { inspectionHash: preview.data.inspectionHash, acceptMissingAssets: false } });
    expect(confirmed.status(), await confirmed.text()).toBe(201);
    const restoredId = ((await confirmed.json()) as { data: { projectId: string } }).data.projectId;
    projectIds.push(restoredId);
    expect(restoredId).not.toBe(project.projectId);
    const restored = await page.request.get(`/api/v1/projects/${restoredId}`);
    const restoredDocument = ((await restored.json()) as { data: { document: CarouselDocument } }).data.document;
    expect(restoredDocument.title).toBe(recoveryDocument.title);
    expect(restoredDocument.assetRefs[0]!.id).not.toBe(oldAssetId);
    assetIds.push(restoredDocument.assetRefs[0]!.id);

    const tooLarge = await page.request.post("/api/v1/assets/upload-intent", {
      headers: { origin: appOrigin, "idempotency-key": `b07-oversized-${runId}` },
      data: { originalName: "oversized-recovery.pdf", declaredMime: "application/pdf", size: 50 * 1024 * 1024 + 1, sha256: "a".repeat(64), purpose: "source", rightsConfirmation: true },
    });
    expect(tooLarge.status(), await tooLarge.text()).toBe(413);
    expect((await tooLarge.json()) as object).toMatchObject({ error: { code: "FILE_TOO_LARGE" } });

    const accountStart = await page.request.post("/api/v1/account/export", { headers: { origin: appOrigin, "idempotency-key": `b07-account-${runId}` } });
    expect(accountStart.status(), await accountStart.text()).toBe(202);
    const accountJobId = ((await accountStart.json()) as { data: { jobId: string } }).data.jobId;
    let accountDownload = "";
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const status = await page.request.get(`/api/v1/account/export?jobId=${accountJobId}`);
      expect(status.status(), await status.text()).toBe(200);
      const data = (await status.json()) as { data: { state: string; errorCode: string | null; downloadUrl: string | null } };
      if (data.data.state === "failed") throw new Error(`Account export failed: ${data.data.errorCode ?? "unknown"}`);
      if (data.data.state === "succeeded" && data.data.downloadUrl) { accountDownload = data.data.downloadUrl; break; }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(accountDownload).toMatch(/^https?:\/\//);
    const accountResponse = await page.request.get(accountDownload);
    expect(accountResponse.status()).toBe(200);
    const accountZip = await JSZip.loadAsync(Buffer.from(await accountResponse.body()));
    const accountJson = await accountZip.file("account.json")!.async("string");
    const account = JSON.parse(accountJson) as unknown;
    expect(forbiddenPackageKeys(account)).toEqual([]);
    expect(accountJson).toContain(`B07 acceptance ${runId}`);
    expect(accountJson).not.toContain(foreignMarker);
    const accountJob = await admin.from("jobs").select("result_ref").eq("id", accountJobId).single();
    const accountAssetId = (accountJob.data!.result_ref as { assetId: string }).assetId;
    assetIds.push(accountAssetId);
  } finally {
    if (exportIds.length) {
      const records = await admin.from("exports").select("asset_id").in("id", exportIds);
      assetIds.push(...(records.data ?? []).flatMap((row) => row.asset_id ? [row.asset_id] : []));
      await admin.from("exports").update({ state: "deleted" }).in("id", exportIds);
    }
    if (projectIds.length) await admin.from("projects").update({ state: "deleted", deleted_at: new Date().toISOString() }).in("id", projectIds);
    if (assetIds.length) {
      const uniqueIds = [...new Set(assetIds)];
      const assets = await admin.from("assets").select("id,bucket,object_key").in("id", uniqueIds);
      for (const asset of assets.data ?? []) storageObjects.push({ bucket: asset.bucket, key: asset.object_key });
      await admin.from("assets").update({ state: "deleted", deleted_at: new Date().toISOString() }).in("id", uniqueIds);
    }
    for (const bucket of new Set(storageObjects.map((item) => item.bucket))) {
      await admin.storage.from(bucket).remove([...new Set(storageObjects.filter((item) => item.bucket === bucket).map((item) => item.key))]);
    }
    await secondaryContext.close();
  }
});
