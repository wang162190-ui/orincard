import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCarouselDocument, type CarouselDocument } from "@/domain/document";
import { BASIC_EXPORT_FORMATS, inspectDeckPreflight, type BasicExportFormat } from "@/render/render-deck";
import type { SlideRenderAsset } from "@/render/slide";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export type ExportPreflightIssue = {
  readonly code: string;
  readonly slideId?: string;
  readonly repairAction: string;
};

export type ExportPreflightSnapshot = {
  readonly projectVersionId: string;
  readonly revision: number;
  readonly document: CarouselDocument;
  readonly issues: readonly ExportPreflightIssue[];
};

export interface ExportPreflightStore {
  load(input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly format: BasicExportFormat;
    readonly options: Readonly<Record<string, unknown>>;
  }): Promise<ExportPreflightSnapshot | null>;
}

export class ExportPreflightError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ExportPreflightError";
  }
}

export async function evaluateProjectExportPreflight(
  store: ExportPreflightStore,
  input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly format: BasicExportFormat;
    readonly options: Readonly<Record<string, unknown>>;
  },
) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new ExportPreflightError("INVALID_REQUEST", "expectedRevision must be a positive integer.", 400);
  }
  if (!BASIC_EXPORT_FORMATS.includes(input.format)) {
    throw new ExportPreflightError("INVALID_REQUEST", "This export format is not available yet.", 400);
  }
  const snapshot = await store.load(input);
  if (!snapshot || snapshot.revision !== input.expectedRevision) {
    throw new ExportPreflightError("NOT_FOUND", "Project version not found.", 404);
  }
  return {
    projectVersionId: snapshot.projectVersionId,
    revision: snapshot.revision,
    documentHash: createHash("sha256").update(JSON.stringify(snapshot.document)).digest("hex"),
    issues: snapshot.issues,
    canExport: snapshot.issues.length === 0,
  };
}

export function createSupabaseExportPreflightStore(client: SupabaseClient): ExportPreflightStore {
  return {
    async load(input) {
      const [{ data: project, error: projectError }, { data: version, error: versionError }] = await Promise.all([
        client
          .from("projects")
          .select("id,revision,state")
          .eq("id", input.projectId)
          .eq("owner_id", input.ownerId)
          .eq("revision", input.expectedRevision)
          .in("state", ["draft", "archived"])
          .maybeSingle(),
        client
          .from("project_versions")
          .select("id,revision,document")
          .eq("project_id", input.projectId)
          .eq("owner_id", input.ownerId)
          .eq("revision", input.expectedRevision)
          .maybeSingle(),
      ]);
      if (projectError || versionError) {
        throw new ExportPreflightError("SERVICE_UNAVAILABLE", "Export checks are temporarily unavailable.", 503, true);
      }
      if (!project || !version) return null;
      const document = parseCarouselDocument(version.document);
      const issues: ExportPreflightIssue[] = [];
      for (const asset of document.assetRefs) {
        if (asset.rightsStatus === "restricted") {
          for (const slide of document.slides.filter((item) =>
            item.assetSlots.some((slot) => slot.assetId === asset.id),
          )) {
            issues.push({
              code: "ASSET_RIGHTS_UNCONFIRMED",
              slideId: slide.id,
              repairAction: "Replace the asset or confirm export rights.",
            });
          }
        }
      }
      const assetIds = document.assetRefs.map((asset) => asset.id).filter((id) => !id.startsWith("local-"));
      const available = new Map<string, {
        id: string;
        state: string;
        accepted_at: string | null;
        bucket: string;
        object_key: string;
        mime: string;
        width: number | null;
        height: number | null;
      }>();
      if (assetIds.length > 0) {
        const { data: assets, error: assetError } = await client
          .from("assets")
          .select("id,state,accepted_at,bucket,object_key,mime,width,height")
          .eq("owner_id", input.ownerId)
          .in("id", assetIds);
        if (assetError) {
          throw new ExportPreflightError("SERVICE_UNAVAILABLE", "Export checks are temporarily unavailable.", 503, true);
        }
        for (const asset of assets ?? []) available.set(asset.id, asset);
        for (const ref of document.assetRefs) {
          const asset = available.get(ref.id);
          if (ref.id.startsWith("local-") || !asset || asset.state !== "ready" || (ref.kind === "generated" && !asset.accepted_at)) {
            for (const slide of document.slides.filter((item) =>
              item.assetSlots.some((slot) => slot.assetId === ref.id),
            )) {
              issues.push({
                code: "ASSET_NOT_READY",
                slideId: slide.id,
                repairAction: "Wait for the asset or replace it before exporting.",
              });
            }
          }
        }
      }
      const renderAssets: Record<string, SlideRenderAsset> = {};
      for (const ref of document.assetRefs) {
        const asset = available.get(ref.id);
        if (!asset || asset.state !== "ready" || (ref.kind === "generated" && !asset.accepted_at)) continue;
        const { data: blob, error: downloadError } = await client.storage.from(asset.bucket).download(asset.object_key);
        if (downloadError || !blob) continue;
        renderAssets[ref.id] = {
          id: ref.id,
          src: `data:${asset.mime};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
          state: "ready",
          alt: "",
          width: asset.width ?? undefined,
          height: asset.height ?? undefined,
        };
      }
      const measured = await inspectDeckPreflight({ document, assets: renderAssets });
      issues.push(...measured.issues);
      const uniqueIssues = issues.filter((issue, index, all) =>
        all.findIndex((candidate) => candidate.code === issue.code && candidate.slideId === issue.slideId) === index,
      );
      return {
        projectVersionId: version.id,
        revision: Number(version.revision),
        document,
        issues: uniqueIssues,
      };
    },
  };
}

function responseError(error: unknown, requestId: string) {
  const failure = error instanceof ExportPreflightError
    ? error
    : new ExportPreflightError("SERVICE_UNAVAILABLE", "Export checks are temporarily unavailable.", 503, true);
  return Response.json(
    { error: { code: failure.code, message: failure.message, retryable: failure.retryable }, requestId },
    { status: failure.status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function createPreflightPostHandler(dependencies: {
  readonly authenticate: () => Promise<string>;
  readonly assertOrigin: (request: Request) => void;
  readonly store: ExportPreflightStore;
}) {
  return async (request: Request, projectId: string) => {
    const requestId = randomUUID();
    try {
      dependencies.assertOrigin(request);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new ExportPreflightError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ExportPreflightError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
      }
      let ownerId: string;
      try {
        ownerId = await dependencies.authenticate();
      } catch {
        throw new ExportPreflightError("AUTH_REQUIRED", "Sign in to export saved projects.", 401);
      }
      const value = body as Record<string, unknown>;
      const data = await evaluateProjectExportPreflight(dependencies.store, {
        ownerId,
        projectId,
        expectedRevision: Number(value.expectedRevision),
        format: value.format as BasicExportFormat,
        options: value.options && typeof value.options === "object" && !Array.isArray(value.options)
          ? value.options as Record<string, unknown>
          : {},
      });
      return Response.json({ data, requestId }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      return responseError(error, requestId);
    }
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
    return createPreflightPostHandler({
      authenticate: async () => (await requireVerifiedUser(client)).id,
      assertOrigin: (input) => assertTrustedWriteRequest(input, environment.appUrl),
      store: createSupabaseExportPreflightStore(client),
    })(request, id);
  } catch (error) {
    return responseError(error, randomUUID());
  }
}
