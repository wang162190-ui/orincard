import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCarouselDocument, type CarouselDocument } from "../domain/document";

export const RECOVERY_LIMITS = { maxBytes: 250 * 1024 * 1024, maxFiles: 1_000, maxCompressionRatio: 100 } as const;

export class RecoveryError extends Error {
  constructor(readonly code: "INVALID_PACKAGE" | "FILE_TOO_LARGE" | "AUTH_REQUIRED" | "NOT_FOUND" | "INSPECTION_EXPIRED" | "INSPECTION_CHANGED", message: string, readonly status: number) { super(message); }
}

export type RecoveryInspection = {
  readonly inspectionHash: string;
  readonly document: CarouselDocument;
  readonly files: readonly { path: string; bytes: number; sha256: string }[];
  readonly missingAssets: readonly string[];
};

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export async function inspectRecoveryZip(bytes: Buffer): Promise<RecoveryInspection> {
  if (bytes.byteLength > RECOVERY_LIMITS.maxBytes) throw new RecoveryError("FILE_TOO_LARGE", "Recovery package is too large.", 413);
  let archive: JSZip;
  try { archive = await JSZip.loadAsync(bytes, { createFolders: false }); } catch { throw new RecoveryError("INVALID_PACKAGE", "Recovery package is not a valid ZIP.", 422); }
  const entries = Object.values(archive.files).filter((file) => !file.dir);
  if (entries.length === 0 || entries.length > RECOVERY_LIMITS.maxFiles || entries.some((file) => !safePath(file.name))) {
    throw new RecoveryError("INVALID_PACKAGE", "Recovery package has unsafe paths or too many files.", 422);
  }
  const archiveSizes = entries.map((file) => (file as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data);
  const compressed = archiveSizes.reduce((total, value) => total + (value?.compressedSize ?? 0), 0);
  const declared = archiveSizes.reduce((total, value) => total + (value?.uncompressedSize ?? 0), 0);
  if (declared > RECOVERY_LIMITS.maxBytes || (compressed > 0 && declared / compressed > RECOVERY_LIMITS.maxCompressionRatio)) {
    throw new RecoveryError("INVALID_PACKAGE", "Recovery package exceeds safe extraction limits.", 422);
  }
  const project = archive.file("project/document.json");
  const manifestFile = archive.file("manifest.json");
  if (!project || !manifestFile) throw new RecoveryError("INVALID_PACKAGE", "Recovery package is missing its manifest or project document.", 422);
  let document: CarouselDocument;
  try { document = parseCarouselDocument(JSON.parse(await project.async("text"))); } catch { throw new RecoveryError("INVALID_PACKAGE", "Recovery project document is invalid.", 422); }
  let manifest: unknown;
  try { manifest = JSON.parse(await manifestFile.async("text")); } catch { throw new RecoveryError("INVALID_PACKAGE", "Recovery manifest is invalid.", 422); }
  if (!manifest || typeof manifest !== "object" || (manifest as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new RecoveryError("INVALID_PACKAGE", "Recovery manifest version is not supported.", 422);
  }
  const files = await Promise.all(entries.map(async (file) => {
    const data = Buffer.from(await file.async("nodebuffer"));
    return { path: file.name, bytes: data.byteLength, sha256: digest(data) };
  }));
  const paths = new Set(files.map((file) => file.path));
  const missingAssets = document.assetRefs.map((asset) => asset.id).filter((id) => !paths.has(`project/assets/${id}`));
  const inspectionHash = digest(Buffer.from(JSON.stringify({ document, files: files.map(({ path, bytes: size, sha256 }) => ({ path, bytes: size, sha256 })) })));
  return { inspectionHash, document, files, missingAssets };
}

export interface RecoveryStore {
  load(ownerId: string, assetId: string): Promise<Buffer | null>;
  save(ownerId: string, assetId: string, inspection: RecoveryInspection): Promise<{ id: string; expiresAt: string }>;
  get(ownerId: string, inspectionId: string): Promise<{ id: string; inspectionHash: string; document: CarouselDocument; missingAssets: readonly string[]; expiresAt: string } | null>;
  create(ownerId: string, document: CarouselDocument, inspectionId: string): Promise<{ projectId: string; revision: number }>;
}

export function createSupabaseRecoveryStore(client: SupabaseClient): RecoveryStore {
  return {
    async load(ownerId, assetId) {
      const { data } = await client.from("assets").select("bucket,object_key").eq("id", assetId).eq("owner_id", ownerId).eq("purpose", "source").eq("state", "ready").maybeSingle();
      if (!data) return null;
      const { data: blob, error } = await client.storage.from(data.bucket).download(data.object_key);
      return error || !blob ? null : Buffer.from(await blob.arrayBuffer());
    },
    async save(ownerId, assetId, inspection) {
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const { data, error } = await client.from("recovery_imports").insert({ owner_id: ownerId, asset_id: assetId, inspection_hash: inspection.inspectionHash, document: inspection.document, missing_assets: inspection.missingAssets, expires_at: expiresAt }).select("id,expires_at").single();
      if (error || !data) throw new RecoveryError("INVALID_PACKAGE", "Recovery inspection could not be saved.", 422);
      return { id: data.id, expiresAt: data.expires_at };
    },
    async get(ownerId, inspectionId) {
      const { data } = await client.from("recovery_imports").select("id,inspection_hash,document,missing_assets,expires_at").eq("id", inspectionId).eq("owner_id", ownerId).eq("state", "inspected").maybeSingle();
      return data ? { id: data.id, inspectionHash: data.inspection_hash, document: parseCarouselDocument(data.document), missingAssets: data.missing_assets as string[], expiresAt: data.expires_at } : null;
    },
    async create(ownerId, document, inspectionId) {
      const { data, error } = await client.rpc("server_confirm_recovery_import", { p_owner_id: ownerId, p_import_id: inspectionId, p_document: document });
      if (error || !data || typeof data !== "object") throw new RecoveryError("INVALID_PACKAGE", "Recovery confirmation failed.", 422);
      const output = data as { projectId?: string; revision?: number };
      if (!output.projectId || output.revision !== 1) throw new RecoveryError("INVALID_PACKAGE", "Recovery confirmation failed.", 422);
      return { projectId: output.projectId, revision: output.revision };
    },
  };
}

export function createRecoveryService(store: RecoveryStore) {
  return {
    async inspect(ownerId: string, assetId: string) {
      const bytes = await store.load(ownerId, assetId);
      if (!bytes) throw new RecoveryError("NOT_FOUND", "Recovery file not found.", 404);
      const inspection = await inspectRecoveryZip(bytes);
      const saved = await store.save(ownerId, assetId, inspection);
      return { inspectionId: saved.id, expiresAt: saved.expiresAt, inspectionHash: inspection.inspectionHash, missingAssets: inspection.missingAssets, title: inspection.document.title, platform: inspection.document.platform };
    },
    async confirm(ownerId: string, inspectionId: string, inspectionHash: string, acceptMissingAssets: boolean) {
      const inspection = await store.get(ownerId, inspectionId);
      if (!inspection) throw new RecoveryError("NOT_FOUND", "Recovery inspection not found.", 404);
      if (new Date(inspection.expiresAt) <= new Date()) throw new RecoveryError("INSPECTION_EXPIRED", "Recovery inspection expired. Inspect the package again.", 409);
      if (inspection.inspectionHash !== inspectionHash) throw new RecoveryError("INSPECTION_CHANGED", "Recovery preview changed. Inspect the package again.", 409);
      if (inspection.missingAssets.length > 0 && !acceptMissingAssets) throw new RecoveryError("INVALID_PACKAGE", "Confirm missing assets before restoring.", 422);
      return store.create(ownerId, structuredClone(inspection.document), inspection.id);
    },
  };
}

export function createMemoryRecoveryStore(): RecoveryStore {
  const inspections = new Map<string, { ownerId: string; value: Awaited<ReturnType<typeof inspectRecoveryZip>>; expiresAt: string }>();
  return {
    async load() { return null; },
    async save(ownerId, _assetId, inspection) { const id = randomUUID(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(); inspections.set(id, { ownerId, value: inspection, expiresAt }); return { id, expiresAt }; },
    async get(ownerId, id) { const record = inspections.get(id); return record?.ownerId === ownerId ? { id, inspectionHash: record.value.inspectionHash, document: record.value.document, missingAssets: record.value.missingAssets, expiresAt: record.expiresAt } : null; },
    async create(_ownerId, _document, _inspectionId) { return { projectId: randomUUID(), revision: 1 }; },
  };
}
