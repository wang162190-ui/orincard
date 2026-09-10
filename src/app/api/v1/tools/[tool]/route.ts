import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { parseToolRequest, TOOL_IDS, type ToolId } from "@/domain/tools";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { getToolDefinition } from "@/features/tools/registry";
import { toTextWorkerRequest, toVisualWorkerRequest, VISUAL_TOOL_IDS } from "@/server/tools/application";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { TEXT_TOOL_TASK_ID, VISUAL_TOOL_TASK_ID } from "@/trigger/dispatch";

function json(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

async function ownerId() {
  const cookieStore = await cookies();
  const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return (await requireVerifiedUser(client)).id;
}

function toolId(value: string): ToolId {
  if (!TOOL_IDS.includes(value as ToolId)) throw new Error("UNKNOWN_TOOL");
  return value as ToolId;
}

export async function POST(request: Request, context: { readonly params: Promise<{ readonly tool: string }> }) {
  const requestId = randomUUID();
  try {
    assertTrustedWriteRequest(request, readServerEnvironment(process.env).appUrl);
    let owner: string;
    try { owner = await ownerId(); } catch { return json({ error: { code: "AUTH_REQUIRED", message: "Sign in to use tools.", retryable: false }, requestId }, 401); }
    const tool = toolId((await context.params).tool);
    const parsed = parseToolRequest(tool, await request.json());
    const visual = VISUAL_TOOL_IDS.includes(tool as (typeof VISUAL_TOOL_IDS)[number]);
    const inputRef = visual ? toVisualWorkerRequest(parsed) : toTextWorkerRequest(parsed);
    const key = request.headers.get("idempotency-key")?.trim() || randomUUID();
    if (key.length > 200) return json({ error: { code: "INVALID_REQUEST", message: "Idempotency key is too long.", retryable: false }, requestId }, 400);
    const admin = createAdminSupabaseClient();
    const requestHash = createHash("sha256").update(JSON.stringify({ owner, parsed })).digest("hex");
    const inserted = await admin.from("jobs").upsert({ owner_id: owner, project_id: parsed.context?.projectId ?? null, kind: "tool", input_ref: inputRef, idempotency_key: key, request_hash: requestHash }, { onConflict: "owner_id,kind,idempotency_key", ignoreDuplicates: true }).select("id,state").maybeSingle();
    if (inserted.error) throw inserted.error;
    let job = inserted.data;
    if (!job) {
      const existing = await admin.from("jobs").select("id,state,request_hash").eq("owner_id", owner).eq("kind", "tool").eq("idempotency_key", key).single();
      if (existing.error || existing.data.request_hash !== requestHash) return json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "This operation key was already used for different input.", retryable: false }, requestId }, 409);
      job = existing.data;
    }
    if (job.state === "pending_dispatch") {
      const triggerKey = await idempotencyKeys.create(`tool:${job.id}`, { scope: "global" });
      const run = await tasks.trigger(visual ? VISUAL_TOOL_TASK_ID : TEXT_TOOL_TASK_ID, { jobId: job.id, schemaVersion: 1, requestId }, { idempotencyKey: triggerKey });
      await admin.from("jobs").update({ state: "queued", provider_run_id: run.id, updated_at: new Date().toISOString() }).eq("id", job.id).eq("owner_id", owner).eq("state", "pending_dispatch");
    }
    return json({ data: { jobId: job.id, resultType: getToolDefinition(tool).resultType }, requestId }, 202);
  } catch (error) {
    const invalid = error instanceof Error && (error.message === "UNKNOWN_TOOL" || error.name === "ZodError" || error instanceof SyntaxError);
    return json({ error: { code: invalid ? "INVALID_REQUEST" : "SERVICE_UNAVAILABLE", message: invalid ? "Tool request is invalid." : "Tool service is temporarily unavailable.", retryable: !invalid }, requestId }, invalid ? 400 : 503);
  }
}

export async function GET(request: Request, context: { readonly params: Promise<{ readonly tool: string }> }) {
  const requestId = randomUUID();
  try {
    const owner = await ownerId();
    const tool = toolId((await context.params).tool);
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) return json({ error: { code: "INVALID_REQUEST", message: "jobId is required.", retryable: false }, requestId }, 400);
    const result = await createAdminSupabaseClient().from("jobs").select("id,state,progress,result_ref,error_code").eq("id", jobId).eq("owner_id", owner).eq("kind", "tool").maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return json({ error: { code: "NOT_FOUND", message: "Tool result was not found.", retryable: false }, requestId }, 404);
    const resultRef = result.data.result_ref && typeof result.data.result_ref === "object" && !Array.isArray(result.data.result_ref) ? result.data.result_ref as Record<string, unknown> : null;
    // A text candidate is nested under `candidate`; a visual candidate references its stored
    // tool output at the top level and never carries the rendered bytes.
    const candidate = resultRef ? resultRef.candidate ?? (typeof resultRef.tool === "string" ? resultRef : null) : null;
    if (candidate && typeof candidate === "object" && (candidate as { tool?: unknown }).tool !== tool) return json({ error: { code: "NOT_FOUND", message: "Tool result was not found.", retryable: false }, requestId }, 404);
    return json({ data: { jobId, state: result.data.state, progress: result.data.progress, candidate, errorCode: result.data.error_code }, requestId }, 200);
  } catch {
    return json({ error: { code: "AUTH_REQUIRED", message: "Sign in to view tool results.", retryable: false }, requestId }, 401);
  }
}
