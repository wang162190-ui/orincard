import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { CarouselDocument } from "../../../../../../domain/document";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "../../../../../../server/ai";
import { readServerEnvironment } from "../../../../../../server/environment";
import {
  GenerationError,
  confirmRegenerationCandidate,
  createRegenerationCandidate,
  createSupabaseRegenerationStore,
  generateCarouselDocument,
  generationErrorResponse,
  type GenerationOptions,
} from "../../../../../../server/generation";
import { createProjectService, createSupabaseProjectStore } from "../../../../../../server/projects";
import type { SourceRecord } from "../../../../../../server/sources";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../../../../server/supabase";

function sourceFromProject(
  ownerId: string,
  projectId: string,
  document: CarouselDocument,
): SourceRecord {
  const text = document.slides
    .flatMap((slide) => [
      slide.eyebrow,
      slide.title,
      ...slide.bodyBlocks.flatMap((block) =>
        block.kind === "bullets" ? block.items : [block.text],
      ),
      slide.cta,
    ])
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const reference = document.slides
    .flatMap((slide) => slide.bodyBlocks)
    .flatMap((block) => block.sourceRefs ?? [])[0];
  return {
    id: reference?.sourceId ?? projectId,
    ownerId,
    kind: "text",
    metadata: { characterCount: Array.from(text).length },
    segments: [{ segmentId: reference?.segmentId ?? `local-regeneration-${projectId}`, text }],
    state: "ready",
    expiresAt: new Date(0).toISOString(),
  };
}

async function bodyFrom(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new GenerationError("INVALID_REQUEST", "Request body must be valid JSON.", false, 400);
  }
}

export async function POST(
  request: Request,
  contextInput: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new GenerationError("INVALID_REQUEST", "Untrusted request origin.", false, 400);
    }
    const cookieStore = await cookies();
    const user = await requireVerifiedUser(createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    })).catch(() => {
      throw new GenerationError("NOT_FOUND", "Project not found.", false, 404);
    });
    const body = await bodyFrom(request);
    const { id } = await contextInput.params;
    const admin = createAdminSupabaseClient();
    const store = createSupabaseRegenerationStore(admin);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";

    if (body.action === "confirm") {
      const result = await confirmRegenerationCandidate({
        ownerId: user.id,
        projectId: id,
        candidateJobId: String(body.candidateJobId ?? ""),
        expectedRevision: Number(body.expectedRevision),
        mode: String(body.mode ?? "") as "replace" | "save_copy",
        confirmed: body.confirmed === true,
        idempotencyKey,
        hashSecret: environment.supabaseSecretKey,
        store,
      });
      return Response.json(
        { data: result, requestId },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new GenerationError(
        "SERVICE_UNAVAILABLE",
        "Regeneration is temporarily unavailable. Your project was not changed.",
        true,
        503,
      );
    }
    const project = await createProjectService({
      store: createSupabaseProjectStore(admin),
      requestHashSecret: environment.supabaseSecretKey,
    }).get(user.id, id);
    if (typeof body.options !== "object" || body.options === null || Array.isArray(body.options)) {
      throw new GenerationError("INVALID_REQUEST", "Generation options are invalid.", false, 400);
    }
    const options = body.options as unknown as GenerationOptions;
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey));
    const candidate = await createRegenerationCandidate({
      ownerId: user.id,
      projectId: id,
      projectRevision: Number(body.expectedRevision),
      document: project.document,
      options,
      confirmed: body.confirmed === true,
      idempotencyKey,
      hashSecret: environment.supabaseSecretKey,
      environment: environment.appEnvironment,
      store,
      generate: ({ document, options: generationOptions }) =>
        generateCarouselDocument({
          ai,
          source: sourceFromProject(user.id, id, document),
          options: generationOptions,
        }),
    });
    return Response.json(
      { data: { jobId: candidate.candidateJobId, candidate }, requestId },
      { status: 202, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return generationErrorResponse(error, requestId);
  }
}
