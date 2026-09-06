import { cookies } from "next/headers";
import {
  createSupabaseJobStore,
  getOwnedJobStatus,
  isJobServiceError,
} from "@/server/jobs";
import {
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = crypto.randomUUID();
  try {
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    const user = await requireVerifiedUser(client);
    const { id } = await context.params;
    const data = await getOwnedJobStatus(
      createSupabaseJobStore(client),
      user.id,
      id,
    );
    return response({ data, requestId }, 200);
  } catch (error) {
    if (isJobServiceError(error)) {
      return response(
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
    return response(
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
}
