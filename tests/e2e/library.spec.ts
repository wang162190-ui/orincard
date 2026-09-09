import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { CarouselDocument } from "../../src/domain/document";

const cloud = process.env.ORINCARD_RUN_LIBRARY_E2E === "1";
test.skip(!cloud, "Set ORINCARD_RUN_LIBRARY_E2E=1 for the real T058 acceptance run.");
test.use({ screenshot: "off", trace: "off" });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Project library acceptance is missing required variable: ${name}`);
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

test("T058 project library uses real owner-isolated, searchable, idempotent project records", async ({ page, browser }) => {
  const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
  const admin = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const secondaryContext = await browser.newContext({ baseURL: appOrigin });
  const secondary = await secondaryContext.newPage();
  const runId = randomUUID();
  const marker = `Library ${runId}`;
  const ids: string[] = [];
  const base = JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;

  async function create(title: string, platform: CarouselDocument["platform"]) {
    const response = await page.request.post("/api/v1/projects", {
      headers: { origin: appOrigin, "idempotency-key": `library-create-${randomUUID()}` },
      data: { document: { ...base, title, platform } },
    });
    expect(response.status(), await response.text()).toBe(201);
    const data = (await response.json()) as { data: { projectId: string; revision: number } };
    ids.push(data.data.projectId);
    return data.data;
  }

  try {
    await signIn(page, appOrigin, required("ORINCARD_AUTH_TEST_EMAIL"), required("ORINCARD_AUTH_TEST_PASSWORD"));
    await signIn(secondary, appOrigin, required("ORINCARD_AUTH_SECONDARY_TEST_EMAIL"), required("ORINCARD_AUTH_SECONDARY_TEST_PASSWORD"));
    const linkedin = await create(`${marker} LinkedIn`, "linkedin");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const instagram = await create(`${marker} Instagram`, "instagram");

    await page.goto("/projects");
    const cards = page.getByTestId("project-list").locator("section");
    await expect(cards.first()).toContainText(`${marker} Instagram`);
    await page.getByLabel("Search projects").fill(`${runId} LinkedIn`);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${marker} LinkedIn` })).toBeVisible();
    await expect(page.getByText(`${marker} Instagram`)).toHaveCount(0);

    await page.getByLabel("Search projects").fill("");
    await page.getByLabel("Platform").selectOption("instagram");
    await expect(page.getByRole("heading", { name: `${marker} Instagram` })).toBeVisible();
    await expect(page.getByText(`${marker} LinkedIn`)).toHaveCount(0);
    await page.getByLabel("Platform").selectOption("");

    const duplicateKey = `library-duplicate-${randomUUID()}`;
    const firstDuplicate = await page.request.post(`/api/v1/projects/${linkedin.projectId}/duplicate`, { headers: { origin: appOrigin, "idempotency-key": duplicateKey }, data: { expectedRevision: linkedin.revision } });
    expect(firstDuplicate.status(), await firstDuplicate.text()).toBe(201);
    const copiedId = ((await firstDuplicate.json()) as { data: { projectId: string } }).data.projectId;
    ids.push(copiedId);
    const replay = await page.request.post(`/api/v1/projects/${linkedin.projectId}/duplicate`, { headers: { origin: appOrigin, "idempotency-key": duplicateKey }, data: { expectedRevision: linkedin.revision } });
    expect(((await replay.json()) as { data: { projectId: string } }).data.projectId).toBe(copiedId);
    const keyConflict = await page.request.post(`/api/v1/projects/${instagram.projectId}/duplicate`, { headers: { origin: appOrigin, "idempotency-key": duplicateKey }, data: { expectedRevision: instagram.revision } });
    expect(keyConflict.status(), await keyConflict.text()).toBe(409);

    const foreign = await secondary.request.post(`/api/v1/projects/${linkedin.projectId}/archive`, { headers: { origin: appOrigin, "idempotency-key": `library-foreign-${randomUUID()}` }, data: { expectedRevision: linkedin.revision } });
    expect(foreign.status(), await foreign.text()).toBe(404);
    const archiveKey = `library-archive-${randomUUID()}`;
    const archived = await page.request.post(`/api/v1/projects/${instagram.projectId}/archive`, { headers: { origin: appOrigin, "idempotency-key": archiveKey }, data: { expectedRevision: instagram.revision } });
    expect(archived.status(), await archived.text()).toBe(200);
    expect(((await archived.json()) as { data: { state: string; revision: number } }).data).toMatchObject({ state: "archived", revision: 2 });
    const archiveReplay = await page.request.post(`/api/v1/projects/${instagram.projectId}/archive`, { headers: { origin: appOrigin, "idempotency-key": archiveKey }, data: { expectedRevision: instagram.revision } });
    expect(archiveReplay.status(), await archiveReplay.text()).toBe(200);

    await page.goto("/projects");
    await page.getByLabel("Status").selectOption("archived");
    const archivedCard = page.locator(`[data-project-id="${instagram.projectId}"]`);
    await expect(archivedCard).toBeVisible();
    await page.getByRole("link", { name: "Continue editing" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/editor/${instagram.projectId}$`));
    await expect(page.getByTestId("draft-status")).toBeVisible();
  } finally {
    if (ids.length) await admin.from("projects").update({ state: "deleted", deleted_at: new Date().toISOString() }).in("id", ids);
    await secondaryContext.close();
  }
});
