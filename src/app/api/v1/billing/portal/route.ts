import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createStripeFetchProvider, readStripeBillingConfig, startPortal, type BillingCustomerStore } from "@/server/billing/stripe";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { createSupabaseBillingCustomerStore } from "../checkout/route";

function reply(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

export function createPortalHandler(dependencies: { readonly authenticate: () => Promise<string>; readonly environment: NodeJS.ProcessEnv; readonly store: BillingCustomerStore; readonly provider?: ReturnType<typeof createStripeFetchProvider> }) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      const config = readStripeBillingConfig(dependencies.environment);
      if (request.headers.get("origin") !== config.appUrl) return reply({ error: { code: "INVALID_REQUEST", message: "The request origin is not allowed.", retryable: false }, requestId }, 400);
      let ownerId: string;
      try { ownerId = await dependencies.authenticate(); } catch { return reply({ error: { code: "AUTH_REQUIRED", message: "Sign in to manage billing.", retryable: false }, requestId }, 401); }
      const requestKey = request.headers.get("idempotency-key") ?? "";
      if (!/^[\x21-\x7e]{8,200}$/.test(requestKey)) return reply({ error: { code: "INVALID_REQUEST", message: "A valid Idempotency-Key is required.", retryable: false }, requestId }, 400);
      const url = await startPortal({ ownerId, requestKey, config, store: dependencies.store, provider: dependencies.provider ?? createStripeFetchProvider(config.secretKey) });
      return reply({ data: { url }, requestId }, 200);
    } catch (error) {
      const code = error instanceof Error && error.message === "BILLING_NOT_CONFIGURED" ? "BILLING_NOT_CONFIGURED" : error instanceof Error && error.message === "CUSTOMER_NOT_FOUND" ? "CUSTOMER_NOT_FOUND" : "BILLING_UNAVAILABLE";
      return reply({ error: { code, message: code === "BILLING_NOT_CONFIGURED" ? "Billing is not configured for this environment." : code === "CUSTOMER_NOT_FOUND" ? "No billing customer exists for this account." : "Billing is temporarily unavailable.", retryable: code === "BILLING_UNAVAILABLE" }, requestId }, code === "CUSTOMER_NOT_FOUND" ? 404 : 503);
    }
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return createPortalHandler({ authenticate: async () => (await requireVerifiedUser(userClient)).id, environment: process.env, store: createSupabaseBillingCustomerStore(createAdminSupabaseClient()) })(request);
}
