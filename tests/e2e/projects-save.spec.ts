import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { CarouselDocument } from "../../src/domain/document";

const cloud = process.env.ORINCARD_RUN_PROJECTS_CLOUD === "1";
test.skip(!cloud, "Set ORINCARD_RUN_PROJECTS_CLOUD=1 for the isolated development project.");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Project save acceptance is missing required variable: ${name}`);
  }
  return value;
}

test("migrates an explicitly approved local draft and restores the saved revision", async ({
  page,
}) => {
  const email = required("ORINCARD_AUTH_TEST_EMAIL");
  const password = required("ORINCARD_AUTH_TEST_PASSWORD");
  const appUrl = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
  const document = JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
  const runId = crypto.randomUUID();

  await page.goto("/editor/local-cloud-save-acceptance");
  await page.getByRole("button", { name: "Slide 2: Lead with the conclusion" }).click();
  await page.getByLabel("Headline").fill(`Cloud save ${runId}`);
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${appUrl}/`);

  const migrated = structuredClone(document);
  migrated.title = `Cloud save ${runId}`;
  migrated.slides[1] = { ...migrated.slides[1], title: `Cloud save ${runId}` };
  const create = await page.request.post("/api/v1/projects", {
    headers: {
      origin: appUrl,
      "idempotency-key": `e2e-create-${runId}`,
    },
    data: {
      document: migrated,
      localDraftId: "local-cloud-save-acceptance",
      explicitMigrationConsent: true,
    },
  });
  expect(create.status(), await create.text()).toBe(201);
  const created = (await create.json()) as {
    data: { projectId: string; revision: number };
  };
  expect(created.data.revision).toBe(1);

  const edited = structuredClone(migrated);
  edited.slides[1] = { ...edited.slides[1], title: `Saved revision ${runId}` };
  const save = await page.request.put(`/api/v1/projects/${created.data.projectId}`, {
    headers: {
      origin: appUrl,
      "idempotency-key": `e2e-save-${runId}`,
    },
    data: { expectedRevision: 1, document: edited },
  });
  expect(save.status(), await save.text()).toBe(200);

  await page.reload();
  const restored = await page.request.get(
    `/api/v1/projects/${created.data.projectId}`,
  );
  expect(restored.status(), await restored.text()).toBe(200);
  const restoredBody = (await restored.json()) as {
    data: { revision: number; saveState: string; document: CarouselDocument };
  };
  expect(restoredBody.data.revision).toBe(2);
  expect(restoredBody.data.saveState).toBe("saved");
  expect(restoredBody.data.document.slides[1]?.title).toBe(`Saved revision ${runId}`);
});
