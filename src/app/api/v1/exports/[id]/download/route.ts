import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export class ExportDownloadError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "EXPORT_EXPIRED" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ExportDownloadError";
  }
}

export interface ExportDownloadStore {
  authorize(ownerId: string, exportId: string, now: Date): Promise<{
    readonly bucket: "exports";
    readonly objectPath: string;
    readonly bytes: number;
    readonly mime: string;
    readonly filename: string;
    readonly expiresAt: string;
  }>;
}

function safeFilename(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "orincard-export";
}

export function createAuthorizedDownloadHandler(dependencies: {
  readonly authenticate: () => Promise<string>;
  readonly assertOrigin: (request: Request) => void;
  readonly store: ExportDownloadStore;
  readonly now?: () => Date;
  readonly maxClientBytes?: number;
}) {
  return async (request: Request, exportId: string) => {
    const requestId = randomUUID();
    try {
      dependencies.assertOrigin(request);
      let ownerId: string;
      try {
        ownerId = await dependencies.authenticate();
      } catch {
        throw new ExportDownloadError("AUTH_REQUIRED", "Sign in to download exports.", 401);
      }
      const artifact = await dependencies.store.authorize(ownerId, exportId, dependencies.now?.() ?? new Date());
      return Response.json(
        {
          data: {
            ...artifact,
            filename: safeFilename(artifact.filename),
            maxClientBytes: dependencies.maxClientBytes ?? 50 * 1024 * 1024,
          },
          requestId,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      const failure = error instanceof ExportDownloadError
        ? error
        : new ExportDownloadError("SERVICE_UNAVAILABLE", "Download is temporarily unavailable.", 503, true);
      return Response.json(
        {
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            ...(failure.code === "EXPORT_EXPIRED" ? { canRegenerate: true } : {}),
          },
          requestId,
        },
        { status: failure.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  };
}

export function createSupabaseExportDownloadStore(client: SupabaseClient): ExportDownloadStore {
  return {
    async authorize(ownerId, exportId, now) {
      const { data: record, error } = await client
        .from("exports")
        .select("id,state,expires_at,asset_id,format,projects!inner(state),assets!inner(bucket,object_key,mime,bytes,purpose,state)")
        .eq("id", exportId)
        .eq("owner_id", ownerId)
        .in("projects.state", ["draft", "archived"])
        .maybeSingle();
      if (error) throw new ExportDownloadError("SERVICE_UNAVAILABLE", "Download is temporarily unavailable.", 503, true);
      if (!record || record.state === "deleted") throw new ExportDownloadError("NOT_FOUND", "Export not found.", 404);
      if (record.state === "expired" || new Date(record.expires_at).getTime() <= now.getTime()) {
        throw new ExportDownloadError("EXPORT_EXPIRED", "This export expired. Generate it again from the saved revision.", 410);
      }
      if (record.state !== "ready" || !record.asset_id) {
        throw new ExportDownloadError("SERVICE_UNAVAILABLE", "This export is not ready yet.", 503, true);
      }
      const asset = Array.isArray(record.assets) ? record.assets[0] : record.assets;
      if (!asset || asset.bucket !== "exports" || asset.purpose !== "export" || asset.state !== "ready") {
        throw new ExportDownloadError("NOT_FOUND", "Export not found.", 404);
      }
      const extension = record.format === "pdf" ? "pdf" : "zip";
      return {
        bucket: "exports" as const,
        objectPath: asset.object_key,
        bytes: Number(asset.bytes),
        mime: asset.mime,
        filename: `orincard-${record.format.replace("_zip", "")}.${extension}`,
        expiresAt: record.expires_at,
      };
    },
  };
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    const environment = readServerEnvironment(process.env);
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    const { id } = await context.params;
    return createAuthorizedDownloadHandler({
      authenticate: async () => (await requireVerifiedUser(client)).id,
      assertOrigin: (input) => assertTrustedWriteRequest(input, environment.appUrl),
      store: createSupabaseExportDownloadStore(client),
      maxClientBytes: environment.appEnvironment === "production"
        ? 100 * 1024 * 1024
        : 50 * 1024 * 1024,
    })(request, id);
  } catch {
    return Response.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "Download is temporarily unavailable.", retryable: true }, requestId: randomUUID() },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
