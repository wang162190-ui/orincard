import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import {
  AssetUploadError,
  createSupabaseUploadIntentStore,
  createUploadIntentService,
  uploadErrorResponse,
  type UploadIntentInput,
} from "@/server/assets/upload";
import { readServerEnvironment } from "@/server/environment";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";

async function body(request: Request): Promise<UploadIntentInput> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as UploadIntentInput;
  } catch {
    throw new AssetUploadError(
      "INVALID_REQUEST",
      "Request body must be valid JSON.",
      400,
    );
  }
}

// The file itself never passes through here: this route only registers what the client
// says it is about to upload and hands back a Storage authorization, so a 50 MiB body
// never has to fit inside a serverless request.
export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new AssetUploadError(
        "INVALID_REQUEST",
        "This write request did not come from the configured application origin.",
        400,
      );
    }
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    let ownerId: string;
    try {
      ownerId = (await requireVerifiedUser(userClient)).id;
    } catch {
      throw new AssetUploadError(
        "AUTH_REQUIRED",
        "Sign in before uploading a file.",
        401,
      );
    }
    const service = createUploadIntentService({
      store: createSupabaseUploadIntentStore(createAdminSupabaseClient()),
      requestHashSecret: environment.supabaseSecretKey,
    });
    const intent = await service.create(
      ownerId,
      await body(request),
      request.headers.get("idempotency-key") ?? "",
    );
    return Response.json(
      {
        data: {
          assetId: intent.assetId,
          bucket: intent.bucket,
          objectKey: intent.objectKey,
          state: intent.state,
          upload: intent.upload,
        },
        requestId,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return uploadErrorResponse(error, requestId);
  }
}
