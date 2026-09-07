import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import type { CarouselDocument } from "../../src/domain/document";

const cloud = process.env.ORINCARD_RUN_WALKING_SKELETON_E2E === "1";
test.skip(!cloud, "Set ORINCARD_RUN_WALKING_SKELETON_E2E=1 for the real B04 acceptance run.");
test.use({ screenshot: "off", trace: "off" });
test.setTimeout(10 * 60_000);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Walking-skeleton acceptance is missing required variable: ${name}`);
  return value;
}

async function readLocalDraft(page: Page, draftId: string): Promise<CarouselDocument> {
  return page.evaluate(async (expectedDraftId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("orincard-local-drafts", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const records = await new Promise<Array<{ draftId: string; document: CarouselDocument }>>(
        (resolve, reject) => {
          const request = database.transaction("drafts", "readonly").objectStore("drafts").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
      const draft = records.find((record) => record.draftId === expectedDraftId);
      if (!draft) throw new Error("Generated local draft was not persisted.");
      return draft.document;
    } finally {
      database.close();
    }
  }, draftId);
}

async function deleteLocalDraftDatabase(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("orincard-local-drafts");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Local draft database remained open."));
  }));
}

async function waitForJob(request: APIRequestContext, jobId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request.get(`/api/v1/jobs/${jobId}`);
    expect(response.status(), await response.text()).toBe(200);
    const body = await response.json() as {
      data: { state: string; errorCode: string | null };
    };
    if (body.data.state === "succeeded") return;
    if (["failed", "partial", "canceled"].includes(body.data.state)) {
      throw new Error(`Cloud job ${jobId} ended as ${body.data.state}: ${body.data.errorCode ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Cloud job ${jobId} did not finish within five minutes.`);
}

test("Topic to AI to edit to registered save to refresh to real PNG and PDF", async ({ page }) => {
  const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const publishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const secretKey = required("SUPABASE_SECRET_KEY");
  const email = required("ORINCARD_AUTH_TEST_EMAIL");
  const password = required("ORINCARD_AUTH_TEST_PASSWORD");
  required("DEEPSEEK_API_KEY");
  required("TRIGGER_SECRET_KEY");

  const runId = crypto.randomUUID();
  const editedHeadline = `Walking skeleton ${runId}`;
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const account = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let projectId: string | undefined;
  const objectPaths: string[] = [];

  try {
    await page.goto("/create");
    await page.getByLabel("Topic").fill("A calm weekly planning ritual");
    await page.getByLabel("Number of slides").fill("4");
    await page.getByLabel("Instructions").fill("Use short, practical sentences.");
    await page.getByRole("button", { name: "Generate carousel" }).click();
    await expect(page).toHaveURL(/\/editor\/local-generated-/, { timeout: 120_000 });
    await expect(page.locator("[data-editor-slide-id]")).toHaveCount(4);

    await page.getByLabel("Headline").fill(editedHeadline);
    await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
    const localDraftId = new URL(page.url()).pathname.split("/").at(-1);
    expect(localDraftId).toMatch(/^local-generated-/);
    const editedDocument = await readLocalDraft(page, localDraftId!);
    expect(editedDocument.slides[0]?.title).toBe(editedHeadline);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    const passwordField = page.getByLabel("Password");
    await passwordField.fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await passwordField.fill("").catch(() => undefined);
    await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });

    const session = await account.auth.signInWithPassword({ email, password });
    expect(session.error?.message).toBeUndefined();
    const ownerId = session.data.user?.id;
    expect(ownerId).toBeTruthy();

    const created = await page.request.post("/api/v1/projects", {
      headers: { origin: appOrigin, "idempotency-key": `walking-create-${runId}` },
      data: {
        document: editedDocument,
        localDraftId,
        explicitMigrationConsent: true,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdBody = await created.json() as { data: { projectId: string; revision: number } };
    projectId = createdBody.data.projectId;
    expect(createdBody.data.revision).toBe(1);

    await page.goto("/create");
    await deleteLocalDraftDatabase(page);
    await page.goto(`/editor/${projectId}`);
    await expect(page.getByLabel("Headline")).toHaveValue(editedHeadline);
    await page.reload();
    await expect(page.getByLabel("Headline")).toHaveValue(editedHeadline);

    for (const format of ["png_zip", "pdf"] as const) {
      const preflight = await page.request.post(`/api/v1/projects/${projectId}/preflight`, {
        headers: { origin: appOrigin },
        data: { expectedRevision: 1, format, options: {} },
      });
      expect(preflight.status(), await preflight.text()).toBe(200);
      await expect(preflight.json()).resolves.toMatchObject({ data: { canExport: true } });
    }

    const exportsResponse = await page.request.post(`/api/v1/projects/${projectId}/exports`, {
      headers: { origin: appOrigin, "idempotency-key": `walking-export-${runId}` },
      data: {
        expectedRevision: 1,
        formats: ["png_zip", "pdf"],
        options: {},
        confirmedWarnings: [],
      },
    });
    expect(exportsResponse.status(), await exportsResponse.text()).toBe(202);
    const exportsBody = await exportsResponse.json() as {
      data: { exports: Array<{ exportId: string; jobId: string; format: string }> };
    };
    expect(exportsBody.data.exports.map((item) => item.format).sort()).toEqual(["pdf", "png_zip"]);

    for (const item of exportsBody.data.exports) await waitForJob(page.request, item.jobId);

    for (const item of exportsBody.data.exports) {
      const authorization = await page.request.post(`/api/v1/exports/${item.exportId}/download`, {
        headers: { origin: appOrigin },
      });
      expect(authorization.status(), await authorization.text()).toBe(200);
      const info = await authorization.json() as {
        data: { bucket: string; objectPath: string; bytes: number; mime: string };
      };
      expect(info.data.bucket).toBe("exports");
      expect(info.data.bytes).toBeGreaterThan(100);
      objectPaths.push(info.data.objectPath);
      const artifact = await account.storage.from(info.data.bucket).download(info.data.objectPath);
      expect(artifact.error?.message).toBeUndefined();
      const bytes = Buffer.from(await artifact.data!.arrayBuffer());
      expect(bytes.byteLength).toBe(info.data.bytes);

      if (item.format === "pdf") {
        expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      } else {
        const zip = await JSZip.loadAsync(bytes);
        const pngs = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.endsWith(".png"));
        expect(pngs).toHaveLength(4);
        for (const entry of pngs) {
          const png = Buffer.from(await entry.async("uint8array"));
          expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        }
      }
    }

    const restored = await page.request.get(`/api/v1/projects/${projectId}`);
    expect(restored.status(), await restored.text()).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      data: { revision: 1, document: { slides: [{ title: editedHeadline }] } },
    });

    if (ownerId) {
      const foreign = createClient(supabaseUrl, publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      expect((await foreign.storage.from("exports").download(objectPaths[0]!)).error).toBeTruthy();
    }
  } finally {
    if (objectPaths.length > 0) await admin.storage.from("exports").remove(objectPaths);
    if (objectPaths.length > 0) await admin.from("assets").delete().in("object_key", objectPaths);
    if (projectId) await admin.from("projects").delete().eq("id", projectId);
    await account.auth.signOut();
  }
});
