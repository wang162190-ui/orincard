import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CarouselDocument } from "../../src/domain/document";

const cloud = process.env.ORINCARD_RUN_ASSETS_E2E === "1";
test.skip(!cloud, "Set ORINCARD_RUN_ASSETS_E2E=1 for the real B06 acceptance run.");
test.use({ screenshot: "off", trace: "off" });
test.setTimeout(20 * 60_000);

type AssetRow = Readonly<{ id: string; owner_id: string; bucket: string; object_key: string; kind: string; state: string; accepted_at: string | null }>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Asset and Brand Kit acceptance is missing required variable: ${name}`);
  return value;
}

async function signIn(page: Page, appOrigin: string, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  const field = page.getByLabel("Password");
  await field.fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await field.fill("").catch(() => undefined);
  await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });
}

async function waitForAsset(admin: SupabaseClient, assetId: string): Promise<AssetRow> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { data, error } = await admin.from("assets").select("id,owner_id,bucket,object_key,kind,state,accepted_at").eq("id", assetId).maybeSingle();
    expect(error?.message).toBeUndefined();
    if (data && ["ready", "failed"].includes(data.state)) return data as AssetRow;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Asset ${assetId} did not finish within five minutes.`);
}

async function createProject(page: Page, appOrigin: string, title: string): Promise<string> {
  const document = JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;
  const response = await page.request.post("/api/v1/projects", {
    headers: { origin: appOrigin, "idempotency-key": `assets-e2e-project-${randomUUID()}` },
    data: { document: { ...document, title }, localDraftId: `local-assets-${randomUUID()}`, explicitMigrationConsent: true },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: { projectId: string } }).data.projectId;
}

test("T053 real asset and Brand Kit acceptance keeps providers, candidates, projects, and accounts isolated", async ({ page, browser }) => {
  const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const secretKey = required("SUPABASE_SECRET_KEY");
  const primaryEmail = required("ORINCARD_AUTH_TEST_EMAIL");
  const primaryPassword = required("ORINCARD_AUTH_TEST_PASSWORD");
  const secondaryEmail = required("ORINCARD_AUTH_SECONDARY_TEST_EMAIL");
  const secondaryPassword = required("ORINCARD_AUTH_SECONDARY_TEST_PASSWORD");
  required("PEXELS_API_KEY");
  required("OPENAI_API_KEY");
  required("TRIGGER_SECRET_KEY");

  const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });
  const secondaryContext = await browser.newContext({ baseURL: appOrigin });
  const secondaryPage = await secondaryContext.newPage();
  const assetIds: string[] = [];
  const brandIds: string[] = [];
  let projectId: string | undefined;

  try {
    await signIn(page, appOrigin, primaryEmail, primaryPassword);
    await signIn(secondaryPage, appOrigin, secondaryEmail, secondaryPassword);

    // The editor must expose all six source choices before cloud-only API checks.
    await page.goto("/editor/local-assets-acceptance");
    for (const label of ["Upload", "Pexels", "Screenshot", "AI image", "Portrait", "Emoji"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }

    const search = await page.request.get("/api/v1/assets/search?query=notebook&orientation=landscape");
    expect(search.status(), await search.text()).toBe(200);
    const searched = (await search.json()) as { data: { items: Array<{ providerId: string; photographer: string; sourceUrl: string }> } };
    expect(searched.data.items[0]).toMatchObject({ providerId: expect.stringMatching(/^\d+$/), photographer: expect.any(String), sourceUrl: expect.stringMatching(/^https:\/\//) });

    const imported = await page.request.post("/api/v1/assets/import-stock", {
      headers: { origin: appOrigin },
      data: { providerId: searched.data.items[0]!.providerId, licenseConfirmed: true },
    });
    expect(imported.status(), await imported.text()).toBe(201);
    const stockId = ((await imported.json()) as { data: { assetId: string } }).data.assetId;
    assetIds.push(stockId);
    expect(await waitForAsset(admin, stockId)).toMatchObject({ kind: "stock", state: "ready" });

    const screenshot = await page.request.post("/api/v1/assets/screenshot", {
      headers: { origin: appOrigin },
      data: { publicUrl: "https://www.iana.org/help/example-domains" },
    });
    expect(screenshot.status(), await screenshot.text()).toBe(202);
    const screenshotId = ((await screenshot.json()) as { data: { assetId: string } }).data.assetId;
    assetIds.push(screenshotId);
    expect(await waitForAsset(admin, screenshotId)).toMatchObject({ kind: "screenshot", state: "ready" });

    async function generate(kind: "ai_image" | "portrait", prompt: string, referenceAssetId?: string) {
      const response = await page.request.post("/api/v1/assets/generate", {
        headers: { origin: appOrigin },
        data: { kind, prompt, ...(referenceAssetId ? { referenceAssetId } : {}) },
      });
      expect(response.status(), await response.text()).toBe(202);
      const id = ((await response.json()) as { data: { assetId: string } }).data.assetId;
      assetIds.push(id);
      const completed = await waitForAsset(admin, id);
      expect(completed).toMatchObject({ kind, state: "ready", accepted_at: null });
      const accepted = await page.request.post(`/api/v1/assets/${id}/accept`, {
        headers: { origin: appOrigin }, data: { rightsConfirmation: true, keepInLibrary: true },
      });
      expect(accepted.status(), await accepted.text()).toBe(200);
      expect(((await accepted.json()) as { data: { asset: { acceptedAt: string | null } } }).data.asset.acceptedAt).toEqual(expect.any(String));
      return id;
    }

    await generate("ai_image", "A minimal editorial still life of a notebook and pencil on cream paper");
    const portraitId = await generate("portrait", "A warm, professional editorial portrait", stockId);

    const assetList = await page.request.get("/api/v1/assets?limit=50");
    expect(assetList.status(), await assetList.text()).toBe(200);
    expect(((await assetList.json()) as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id)).toEqual(expect.arrayContaining(assetIds));
    const foreignAsset = await secondaryPage.request.get("/api/v1/assets?limit=50");
    expect(foreignAsset.status(), await foreignAsset.text()).toBe(200);
    expect(((await foreignAsset.json()) as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id)).not.toContain(stockId);

    const createdKit = await page.request.post("/api/v1/brand-kits", {
      headers: { origin: appOrigin },
      data: { name: `Assets acceptance ${randomUUID()}`, settings: { logoAssetId: stockId, headshotAssetId: portraitId, colors: ["#171717", "#F7F3EB", "#E85D3F"], fontPairId: "source-serif-inter", counterDefaults: { visible: true, style: "fraction" } } },
    });
    expect(createdKit.status(), await createdKit.text()).toBe(201);
    const kit = ((await createdKit.json()) as { data: { kit: { id: string; revision: number } } }).data.kit;
    brandIds.push(kit.id);

    const duplicate = await page.request.post(`/api/v1/brand-kits/${kit.id}/duplicate`, {
      headers: { origin: appOrigin }, data: { expectedRevision: kit.revision, name: `Assets acceptance copy ${randomUUID()}` },
    });
    expect(duplicate.status(), await duplicate.text()).toBe(201);
    brandIds.push(((await duplicate.json()) as { data: { kit: { id: string } } }).data.kit.id);

    projectId = await createProject(page, appOrigin, `Assets acceptance ${randomUUID()}`);
    const applied = await page.request.post(`/api/v1/brand-kits/${kit.id}/apply`, {
      headers: { origin: appOrigin, "idempotency-key": `assets-e2e-apply-${randomUUID()}` },
      data: { projectId, expectedProjectRevision: 1, previewConfirmed: true },
    });
    expect(applied.status(), await applied.text()).toBe(200);
    expect(((await applied.json()) as { data: { revision: number; brandSnapshot: { kitId: string } } }).data).toMatchObject({ revision: 2, brandSnapshot: { kitId: kit.id } });

    const restored = await page.request.get(`/api/v1/projects/${projectId}`);
    expect(restored.status(), await restored.text()).toBe(200);
    expect(((await restored.json()) as { data: { document: CarouselDocument } }).data.document.brandSnapshot).toMatchObject({ kitId: kit.id });

    const forbidden = await secondaryPage.request.post(`/api/v1/brand-kits/${kit.id}/duplicate`, {
      headers: { origin: appOrigin }, data: { expectedRevision: kit.revision, name: "Foreign copy" },
    });
    expect(forbidden.status(), await forbidden.text()).toBe(404);

    // This is an intentional end-to-end requirement: deletion must report the project
    // linked by apply before it can be confirmed. A failure here is a B06 release block.
    const impact = await page.request.get(`/api/v1/brand-kits/${kit.id}`);
    expect(impact.status(), await impact.text()).toBe(200);
    const impactData = (await impact.json()) as { data: { kit: { revision: number }; affectedProjects: Array<{ id: string }> } };
    expect(impactData.data.affectedProjects.map((item) => item.id)).toContain(projectId);
    const deleted = await page.request.delete(`/api/v1/brand-kits/${kit.id}`, {
      headers: { origin: appOrigin }, data: { expectedRevision: impactData.data.kit.revision, expectedProjectIds: impactData.data.affectedProjects.map((item) => item.id) },
    });
    expect(deleted.status(), await deleted.text()).toBe(204);
  } finally {
    if (projectId) await admin.from("projects").delete().eq("id", projectId);
    if (brandIds.length > 0) await admin.from("brand_kits").delete().in("id", brandIds);
    if (assetIds.length > 0) {
      const { data } = await admin.from("assets").select("bucket,object_key").in("id", assetIds);
      const byBucket = new Map<string, string[]>();
      for (const item of data ?? []) byBucket.set(item.bucket, [...(byBucket.get(item.bucket) ?? []), item.object_key]);
      for (const [bucket, keys] of byBucket) await admin.storage.from(bucket).remove(keys);
      await admin.from("assets").delete().in("id", assetIds);
    }
    await secondaryContext.close();
  }
});
