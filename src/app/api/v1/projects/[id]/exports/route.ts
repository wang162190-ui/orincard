import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BASIC_EXPORT_FORMATS, type BasicExportFormat } from "@/render/render-deck";
import { readServerEnvironment } from "@/server/environment";
import { createSupabaseJobStore, dispatchPendingJob } from "@/server/jobs";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { basicExportTriggerDispatcher } from "@/trigger/export";

export type CreatedProjectExport = {
  readonly exportId: string;
  readonly jobId: string;
  readonly format: BasicExportFormat;
};

export interface ProjectExportStore {
  create(input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly formats: readonly BasicExportFormat[];
    readonly options: Readonly<Record<string, unknown>>;
    readonly confirmedWarnings: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<readonly CreatedProjectExport[]>;
}

export class ProjectExportError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "VERSION_CONFLICT" | "EXPORT_PREFLIGHT_FAILED" | "IDEMPOTENCY_CONFLICT" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProjectExportError";
  }
}

export async function createProjectExports(
  store: ProjectExportStore,
  input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly formats: readonly BasicExportFormat[];
    readonly options: Readonly<Record<string, unknown>>;
    readonly confirmedWarnings: readonly string[];
    readonly idempotencyKey: string;
  },
  dispatch: (jobId: string) => Promise<void>,
) {
  const formats = [...new Set(input.formats)];
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    formats.length < 1 ||
    formats.some((format) => !BASIC_EXPORT_FORMATS.includes(format)) ||
    !input.idempotencyKey.trim()
  ) {
    throw new ProjectExportError("INVALID_REQUEST", "A revision, format, and Idempotency-Key are required.", 400);
  }
  const exports = await store.create({ ...input, formats });
  for (const created of exports) {
    await dispatch(created.jobId);
  }
  return { revision: input.expectedRevision, exports };
}

export function createSupabaseProjectExportStore(client: SupabaseClient): ProjectExportStore {
  return {
    async create(input) {
      const requestHash = createHash("sha256").update(JSON.stringify({
        projectId: input.projectId,
        expectedRevision: input.expectedRevision,
        formats: input.formats,
        options: input.options,
        confirmedWarnings: input.confirmedWarnings,
      })).digest("hex");
      const { data, error } = await client.rpc("server_create_exports", {
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_expected_revision: input.expectedRevision,
        p_formats: input.formats,
        p_options: input.options,
        p_confirmed_warnings: input.confirmedWarnings,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: requestHash,
      });
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === "40001") throw new ProjectExportError("VERSION_CONFLICT", "This project changed. Run export checks again.", 409);
        if (code === "23505") throw new ProjectExportError("IDEMPOTENCY_CONFLICT", "This export key was already used with different options.", 409);
        if (code === "P0001") throw new ProjectExportError("EXPORT_PREFLIGHT_FAILED", "Fix the listed export issues before retrying.", 422);
        throw new ProjectExportError("SERVICE_UNAVAILABLE", "Export creation is temporarily unavailable.", 503, true);
      }
      if (!Array.isArray(data)) throw new ProjectExportError("SERVICE_UNAVAILABLE", "Export creation returned no records.", 503, true);
      return data.map((row) => ({
        exportId: row.export_id,
        jobId: row.job_id,
        format: row.format as BasicExportFormat,
      }));
    },
  };
}

function errorResponse(error: unknown, requestId: string) {
  const failure = error instanceof ProjectExportError
    ? error
    : new ProjectExportError("SERVICE_UNAVAILABLE", "Export creation is temporarily unavailable.", 503, true);
  return Response.json(
    { error: { code: failure.code, message: failure.message, retryable: failure.retryable }, requestId },
    { status: failure.status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function createProjectExportsPostHandler(dependencies: {
  readonly authenticate: () => Promise<string>;
  readonly assertOrigin: (request: Request) => void;
  readonly store: ProjectExportStore;
  readonly dispatch: (jobId: string) => Promise<void>;
}) {
  return async (request: Request, projectId: string) => {
    const requestId = randomUUID();
    try {
      dependencies.assertOrigin(request);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ProjectExportError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ProjectExportError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
      }
      let ownerId: string;
      try {
        ownerId = await dependencies.authenticate();
      } catch {
        throw new ProjectExportError("AUTH_REQUIRED", "Sign in to export saved projects.", 401);
      }
      const value = body as Record<string, unknown>;
      const data = await createProjectExports(
        dependencies.store,
        {
          ownerId,
          projectId,
          expectedRevision: Number(value.expectedRevision),
          formats: Array.isArray(value.formats) ? value.formats as BasicExportFormat[] : [],
          options: value.options && typeof value.options === "object" && !Array.isArray(value.options) ? value.options as Record<string, unknown> : {},
          confirmedWarnings: Array.isArray(value.confirmedWarnings) ? value.confirmedWarnings.filter((item): item is string => typeof item === "string") : [],
          idempotencyKey: request.headers.get("idempotency-key") ?? "",
        },
        dependencies.dispatch,
      );
      return Response.json({ data, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  try {
    const environment = readServerEnvironment(process.env);
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    const admin = createAdminSupabaseClient();
    const jobs = createSupabaseJobStore(admin);
    const { id } = await context.params;
    return createProjectExportsPostHandler({
      authenticate: async () => (await requireVerifiedUser(client)).id,
      assertOrigin: (input) => assertTrustedWriteRequest(input, environment.appUrl),
      store: createSupabaseProjectExportStore(admin),
      dispatch: async (jobId) => {
        await dispatchPendingJob(jobs, basicExportTriggerDispatcher, jobId, randomUUID());
      },
    })(request, id);
  } catch (error) {
    return errorResponse(error, randomUUID());
  }
}
