import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_VENDOR_LICENSES,
  assertVendorLicense,
  findVendorSource,
  vendorManifest,
  verifyAssetBuffer,
} from "../../src/assets/vendor";
import { ICON_VIEW_BOX, iconNames, tablerIcons } from "../../src/assets/generated/tabler-icons";
import { boringAvatarStyles } from "../../src/assets/generated/boring-avatars";
import { MOTIF_IDS } from "../../src/render/motifs";

describe("vendor asset manifest", () => {
  it("pins every source to a commit, an archive hash and a per-file hash", () => {
    expect(vendorManifest.schemaVersion).toBe(1);
    expect(vendorManifest.sources.length).toBeGreaterThan(0);

    for (const source of vendorManifest.sources) {
      // A tag can be moved to different bytes; a full sha cannot.
      expect(source.commit, source.id).toMatch(/^[a-f0-9]{40}$/);
      expect(source.archiveSha256, source.id).toMatch(/^[a-f0-9]{64}$/);
      expect(source.repository, source.id).toMatch(/^https:\/\/github\.com\//);
      expect(source.files.length, source.id).toBeGreaterThan(0);
      for (const file of source.files) {
        expect(file.sha256, `${source.id} ${file.path}`).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it("vendors nothing that would oblige us to attribute or share alike", () => {
    // The project's binding rule: attribution-free licences only. GPL/AGPL/LGPL are not merely
    // absent from the list, they must stay absent.
    expect([...ALLOWED_VENDOR_LICENSES].sort()).toEqual(
      ["Apache-2.0", "CC0-1.0", "ISC", "MIT", "OFL-1.1"],
    );
    for (const source of vendorManifest.sources) {
      expect(ALLOWED_VENDOR_LICENSES, source.id).toContain(source.license);
      expect(source.attributionRequired, source.id).toBe(false);
      expect(() => assertVendorLicense(source)).not.toThrow();
    }
  });

  it("refuses a source whose licence is outside the allowlist", () => {
    const source = { ...findVendorSource("tabler-icons"), license: "GPL-3.0" as never };

    expect(() => assertVendorLicense(source)).toThrow("ASSET_LICENSE_REJECTED");
  });

  it("refuses a source that demands attribution even on an allowed licence", () => {
    const source = { ...findVendorSource("tabler-icons"), attributionRequired: true };

    expect(() => assertVendorLicense(source)).toThrow("ASSET_LICENSE_REJECTED");
  });

  it("rejects bytes that do not match the pinned hash", () => {
    const file = findVendorSource("tabler-icons").files[0];

    expect(() => verifyAssetBuffer(file, Buffer.from("tampered"))).toThrow("ASSET_HASH_MISMATCH");
  });

  it("accepts bytes that do match", () => {
    const bytes = Buffer.from("anything at all");
    const file = { path: "synthetic.svg", sha256: createHash("sha256").update(bytes).digest("hex") };

    expect(() => verifyAssetBuffer(file, bytes)).not.toThrow();
  });

  it("rejects an undeclared source", () => {
    expect(() => findVendorSource("some-icon-set")).toThrow("ASSET_SOURCE_NOT_DECLARED");
  });
});

describe("generated tabler icon module", () => {
  it("covers every file the manifest declares", () => {
    expect(iconNames.length).toBe(findVendorSource("tabler-icons").files.length);
  });

  it("carries drawings only, so the renderer owns colour and size", () => {
    expect(ICON_VIEW_BOX).toBe("0 0 24 24");
    for (const name of iconNames) {
      const icon = tablerIcons[name];
      // A leftover <svg> would bring upstream's width="24" height="24" and pin the icon to 24
      // CSS pixels inside a 1080px card.
      expect(icon.markup, name).not.toContain("<svg");
      expect(icon.markup, name).toMatch(/<(path|circle|rect)/);
      // Any literal colour would ignore the slide theme.
      expect(icon.markup, name).not.toMatch(/(fill|stroke)="(?!none)(?!currentColor)/);
      expect(["outline", "filled"], name).toContain(icon.variant);
    }
  });
});

describe("generated boring-avatars module", () => {
  it("exposes every style the manifest vendors a component for", () => {
    // One file per style upstream, plus the two shared helper modules the transform folds in.
    const styles = findVendorSource("boring-avatars")
      .files.map((file) => /avatar-([a-z]+)\.tsx$/.exec(file.path)?.[1])
      .filter((name): name is string => name != null);

    expect([...boringAvatarStyles].sort()).toEqual(styles.sort());
  });

  it("offers every style the slide renderer is allowed to draw", () => {
    for (const motif of MOTIF_IDS) {
      expect(boringAvatarStyles, motif).toContain(motif);
    }
  });
});
