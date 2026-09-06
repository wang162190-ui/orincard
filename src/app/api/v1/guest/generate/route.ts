import { randomUUID } from "node:crypto";
import { createOpenAIResponsesAdapter, createOpenAIResponsesClient } from "../../../../../server/ai";
import { readServerEnvironment } from "../../../../../server/environment";
import {
  GuestGenerationError,
  createGuestGenerationService,
  createSupabaseGuestGuardStore,
  guestErrorResponse,
  type GuestGenerationBody,
} from "../../../../../server/guest-guards";
import { generateCarouselDocument } from "../../../../../server/generation";
import { createAdminSupabaseClient } from "../../../../../server/supabase";

async function jsonBody(request: Request): Promise<GuestGenerationBody> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as GuestGenerationBody;
  } catch {
    throw new GuestGenerationError(
      "INVALID_REQUEST",
      "Request body must be valid JSON.",
      400,
      false,
    );
  }
}

function networkSubject(request: Request): string {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    ""
  );
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new GuestGenerationError(
        "INVALID_REQUEST",
        "This write request did not come from the configured application origin.",
        400,
        false,
      );
    }
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new GuestGenerationError(
        "SERVICE_UNAVAILABLE",
        "Guest generation is temporarily unavailable. Your text was not saved.",
        503,
        true,
      );
    }
    const ai = createOpenAIResponsesAdapter(createOpenAIResponsesClient(apiKey));
    const service = createGuestGenerationService({
      store: createSupabaseGuestGuardStore(createAdminSupabaseClient()),
      hashSecret: environment.supabaseSecretKey,
      environment: environment.appEnvironment,
      generate: ({ source, options }) => generateCarouselDocument({ ai, source, options }),
    });
    const document = await service.generate(await jsonBody(request), {
      operationKey: request.headers.get("idempotency-key") ?? "",
      networkSubject: networkSubject(request),
    });
    const payload = [
      JSON.stringify({ stage: "write", progress: 100 }),
      JSON.stringify({ data: { document }, requestId }),
    ].join("\n");
    return new Response(`${payload}\n`, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  } catch (error) {
    return guestErrorResponse(error, requestId);
  }
}
