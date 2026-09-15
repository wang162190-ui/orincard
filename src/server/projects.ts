import { createHash, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isRevisionConflictCode } from "./db-errors";
import {
  isPlatformKey,
  parseCarouselDocument,
  type CarouselDocument,
  type Platform,
} from "../domain/document";
import { DomainError } from "../domain/errors";

export type ProjectState = "draft" | "archived";

export interface ProjectRecord {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  readonly document: CarouselDocument;
  readonly revision: number;
  readonly state: ProjectState;
  readonly updatedAt: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  readonly revision: number;
  readonly state: ProjectState;
  readonly updatedAt: string;
}

export interface ProjectVersionSummary {
  readonly id: string;
  readonly revision: number;
  readonly reason: "manual" | "pre_generation" | "export" | "restore";
  readonly createdAt: string;
  readonly documentHash: string;
}

export interface ProjectWriteInput {
  readonly ownerId: string;
  readonly title: string;
  readonly platform: Platform;
  readonly document: CarouselDocument;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ProjectSaveInput extends ProjectWriteInput {
  readonly projectId: string;
  readonly expectedRevision: number;
}

export interface ProjectRestoreInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly versionId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface ProjectListInput {
  readonly ownerId: string;
  readonly platform?: Platform;
  readonly state?: ProjectState;
  readonly query?: string;
  readonly limit: number;
}

export interface ProjectStore {
  create(input: ProjectWriteInput): Promise<ProjectRecord>;
  get(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
  list(input: ProjectListInput): Promise<readonly ProjectSummary[]>;
  save(input: ProjectSaveInput): Promise<ProjectRecord>;
  listVersions(ownerId: string, projectId: string, limit: number): Promise<readonly ProjectVersionSummary[]>;
  restore(input: ProjectRestoreInput): Promise<ProjectRecord>;
}

export type ProjectServiceErrorCode =
  | "INVALID_REQUEST"
  | "MIGRATION_CONSENT_REQUIRED"
  | "AUTH_REQUIRED"
  | "ACCOUNT_DISABLED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_EXPIRED"
  | "SERVICE_UNAVAILABLE";

export class ProjectServiceError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ProjectServiceErrorCode,
    message: string,
    readonly status: number,
    retryable = false,
  ) {
    super(message);
    this.name = "ProjectServiceError";
    this.retryable = retryable;
  }
}

interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  readonly document: unknown;
  readonly revision: number;
  readonly state: ProjectState;
  readonly updated_at: string;
}

interface ProjectVersionRow {
  readonly id: string;
  readonly revision: number;
  readonly document: unknown;
  readonly reason: ProjectVersionSummary["reason"];
  readonly created_at: string;
}

interface DatabaseFailure extends Error {
  readonly code?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    document: parseCarouselDocument(row.document),
    revision: Number(row.revision),
    state: row.state,
    updatedAt: row.updated_at,
  };
}

function summaryFromRow(row: Omit<ProjectRow, "document">): ProjectSummary {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    revision: Number(row.revision),
    state: row.state,
    updatedAt: row.updated_at,
  };
}

function versionFromRow(row: ProjectVersionRow): ProjectVersionSummary {
  return {
    id: row.id,
    revision: Number(row.revision),
    reason: row.reason,
    createdAt: row.created_at,
    documentHash: projectDocumentHash(parseCarouselDocument(row.document)),
  };
}

function databaseFailure(error: unknown): DatabaseFailure {
  if (error instanceof Error) {
    return error;
  }
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Database request failed";
  return Object.assign(new Error(message), {
    code:
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined,
  });
}

function throwDatabaseError(error: unknown): never {
  const failure = databaseFailure(error);
  if (isRevisionConflictCode(failure.code)) {
    throw new ProjectServiceError(
      "VERSION_CONFLICT",
      "This project changed in another tab. Keep your local copy or load the cloud version.",
      409,
    );
  }
  if (failure.code === "23505") {
    throw new ProjectServiceError(
      "IDEMPOTENCY_CONFLICT",
      "This operation key was already used for different content.",
      409,
    );
  }
  if (failure.code === "55000") {
    throw new ProjectServiceError(
      "OPERATION_EXPIRED",
      "This saved operation has expired. Start a new save operation.",
      410,
    );
  }
  if (failure.code === "42501" && failure.message === "account is not active") {
    throw new ProjectServiceError(
      "ACCOUNT_DISABLED",
      "This account cannot access projects.",
      403,
    );
  }
  if (failure.code === "42501") {
    throw new ProjectServiceError("NOT_FOUND", "Project not found.", 404);
  }
  throw new ProjectServiceError(
    "SERVICE_UNAVAILABLE",
    "Projects are temporarily unavailable. Your local draft is unchanged.",
    503,
    true,
  );
}

function requireIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ProjectServiceError(
      "INVALID_REQUEST",
      "Idempotency-Key must contain 8 to 200 visible ASCII characters.",
      400,
    );
  }
  return value;
}

function requireExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ProjectServiceError(
      "INVALID_REQUEST",
      "expectedRevision must be a positive integer.",
      400,
    );
  }
  return Number(value);
}

function parseDocument(input: unknown): CarouselDocument {
  try {
    return parseCarouselDocument(input);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ProjectServiceError(
        "INVALID_REQUEST",
        "The project document is invalid or unsupported.",
        422,
      );
    }
    throw error;
  }
}

function requestHash(
  secret: string,
  operation: string,
  input: Readonly<Record<string, unknown>>,
): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify({ operation, ...input }))
    .digest("hex");
}

function projectIdFromRpc(data: unknown): string {
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value !== "object" || value === null) {
    throw new Error("Project RPC returned no project");
  }
  const id =
    "projectId" in value
      ? value.projectId
      : "project_id" in value
        ? value.project_id
        : "id" in value
          ? value.id
          : null;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new Error("Project RPC returned an invalid project ID");
  }
  return id;
}

export function createSupabaseProjectStore(client: SupabaseClient): ProjectStore {
  async function get(ownerId: string, projectId: string): Promise<ProjectRecord | null> {
    const { data, error } = await client
      .from("projects")
      .select("id,title,platform,document,revision,state,updated_at")
      .eq("owner_id", ownerId)
      .eq("id", projectId)
      .in("state", ["draft", "archived"])
      .maybeSingle();
    if (error) {
      throw databaseFailure(error);
    }
    return data ? projectFromRow(data as ProjectRow) : null;
  }

  async function readWrittenProject(ownerId: string, data: unknown) {
    const written = await get(ownerId, projectIdFromRpc(data));
    if (!written) {
      throw Object.assign(new Error("project is not accessible"), { code: "42501" });
    }
    return written;
  }

  return {
    async create(input) {
      const { data, error } = await client.rpc("server_create_project", {
        p_owner_id: input.ownerId,
        p_title: input.title,
        p_platform: input.platform,
        p_document: input.document,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error) {
        throw databaseFailure(error);
      }
      return readWrittenProject(input.ownerId, data);
    },

    get,

    async list(input) {
      let query = client
        .from("projects")
        .select("id,title,platform,revision,state,updated_at")
        .eq("owner_id", input.ownerId)
        .in("state", input.state ? [input.state] : ["draft", "archived"])
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(input.limit);
      if (input.platform) {
        query = query.eq("platform", input.platform);
      }
      if (input.query) {
        query = query.ilike("title", `%${input.query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      }
      const { data, error } = await query;
      if (error) {
        throw databaseFailure(error);
      }
      return (data ?? []).map((row) =>
        summaryFromRow(row as Omit<ProjectRow, "document">),
      );
    },

    async save(input) {
      const { data, error } = await client.rpc("server_save_project", {
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_expected_revision: input.expectedRevision,
        p_title: input.title,
        p_platform: input.platform,
        p_document: input.document,
        p_reason: "manual",
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error) {
        throw databaseFailure(error);
      }
      return readWrittenProject(input.ownerId, data);
    },

    async listVersions(ownerId, projectId, limit) {
      const { data, error } = await client
        .from("project_versions")
        .select("id,revision,document,reason,created_at")
        .eq("owner_id", ownerId)
        .eq("project_id", projectId)
        .order("revision", { ascending: false })
        .limit(limit);
      if (error) throw databaseFailure(error);
      return (data ?? []).map((row) => versionFromRow(row as ProjectVersionRow));
    },

    async restore(input) {
      const { data, error } = await client.rpc("server_restore_project", {
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_version_id: input.versionId,
        p_expected_revision: input.expectedRevision,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error) throw databaseFailure(error);
      return readWrittenProject(input.ownerId, data);
    },
  };
}

export function createProjectService(input: {
  readonly store: ProjectStore;
  readonly requestHashSecret: string;
}) {
  if (!input.requestHashSecret) {
    throw new Error("A server-only request hash secret is required");
  }

  return {
    async create(
      ownerId: string,
      body: {
        readonly document: unknown;
        readonly localDraftId?: unknown;
        readonly explicitMigrationConsent?: unknown;
      },
      idempotencyKey: string,
    ) {
      const document = parseDocument(body.document);
      if (body.localDraftId !== undefined) {
        if (
          typeof body.localDraftId !== "string" ||
          !body.localDraftId.startsWith("local-")
        ) {
          throw new ProjectServiceError(
            "INVALID_REQUEST",
            "localDraftId must use the local- prefix.",
            400,
          );
        }
        if (body.explicitMigrationConsent !== true) {
          throw new ProjectServiceError(
            "MIGRATION_CONSENT_REQUIRED",
            "Confirm before moving this local draft into your account.",
            400,
          );
        }
      }
      const key = requireIdempotencyKey(idempotencyKey);
      const hash = requestHash(input.requestHashSecret, "create_project", {
        document,
        localDraftId: body.localDraftId ?? null,
      });
      try {
        return await input.store.create({
          ownerId,
          title: document.title,
          platform: document.platform,
          document,
          idempotencyKey: key,
          requestHash: hash,
        });
      } catch (error) {
        throwDatabaseError(error);
      }
    },

    async get(ownerId: string, projectId: string) {
      if (!UUID_PATTERN.test(projectId)) {
        throw new ProjectServiceError("NOT_FOUND", "Project not found.", 404);
      }
      try {
        const result = await input.store.get(ownerId, projectId);
        if (!result) {
          throw new ProjectServiceError("NOT_FOUND", "Project not found.", 404);
        }
        return result;
      } catch (error) {
        if (error instanceof ProjectServiceError) {
          throw error;
        }
        throwDatabaseError(error);
      }
    },

    async list(
      ownerId: string,
      filters: {
        readonly platform?: unknown;
        readonly state?: unknown;
        readonly query?: unknown;
        readonly limit?: unknown;
      },
    ) {
      const platform = filters.platform;
      // 从 platformPresets 派生，见 src/domain/document.ts 的注释。
      if (platform !== undefined && !isPlatformKey(platform)) {
        throw new ProjectServiceError("INVALID_REQUEST", "Invalid platform.", 400);
      }
      const state = filters.state;
      if (state !== undefined && state !== "draft" && state !== "archived") {
        throw new ProjectServiceError("INVALID_REQUEST", "Invalid project state.", 400);
      }
      const query =
        typeof filters.query === "string" ? filters.query.trim().slice(0, 200) : undefined;
      const limit =
        filters.limit === undefined
          ? 20
          : Number.isSafeInteger(Number(filters.limit))
            ? Math.min(50, Math.max(1, Number(filters.limit)))
            : 20;
      try {
        return await input.store.list({
          ownerId,
          platform: platform as Platform | undefined,
          state: state as ProjectState | undefined,
          query: query || undefined,
          limit,
        });
      } catch (error) {
        throwDatabaseError(error);
      }
    },

    async save(
      ownerId: string,
      projectId: string,
      body: { readonly expectedRevision: unknown; readonly document: unknown },
      idempotencyKey: string,
    ) {
      if (!UUID_PATTERN.test(projectId)) {
        throw new ProjectServiceError("NOT_FOUND", "Project not found.", 404);
      }
      const expectedRevision = requireExpectedRevision(body.expectedRevision);
      const document = parseDocument(body.document);
      const key = requireIdempotencyKey(idempotencyKey);
      const hash = requestHash(input.requestHashSecret, "save_project", {
        projectId,
        expectedRevision,
        document,
      });
      try {
        return await input.store.save({
          ownerId,
          projectId,
          expectedRevision,
          title: document.title,
          platform: document.platform,
          document,
          idempotencyKey: key,
          requestHash: hash,
        });
      } catch (error) {
        throwDatabaseError(error);
      }
    },

    async listVersions(ownerId: string, projectId: string, limit: unknown = 30) {
      if (!UUID_PATTERN.test(projectId)) {
        throw new ProjectServiceError("NOT_FOUND", "Project not found.", 404);
      }
      const safeLimit = Number.isSafeInteger(Number(limit)) ? Math.min(50, Math.max(1, Number(limit))) : 30;
      try {
        // Confirming the current project first ensures a guessed project ID and a project
        // with no versions both produce the same owner-safe response.
        const project = await input.store.get(ownerId, projectId);
        if (!project) throw new ProjectServiceError("NOT_FOUND", "Project not found.", 404);
        return await input.store.listVersions(ownerId, projectId, safeLimit);
      } catch (error) {
        if (error instanceof ProjectServiceError) throw error;
        throwDatabaseError(error);
      }
    },

    async restore(
      ownerId: string,
      projectId: string,
      body: { readonly versionId: unknown; readonly expectedRevision: unknown },
      idempotencyKey: string,
    ) {
      if (!UUID_PATTERN.test(projectId) || typeof body.versionId !== "string" || !UUID_PATTERN.test(body.versionId)) {
        throw new ProjectServiceError("NOT_FOUND", "Project version not found.", 404);
      }
      const expectedRevision = requireExpectedRevision(body.expectedRevision);
      const key = requireIdempotencyKey(idempotencyKey);
      const hash = requestHash(input.requestHashSecret, "restore_project", { projectId, versionId: body.versionId, expectedRevision });
      try {
        return await input.store.restore({
          ownerId,
          projectId,
          versionId: body.versionId,
          expectedRevision,
          idempotencyKey: key,
          requestHash: hash,
        });
      } catch (error) {
        throwDatabaseError(error);
      }
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;

export function projectDocumentHash(document: CarouselDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

export function projectErrorResponse(error: unknown, requestId: string): Response {
  const failure =
    error instanceof ProjectServiceError
      ? error
      : new ProjectServiceError(
          "SERVICE_UNAVAILABLE",
          "Projects are temporarily unavailable. Your local draft is unchanged.",
          503,
          true,
        );
  return Response.json(
    {
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      requestId,
    },
    { status: failure.status },
  );
}

export function assertTrustedWriteRequest(request: Request, appUrl: string): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(appUrl).origin) {
    throw new ProjectServiceError(
      "INVALID_REQUEST",
      "This write request did not come from the configured application origin.",
      400,
    );
  }
}
