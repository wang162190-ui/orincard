import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "@/server/environment";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

const CATEGORIES = ["account", "billing", "export", "copyright", "other"] as const;
const DIAGNOSTIC_TYPES = ["project", "job", "export"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SupportRequest = {
  readonly category: (typeof CATEGORIES)[number];
  readonly message: string;
  readonly diagnosticRefs: readonly { readonly type: (typeof DIAGNOSTIC_TYPES)[number]; readonly id: string }[];
};

export function parseSupportRequest(value: unknown): SupportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const input = value as Record<string, unknown>;
  if (!CATEGORIES.includes(input.category as SupportRequest["category"]) || typeof input.message !== "string" || input.message.trim().length < 10 || input.message.length > 5_000 || !Array.isArray(input.diagnosticRefs) || input.diagnosticRefs.length > 10) throw new Error("INVALID_REQUEST");
  const diagnosticRefs = input.diagnosticRefs.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_REQUEST");
    const ref = item as Record<string, unknown>;
    if (!DIAGNOSTIC_TYPES.includes(ref.type as SupportRequest["diagnosticRefs"][number]["type"]) || typeof ref.id !== "string" || !UUID.test(ref.id) || Object.keys(ref).sort().join(",") !== "id,type") throw new Error("INVALID_REQUEST");
    return { type: ref.type as SupportRequest["diagnosticRefs"][number]["type"], id: ref.id };
  });
  if (Object.keys(input).sort().join(",") !== "category,diagnosticRefs,message") throw new Error("INVALID_REQUEST");
  return { category: input.category as SupportRequest["category"], message: input.message.trim(), diagnosticRefs };
}

export function createSupportHandler(dependencies: { readonly authenticate: () => Promise<{ readonly id: string; readonly email?: string }>; readonly appUrl: string; readonly deliver: (request: SupportRequest & { readonly ownerId: string; readonly replyTo?: string }) => Promise<string> }) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      if (request.headers.get("origin") !== new URL(dependencies.appUrl).origin) return Response.json({ error: { code: "INVALID_REQUEST", message: "The request origin is not allowed.", retryable: false }, requestId }, { status: 400 });
      let user: { readonly id: string; readonly email?: string };
      try { user = await dependencies.authenticate(); } catch { return Response.json({ error: { code: "AUTH_REQUIRED", message: "Sign in to contact support.", retryable: false }, requestId }, { status: 401 }); }
      const input = parseSupportRequest(await request.json());
      const ticketId = await dependencies.deliver({ ...input, ownerId: user.id, replyTo: user.email });
      return Response.json({ data: { ticketId }, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const invalid = error instanceof Error && (error.message === "INVALID_REQUEST" || error instanceof SyntaxError);
      return Response.json({ error: { code: invalid ? "INVALID_REQUEST" : "SUPPORT_UNAVAILABLE", message: invalid ? "Support request is invalid." : "Support is temporarily unavailable.", retryable: !invalid }, requestId }, { status: invalid ? 400 : 503 });
    }
  };
}

export async function POST(request: Request) {
  const environment = readServerEnvironment(process.env);
  const cookieStore = await cookies();
  const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.SUPPORT_EMAIL_FROM?.trim();
  const to = process.env.SUPPORT_EMAIL_TO?.trim();
  return createSupportHandler({
    authenticate: async () => { const user = await requireVerifiedUser(client); return { id: user.id, email: user.email }; },
    appUrl: environment.appUrl,
    deliver: async (input) => {
      if (!apiKey || !from || !to) throw new Error("SUPPORT_UNAVAILABLE");
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], reply_to: input.replyTo, subject: `[Orincard support] ${input.category}`, text: [`Account ID: ${input.ownerId}`, `Category: ${input.category}`, `Selected diagnostic IDs: ${input.diagnosticRefs.map((ref) => `${ref.type}:${ref.id}`).join(", ") || "none"}`, "", input.message].join("\n") }) });
      const result = await response.json() as { readonly id?: unknown };
      if (!response.ok || typeof result.id !== "string") throw new Error("SUPPORT_UNAVAILABLE");
      return result.id;
    },
  })(request);
}
