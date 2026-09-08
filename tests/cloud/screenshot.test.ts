import { describe, expect, it } from "vitest";
import { isPublicWebTarget } from "../../src/server/sources/safe-fetch";
import { validateScreenshotPayload } from "../../src/trigger/screenshot";

describe("T046 isolated screenshots", () => {
  it("accepts only a reference payload and blocks private browser destinations", async () => {
    expect(validateScreenshotPayload({ assetId: "11111111-1111-4111-8111-111111111111", schemaVersion: 1 })).toEqual({ assetId: "11111111-1111-4111-8111-111111111111", schemaVersion: 1 });
    expect(() => validateScreenshotPayload({ publicUrl: "https://example.com" })).toThrow();
    await expect(isPublicWebTarget("http://127.0.0.1/admin", async () => [])).resolves.toBe(false);
    await expect(isPublicWebTarget("https://public.example", async () => [{ address: "8.8.8.8", family: 4 }])).resolves.toBe(true);
  });
});
