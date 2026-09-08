import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import JSZip from "jszip";

const cloud = process.env.ORINCARD_RUN_SOURCES_E2E === "1";
const run = promisify(execFile);
test.use({ screenshot: "off", trace: "off" });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Source acceptance is missing required variable: ${name}`);
  return value;
}

async function signIn(page: Page, appOrigin: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(required("ORINCARD_AUTH_TEST_EMAIL"));
  const password = page.getByLabel("Password");
  await password.fill(required("ORINCARD_AUTH_TEST_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await password.fill("").catch(() => undefined);
  await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });
}

async function createSource(request: APIRequestContext, appOrigin: string, body: object) {
  const response = await request.post("/api/v1/sources", {
    headers: { origin: appOrigin, "idempotency-key": `source-e2e-${randomUUID()}` },
    data: body,
  });
  expect([201, 202], await response.text()).toContain(response.status());
  return (await response.json() as { data: { sourceId: string } }).data.sourceId;
}

async function waitForRow(
  admin: SupabaseClient,
  table: "assets" | "sources",
  id: string,
  terminal: readonly string[],
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await admin.from(table).select("*").eq("id", id).single();
    expect(result.error?.message).toBeUndefined();
    if (terminal.includes(String(result.data?.state))) return result.data as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${table} ${id} did not finish within five minutes.`);
}

function textPdf(): Buffer {
  const stream = "BT /F1 24 Tf 72 700 Td (Orincard PDF source acceptance) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  const chunks = [Buffer.from("%PDF-1.7\n", "latin1")];
  const offsets: number[] = [];
  let offset = chunks[0]!.length;
  objects.forEach((object, index) => {
    const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    offsets.push(offset);
    chunks.push(bytes);
    offset += bytes.length;
  });
  const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(xref, "latin1")]);
}

async function slideDeck(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>");
  zip.file("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/></Relationships>");
  zip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>");
  zip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/></Relationships>");
  zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Orincard slide source acceptance</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
  return zip.generateAsync({ type: "nodebuffer" });
}

async function captionedVideo(directory: string): Promise<Buffer> {
  const subtitle = join(directory, "caption.srt");
  const output = join(directory, "captioned.mp4");
  await writeFile(subtitle, "1\n00:00:00,000 --> 00:00:01,500\nOrincard video source acceptance\n");
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=1", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-i", subtitle, "-t", "2", "-c:v", "mpeg4", "-c:a", "aac", "-c:s", "mov_text", output]);
  return readFile(output);
}

test("shows the six approved source inputs and their rights gates", async ({ page }) => {
  await page.goto("/create");
  for (const name of ["Topic", "Text", "URL", "PDF", "Slides", "Video"]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }
  await page.getByRole("tab", { name: "PDF" }).click();
  await expect(page.getByText("Scanned pages are read with OCR.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate carousel" })).toBeDisabled();
  await page.getByRole("tab", { name: "Video" }).click();
  await expect(page.getByLabel("Spoken language (optional)")).toBeVisible();
  await expect(page.getByText("I have the rights to use this file.")).toBeVisible();
});

test.describe("T044 real six-source development acceptance", () => {
  test.skip(!cloud, "Set ORINCARD_RUN_SOURCES_E2E=1 for real source acceptance.");
  test.setTimeout(15 * 60_000);

  test("persists six legal sources, recovers a malformed file, and never charges generation quota", async ({ page }) => {
    const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
    const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
    const publishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const secretKey = required("SUPABASE_SECRET_KEY");
    required("TRIGGER_SECRET_KEY");
    const probeUrl = required("ORINCARD_URL_SOURCE_PROBE_URL");
    const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });
    const user = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false } });
    const directory = await mkdtemp(join(tmpdir(), "orincard-sources-e2e-"));
    const sourceIds: string[] = [];
    const assets: Array<{ id: string; bucket: string; objectKey: string }> = [];

    async function fileSource(kind: "pdf" | "slides" | "video", name: string, mime: string, bytes: Buffer) {
      const intent = await page.request.post("/api/v1/assets/upload-intent", {
        headers: { origin: appOrigin, "idempotency-key": `upload-e2e-${randomUUID()}` },
        data: { originalName: name, declaredMime: mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), purpose: "source", rightsConfirmation: true },
      });
      expect(intent.status(), await intent.text()).toBe(201);
      const registered = (await intent.json() as { data: { assetId: string; bucket: string; objectKey: string; upload: { token: string } } }).data;
      assets.push({ id: registered.assetId, bucket: registered.bucket, objectKey: registered.objectKey });
      expect((await user.storage.from(registered.bucket).uploadToSignedUrl(registered.objectKey, registered.upload.token, bytes, { contentType: mime })).error?.message).toBeUndefined();
      const completed = await page.request.post(`/api/v1/assets/${registered.assetId}/complete`, { headers: { origin: appOrigin } });
      expect([200, 202], await completed.text()).toContain(completed.status());
      expect((await waitForRow(admin, "assets", registered.assetId, ["ready", "failed"])).state).toBe("ready");
      const sourceId = await createSource(page.request, appOrigin, { kind, assetId: registered.assetId, title: name, ...(kind === "video" ? { language: "en" } : {}) });
      sourceIds.push(sourceId);
      return waitForRow(admin, "sources", sourceId, ["ready", "failed"]);
    }

    try {
      await signIn(page, appOrigin);
      expect((await user.auth.signInWithPassword({ email: required("ORINCARD_AUTH_TEST_EMAIL"), password: required("ORINCARD_AUTH_TEST_PASSWORD") })).error?.message).toBeUndefined();

      sourceIds.push(await createSource(page.request, appOrigin, { kind: "topic", text: "A calm weekly planning ritual" }));
      sourceIds.push(await createSource(page.request, appOrigin, { kind: "text", text: "A useful review separates what changed, what matters next, and what can be dropped." }));
      sourceIds.push(await createSource(page.request, appOrigin, { kind: "url", url: probeUrl }));
      expect((await fileSource("pdf", "acceptance.pdf", "application/pdf", textPdf())).state).toBe("ready");
      expect((await fileSource("slides", "acceptance.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", await slideDeck())).state).toBe("ready");
      expect((await fileSource("video", "acceptance.mp4", "video/mp4", await captionedVideo(directory))).state).toBe("ready");

      const stored = await admin.from("sources").select("id,kind,state,segments,metadata").in("id", sourceIds);
      expect(stored.error?.message).toBeUndefined();
      expect(stored.data).toHaveLength(6);
      expect(new Set(stored.data!.map((row) => row.kind))).toEqual(new Set(["topic", "text", "url", "pdf", "slides", "video"]));
      for (const row of stored.data!) {
        expect(row.state).toBe("ready");
        expect(row.segments.length).toBeGreaterThan(0);
      }

      const blocked = await page.request.post("/api/v1/sources", {
        headers: { origin: appOrigin, "idempotency-key": `source-e2e-${randomUUID()}` },
        data: { kind: "url", url: "http://127.0.0.1/private" },
      });
      expect(blocked.status()).toBe(422);
      await expect(blocked.json()).resolves.toMatchObject({ error: { code: "SOURCE_BLOCKED", action: "paste-text" } });

      const failed = await fileSource("pdf", "broken.pdf", "application/pdf", Buffer.from("%PDF-1.7\nnot a document\n"));
      expect(failed).toMatchObject({ state: "failed", metadata: { errorCode: expect.any(String), action: expect.any(String) } });

      const parseJobs = await admin.from("jobs").select("id,input_ref").eq("kind", "parse");
      expect(parseJobs.error?.message).toBeUndefined();
      const runJobs = parseJobs.data!.filter((job) => sourceIds.includes(String((job.input_ref as { sourceId?: string }).sourceId)));
      expect(runJobs).toHaveLength(4);
      const ledger = await admin.from("usage_ledger").select("id").in("job_id", runJobs.map((job) => job.id));
      expect(ledger.error?.message).toBeUndefined();
      expect(ledger.data).toEqual([]);
    } finally {
      if (sourceIds.length > 0) await admin.from("sources").delete().in("id", sourceIds);
      for (const asset of assets) await admin.storage.from(asset.bucket).remove([asset.objectKey]);
      if (assets.length > 0) await admin.from("assets").delete().in("id", assets.map((asset) => asset.id));
      await user.auth.signOut({ scope: "local" });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
