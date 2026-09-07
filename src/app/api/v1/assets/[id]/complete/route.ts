import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import {
  AssetUploadError,
  assetValidationDispatcher,
  uploadErrorResponse,
} from "@/server/assets/upload";
import { readServerEnvironment } from "@/server/environment";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

// The asset is read through the caller's own client, so row level security is what
// decides ownership here instead of a comparison this route could get wrong.
async function ownedAsset(
  client: ReturnType<typeof createServerSupabaseClient>,
  assetId: string,
): Promise<{ readonly state: string }> {
  const { data, error } = await client
    .from("assets")
    .select("id,state")
    .eq("id", assetId)
    .maybeSingle();
  if (error) {
    throw new AssetUploadError(
      "SERVICE_UNAVAILABLE",
      "Uploads are temporarily unavailable. Nothing was changed.",
      503,
      true,
    );
  }
  if (!data) {
    // Same answer for someone else's asset and a missing one, so this cannot be used to
    // probe which asset ids exist.
    throw new AssetUploadError("NOT_FOUND", "This upload was not found.", 404);
  }
  return data as { readonly state: string };
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
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
    try {
      await requireVerifiedUser(userClient);
    } catch {
      throw new AssetUploadError(
        "AUTH_REQUIRED",
        "Sign in before finishing an upload.",
        401,
      );
    }
    const { id } = await context.params;
    const asset = await ownedAsset(userClient, id);
    if (asset.state === "ready" || asset.state === "failed") {
      return Response.json(
        { data: { assetId: id, state: asset.state }, requestId },
        { status: 200, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (asset.state === "pending_upload") {
      // Only identifiers cross the queue; the worker downloads the object itself from the
      // bucket the asset row names.
      await assetValidationDispatcher.trigger(
        { assetId: id, schemaVersion: 1, requestId },
        `asset:${id}:validate`,
      );
    }
    return Response.json(
      { data: { assetId: id, state: "validating" }, requestId },
      { status: 202, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return uploadErrorResponse(error, requestId);
  }
}
