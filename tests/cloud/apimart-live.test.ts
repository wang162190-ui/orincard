import { describe, expect, it } from "vitest";
import { createApiMartImageProvider, generatedMetadata } from "../../src/server/assets/ai-image";

const live = process.env.ORINCARD_RUN_AI_IMAGE_CLOUD === "1";

describe.skipIf(!live)("APIMart live image generation", () => {
  it("returns a valid 1k PNG through the production provider adapter", async () => {
    const apiKey = process.env.APIMART_API_KEY?.trim();
    expect(apiKey, "APIMART_API_KEY is required for the live image test").toBeTruthy();
    const image = await createApiMartImageProvider(apiKey!).generate({
      kind: "ai_image",
      prompt: "A small blue square on clean white paper.",
    });
    const signature = Buffer.from(image.bytes.subarray(0, 12)).toString("hex");
    console.info("[apimart-live] downloaded result", { bytes: image.bytes.byteLength, signature });
    expect(generatedMetadata(image.bytes)).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  }, 300_000);
});
