import { cookies } from "next/headers";
import {
  createSupabaseJobStore,
  isJobServiceError,
  requestOwnedJobCancellation,
  triggerRunController,
} from "@/server/jobs";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function trustedOrigin(request: Request): boolean {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return false;
  }
  return request.headers.get("origin") === new URL(appUrl).origin;
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = crypto.randomUUID();
  if (!trustedOrigin(request)) {
    return json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "The request origin is not allowed.",
          retryable: false,
        },
        requestId,
      },
      400,
    );
  }

  let ownerId: string;
  try {
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    ownerId = (await requireVerifiedUser(client)).id;
  } catch {
    return json(
      {
        error: {
          code: "AUTH_REQUIRED",
          message: "Authentication required.",
          retryable: false,
        },
        requestId,
      },
      401,
    );
  }

  try {
    const { id } = await context.params;
    const data = await requestOwnedJobCancellation(
      createSupabaseJobStore(createAdminSupabaseClient()),
      triggerRunController,
      ownerId,
      id,
    );
    const status = ["succeeded", "partial", "failed", "canceled"].includes(
      data.state,
    )
      ? 200
      : 202;
    return json({ data, requestId }, status);
  } catch (error) {
    if (isJobServiceError(error)) {
      return json(
        {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
          requestId,
        },
        error.httpStatus,
      );
    }
    return json(
      {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Job service is temporarily unavailable.",
          retryable: true,
        },
        requestId,
      },
      503,
    );
  }
}
