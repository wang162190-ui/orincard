import { createHash } from "node:crypto";
import manifestJson from "./vendor-manifest.json" with { type: "json" };

/**
 * Provenance for third-party artwork vendored into the repository.
 *
 * Shaped after src/render/font-manifest.json + src/render/fonts.ts, which already solve the same
 * problem for typefaces: pin the upstream version, record a hash per file, and refuse to load
 * anything whose bytes have drifted. The licence inventory rows in docs/licenses/assets.md are
 * generated from this file rather than typed by hand, so an asset cannot ship without its origin.
 */

/**
 * Licences that clear the project's attribution-free rule. Nothing outside this set may vendor.
 *
 * The list lives in the JSON rather than here because scripts/vendor-assets.mjs enforces the same
 * rule and cannot import TypeScript; two copies would eventually disagree.
 */
export type VendorLicense = "CC0-1.0" | "MIT" | "Apache-2.0" | "ISC" | "OFL-1.1";

export type VendorFile = {
  /** Path inside the upstream repository at `commit`. */
  path: string;
  sha256: string;
};

export type VendorSource = {
  id: string;
  name: string;
  repository: string;
  owner: string;
  repo: string;
  /** Full 40-character commit sha. Tags move; a sha is what makes the hashes reproducible. */
  commit: string;
  /** sha256 of the codeload tar.gz for `commit`, so the download itself is verified before use. */
  archiveSha256: string;
  license: VendorLicense;
  /** Path to the licence text inside the upstream repository. */
  licenseFile: string;
  copyright: string;
  /**
   * False for every source we accept. Recorded rather than assumed: it is the field a reviewer
   * checks, and a `true` here means the source should never have been added.
   */
  attributionRequired: boolean;
  /** Which transform in scripts/vendor-assets.mjs turns these files into `output`. */
  transform: string;
  /** Repo-relative path of the generated module. */
  output: string;
  files: VendorFile[];
};

export const vendorManifest = manifestJson as unknown as {
  schemaVersion: 1;
  allowedLicenses: VendorLicense[];
  sources: VendorSource[];
};

export const ALLOWED_VENDOR_LICENSES: readonly VendorLicense[] = vendorManifest.allowedLicenses;

/** Throw unless the bytes are exactly what the manifest recorded for this file. */
export function verifyAssetBuffer(file: VendorFile, bytes: Buffer): void {
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== file.sha256) {
    throw new Error(
      `ASSET_HASH_MISMATCH: ${file.path} expected ${file.sha256} but received ${actualHash}`,
    );
  }
}

export function findVendorSource(id: string): VendorSource {
  const source = vendorManifest.sources.find((entry) => entry.id === id);
  if (!source) {
    throw new Error(`ASSET_SOURCE_NOT_DECLARED: ${id}`);
  }
  return source;
}

/**
 * Refuse a source whose terms would put an attribution or copyleft obligation on exported decks.
 * Called by the vendoring script before it writes anything, so a bad licence fails at vendor time
 * rather than at review time.
 */
export function assertVendorLicense(source: VendorSource): void {
  if (!(ALLOWED_VENDOR_LICENSES as readonly string[]).includes(source.license)) {
    throw new Error(
      `ASSET_LICENSE_REJECTED: ${source.id} is ${source.license}; allowed: ${ALLOWED_VENDOR_LICENSES.join(", ")}`,
    );
  }
  if (source.attributionRequired) {
    throw new Error(`ASSET_LICENSE_REJECTED: ${source.id} requires attribution`);
  }
}
