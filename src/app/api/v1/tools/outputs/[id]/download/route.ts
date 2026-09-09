import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { createSupabaseToolOutputDownloadStore, ToolOutputError, toolOutputErrorResponse } from "@/server/tools/outputs";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    assertTrustedWriteRequest(request, readServerEnvironment(process.env).appUrl);
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(userClient)).id; } catch { throw new ToolOutputError("AUTH_REQUIRED", "Sign in to download tool outputs.", 401); }
    let body: unknown;
    try { body = await request.json(); } catch { throw new ToolOutputError("INVALID_REQUEST", "Request body must be valid JSON.", 400); }
    const jobId = typeof body === "object" && body !== null && !Array.isArray(body) && "jobId" in body ? body.jobId : null;
    if (typeof jobId !== "string") throw new ToolOutputError("INVALID_REQUEST", "jobId is required.", 400);
    const { id } = await context.params;
    const admin = createAdminSupabaseClient();
    const artifact = await createSupabaseToolOutputDownloadStore(admin).authorize(ownerId, id, jobId, new Date());
    const signed = await admin.storage.from(artifact.bucket).createSignedUrl(artifact.objectKey, 60);
    if (signed.error || !signed.data.signedUrl) throw new ToolOutputError("SERVICE_UNAVAILABLE", "Tool output download is temporarily unavailable.", 503, true);
    return Response.json({ data: { downloadUrl: signed.data.signedUrl, mime: artifact.mime, expiresAt: artifact.expiresAt }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return toolOutputErrorResponse(error, requestId); }
}
