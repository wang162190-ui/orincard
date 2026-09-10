import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isRevisionConflictCode } from "./db-errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;

export type ProjectLibraryResult = Readonly<{ projectId: string; revision: number; state: "draft" | "archived" }>;

export class ProjectLibraryError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "OPERATION_EXPIRED" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProjectLibraryError";
  }
}

function requireProjectId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new ProjectLibraryError("NOT_FOUND", "Project not found.", 404);
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ProjectLibraryError("INVALID_REQUEST", "expectedRevision must be a positive integer.", 400);
  return Number(value);
}

function requireIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw new ProjectLibraryError("INVALID_REQUEST", "Idempotency-Key must contain 8 to 200 visible ASCII characters.", 400);
  return value;
}

function resultFrom(value: unknown): ProjectLibraryResult {
  const data = Array.isArray(value) ? value[0] : value;
  if (!data || typeof data !== "object") throw new Error("Project operation returned no result");
  const projectId = "projectId" in data ? data.projectId : null;
  const revision = "revision" in data ? Number(data.revision) : NaN;
  const state = "state" in data ? data.state : null;
  if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId) || !Number.isSafeInteger(revision) || (state !== "draft" && state !== "archived")) {
    throw new Error("Project operation returned an invalid result");
  }
  return { projectId, revision, state };
}

function mapDatabaseError(error: Readonly<{ code?: string }>): never {
  if (isRevisionConflictCode(error.code)) throw new ProjectLibraryError("VERSION_CONFLICT", "This project changed in another tab. Refresh and try again.", 409);
  if (error.code === "23505") throw new ProjectLibraryError("IDEMPOTENCY_CONFLICT", "This operation key was already used for a different request.", 409);
  if (error.code === "55000") throw new ProjectLibraryError("OPERATION_EXPIRED", "This operation has expired. Start a new operation.", 410);
  if (error.code === "42501") throw new ProjectLibraryError("NOT_FOUND", "Project not found.", 404);
  throw new ProjectLibraryError("SERVICE_UNAVAILABLE", "The project library is temporarily unavailable.", 503, true);
}

export function createProjectLibraryService(input: { readonly client: SupabaseClient; readonly requestHashSecret: string }) {
  if (!input.requestHashSecret) throw new Error("A server-only request hash secret is required");

  async function mutate(operation: "duplicate" | "archive", ownerId: string, projectIdInput: unknown, expectedRevisionInput: unknown, idempotencyKeyInput: string): Promise<ProjectLibraryResult> {
    const projectId = requireProjectId(projectIdInput);
    const expectedRevision = requireRevision(expectedRevisionInput);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyInput);
    const requestHash = createHmac("sha256", input.requestHashSecret).update(JSON.stringify({ operation, projectId, expectedRevision })).digest("hex");
    const { data, error } = await input.client.rpc(`server_${operation}_project`, {
      p_owner_id: ownerId,
      p_project_id: projectId,
      p_expected_revision: expectedRevision,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
    });
    if (error) mapDatabaseError(error);
    try { return resultFrom(data); } catch { throw new ProjectLibraryError("SERVICE_UNAVAILABLE", "The project library returned an invalid response.", 503, true); }
  }

  return {
    duplicate: (ownerId: string, projectId: unknown, expectedRevision: unknown, key: string) => mutate("duplicate", ownerId, projectId, expectedRevision, key),
    archive: (ownerId: string, projectId: unknown, expectedRevision: unknown, key: string) => mutate("archive", ownerId, projectId, expectedRevision, key),
  };
}

export function projectLibraryErrorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof ProjectLibraryError ? error : new ProjectLibraryError("SERVICE_UNAVAILABLE", "The project library is temporarily unavailable.", 503, true);
  return Response.json(
    { error: { code: known.code, message: known.message, retryable: known.retryable }, requestId },
    { status: known.status, headers: { "Cache-Control": "private, no-store" } },
  );
}
