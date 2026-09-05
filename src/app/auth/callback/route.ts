import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildAppRedirect, consumeAuthCode, safeNextPath } from "../../../server/mail";
import { createServerSupabaseClient } from "../../../server/supabase";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return new Response("Authentication is not configured.", { status: 503 });
  }

  const cookieStore = await cookies();
  const client = createServerSupabaseClient({
    getAll: () => cookieStore.getAll(),
    set: (name, value, options) => cookieStore.set(name, value, options),
  });
  const accepted = await consumeAuthCode(client, requestUrl.searchParams.get("code"));
  if (!accepted) {
    return NextResponse.redirect(new URL("/login?error=auth_callback", appUrl));
  }

  const next = safeNextPath(requestUrl.searchParams.get("next"));
  return NextResponse.redirect(buildAppRedirect(appUrl, next));
}
