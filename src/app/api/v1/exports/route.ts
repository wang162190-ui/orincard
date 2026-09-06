import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export type ExportHistoryRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly projectVersionId: string;
  readonly revision: number;
  readonly format: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly createdAt: string;
};

export interface ExportHistoryStore {
  list(input: {
    readonly ownerId: string;
    readonly projectId?: string;
    readonly limit: number;
  }): Promise<readonly ExportHistoryRecord[]>;
}

export async function listOwnedExportHistory(
  store: ExportHistoryStore,
  input: { readonly ownerId: string; readonly projectId?: string; readonly limit: number },
  now = new Date(),
) {
  const records = await store.list(input);
  return {
    items: records.map((record) => {
      const expired = new Date(record.expiresAt).getTime() <= now.getTime();
      return {
        ...record,
        state: expired && record.state === "ready" ? "expired" : record.state,
        canRegenerate: expired,
      };
    }),
    nextCursor: null,
  };
}

export function createSupabaseExportHistoryStore(client: SupabaseClient): ExportHistoryStore {
  return {
    async list(input) {
      let query = client
        .from("exports")
        .select("id,project_id,project_version_id,format,state,expires_at,created_at,project_versions(revision)")
        .eq("owner_id", input.ownerId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(input.limit);
      if (input.projectId) query = query.eq("project_id", input.projectId);
      const { data, error } = await query;
      if (error) throw new Error("Export history is temporarily unavailable.");
      return (data ?? []).map((row) => {
        const version = Array.isArray(row.project_versions)
          ? row.project_versions[0]
          : row.project_versions;
        return {
          id: row.id,
          projectId: row.project_id,
          projectVersionId: row.project_version_id,
          revision: Number(version?.revision),
          format: row.format,
          state: row.state,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        };
      });
    },
  };
}

export function createExportHistoryGetHandler(dependencies: {
  readonly authenticate: () => Promise<string>;
  readonly store: ExportHistoryStore;
}) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      let ownerId: string;
      try {
        ownerId = await dependencies.authenticate();
      } catch {
        return Response.json(
          { error: { code: "AUTH_REQUIRED", message: "Sign in to view exports.", retryable: false }, requestId },
          { status: 401, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      const url = new URL(request.url);
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const data = await listOwnedExportHistory(dependencies.store, {
        ownerId,
        projectId: url.searchParams.get("projectId") || undefined,
        limit,
      });
      return Response.json({ data, requestId }, { headers: { "Cache-Control": "private, no-store" } });
    } catch {
      return Response.json(
        { error: { code: "SERVICE_UNAVAILABLE", message: "Export history is temporarily unavailable.", retryable: true }, requestId },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  };
}

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    return createExportHistoryGetHandler({
      authenticate: async () => (await requireVerifiedUser(client)).id,
      store: createSupabaseExportHistoryStore(client),
    })(request);
  } catch {
    const requestId = randomUUID();
    return Response.json(
      {
        error: { code: "SERVICE_UNAVAILABLE", message: "Export history is temporarily unavailable.", retryable: true },
        requestId,
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
