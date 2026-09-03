import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import manifestJson from "./font-manifest.json" with { type: "json" };

export type FontManifestEntry = {
  id: string;
  family: string;
  style: "normal" | "italic";
  weight: string;
  package: string;
  packageVersion: string;
  file: string;
  sha256: string;
  license: "OFL-1.1";
  licenseFile: string;
  source: string;
};

export type VerifiedFont = {
  entry: FontManifestEntry;
  bytes: Buffer;
  path: string;
};

export const fontManifest = manifestJson as {
  schemaVersion: 1;
  fonts: FontManifestEntry[];
};

const require = createRequire(import.meta.url);

export function verifyFontBuffer(entry: FontManifestEntry, bytes: Buffer): void {
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== entry.sha256) {
    throw new Error(
      `FONT_HASH_MISMATCH: ${entry.id} expected ${entry.sha256} but received ${actualHash}`,
    );
  }
}

export async function loadVerifiedFont(id: string): Promise<VerifiedFont> {
  const entry = fontManifest.fonts.find((font) => font.id === id);
  if (!entry) {
    throw new Error(`FONT_NOT_DECLARED: ${id}`);
  }

  const packageJsonPath = require.resolve(`${entry.package}/package.json`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
  };
  if (packageJson.version !== entry.packageVersion) {
    throw new Error(
      `FONT_PACKAGE_VERSION_MISMATCH: ${entry.id} expected ${entry.packageVersion} but received ${packageJson.version ?? "unknown"}`,
    );
  }

  const path = join(dirname(packageJsonPath), entry.file);
  const bytes = await readFile(path);
  verifyFontBuffer(entry, bytes);

  return { entry, bytes, path };
}
