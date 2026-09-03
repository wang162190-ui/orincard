import { describe, expect, it } from "vitest";
import {
  fontManifest,
  loadVerifiedFont,
  verifyFontBuffer,
} from "../../src/render/fonts";

describe("render font manifest", () => {
  it("declares the three fixed OFL font resources", () => {
    expect(fontManifest.schemaVersion).toBe(1);
    expect(fontManifest.fonts.map((font) => font.family)).toEqual([
      "Inter",
      "Source Serif 4",
      "Noto Sans SC",
    ]);
    for (const font of fontManifest.fonts) {
      expect(font.license).toBe("OFL-1.1");
      expect(font.packageVersion).toBe("5.3.0");
      expect(font.source).toMatch(/^https:\/\//);
      expect(font.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each([
    "inter-latin-variable",
    "source-serif-4-latin-variable",
    "noto-sans-sc-simplified-400",
  ])("loads and verifies %s without a network request", async (id) => {
    const font = await loadVerifiedFont(id);

    expect(font.bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(font.path).toContain("node_modules");
  });

  it("rejects bytes that do not match the pinned hash", () => {
    const entry = fontManifest.fonts[0];

    expect(() => verifyFontBuffer(entry, Buffer.from("tampered"))).toThrow(
      "FONT_HASH_MISMATCH",
    );
  });

  it("rejects a font that is absent from the manifest", async () => {
    await expect(loadVerifiedFont("system-font")).rejects.toThrow("FONT_NOT_DECLARED");
  });
});
