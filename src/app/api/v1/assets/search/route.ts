import { cookies } from "next/headers";
import { createPexelsClient, PexelsError } from "@/server/assets/pexels";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: () => undefined });
    try { await requireVerifiedUser(client); }
    catch { throw new PexelsError("AUTH_REQUIRED", "Sign in before searching stock images.", 401); }
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const orientation = url.searchParams.get("orientation");
    const result = await createPexelsClient(process.env.PEXELS_API_KEY?.trim() ?? "").search({ query: url.searchParams.get("query") ?? "", orientation: orientation === "landscape" || orientation === "portrait" || orientation === "square" ? orientation : undefined, page: Number.isInteger(page) && page > 0 ? page : 1 });
    return Response.json({ data: result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const failure = error instanceof PexelsError ? error : new PexelsError("UPSTREAM_UNAVAILABLE", "The stock image service is temporarily unavailable.", 503, true);
    return Response.json({ error: { code: failure.code, message: failure.message, retryable: failure.retryable } }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
  }
}
