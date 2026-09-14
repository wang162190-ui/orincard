import { randomUUID } from "node:crypto";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "../../../../../server/ai";
import { readServerEnvironment, type AppEnvironment } from "../../../../../server/environment";
import {
  GuestGenerationError,
  createGuestGenerationService,
  createSupabaseGuestGuardStore,
  guestErrorResponse,
  type GuestGenerationBody,
} from "../../../../../server/guest-guards";
import { generateCarouselDocument } from "../../../../../server/generation";
import { guestAttemptKey } from "../../../../../server/cost";
import {
  createMeasurementCollector,
  registerGuestCostAttempt,
  settleGuestUsage,
} from "../../../../../server/cost-settlement";
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

export function resolveGuestNetworkSubject(
  request: Request,
  environment: AppEnvironment,
): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "";
  return forwarded || (environment === "development" ? "local-development" : "");
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
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new GuestGenerationError(
        "SERVICE_UNAVAILABLE",
        "Guest generation is temporarily unavailable. Your text was not saved.",
        503,
        true,
      );
    }
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey));
    const admin = createAdminSupabaseClient();
    // 访客路径没有 jobs 行，SQL 侧也没人替它登记尝试行，所以和 text tool 一样自己 register。
    // schema 修复重试的多次调用共用同一个 key，收集后合并成一笔结算。
    const collector = createMeasurementCollector();
    const service = createGuestGenerationService({
      store: createSupabaseGuestGuardStore(admin),
      hashSecret: environment.supabaseSecretKey,
      environment: environment.appEnvironment,
      generate: ({ source, options }) =>
        generateCarouselDocument({ ai, source, options, onMeasurement: collector.onMeasurement }),
      cost: {
        register: (guardId) =>
          registerGuestCostAttempt({
            client: admin,
            guardId,
            attemptKey: guestAttemptKey(guardId),
          }),
        settle: async (guardId) => {
          await settleGuestUsage({
            client: admin,
            guardId,
            attemptKey: guestAttemptKey(guardId),
            measurements: collector.collected(),
          });
        },
      },
    });
    const document = await service.generate(await jsonBody(request), {
      operationKey: request.headers.get("idempotency-key") ?? "",
      networkSubject: resolveGuestNetworkSubject(request, environment.appEnvironment),
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
