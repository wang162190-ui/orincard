import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStripeFetchProvider, readStripeBillingConfig, startCheckout, type BillingCustomerStore, type StripeMode } from "@/server/billing/stripe";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export function createSupabaseBillingCustomerStore(client: SupabaseClient): BillingCustomerStore {
  return {
    async find(ownerId, mode) {
      const result = await client.from("billing_customers").select("provider_customer_id").eq("owner_id", ownerId).eq("environment", mode).maybeSingle();
      if (result.error) throw new Error("BILLING_UNAVAILABLE");
      return result.data?.provider_customer_id ?? null;
    },
    async save(ownerId, mode, customerId) {
      const result = await client.from("billing_customers").upsert({ owner_id: ownerId, environment: mode satisfies StripeMode, provider_customer_id: customerId }, { onConflict: "owner_id,environment" }).select("provider_customer_id").single();
      if (result.error || !result.data) throw new Error("BILLING_UNAVAILABLE");
      return result.data.provider_customer_id;
    },
  };
}

function reply(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

export function createCheckoutHandler(dependencies: { readonly authenticate: () => Promise<string>; readonly environment: NodeJS.ProcessEnv; readonly store: BillingCustomerStore; readonly provider?: ReturnType<typeof createStripeFetchProvider> }) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      const config = readStripeBillingConfig(dependencies.environment);
      if (request.headers.get("origin") !== config.appUrl) return reply({ error: { code: "INVALID_REQUEST", message: "The request origin is not allowed.", retryable: false }, requestId }, 400);
      let ownerId: string;
      try { ownerId = await dependencies.authenticate(); } catch { return reply({ error: { code: "AUTH_REQUIRED", message: "Sign in to upgrade.", retryable: false }, requestId }, 401); }
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.planKey !== "string" || !["month", "year"].includes(String(body.interval))) return reply({ error: { code: "INVALID_REQUEST", message: "Choose an available plan and interval.", retryable: false }, requestId }, 400);
      const requestKey = request.headers.get("idempotency-key") ?? "";
      if (!/^[\x21-\x7e]{8,200}$/.test(requestKey)) return reply({ error: { code: "INVALID_REQUEST", message: "A valid Idempotency-Key is required.", retryable: false }, requestId }, 400);
      const url = await startCheckout({ ownerId, planKey: body.planKey, interval: body.interval as "month" | "year", promotionKey: typeof body.promotionKey === "string" ? body.promotionKey : undefined, requestKey, config, store: dependencies.store, provider: dependencies.provider ?? createStripeFetchProvider(config.secretKey) });
      return reply({ data: { url }, requestId }, 200);
    } catch (error) {
      const code = error instanceof Error && error.message === "BILLING_NOT_CONFIGURED" ? "BILLING_NOT_CONFIGURED" : error instanceof Error && error.message === "PLAN_NOT_AVAILABLE" ? "PLAN_NOT_AVAILABLE" : "BILLING_UNAVAILABLE";
      return reply({ error: { code, message: code === "BILLING_NOT_CONFIGURED" ? "Billing is not configured for this environment." : code === "PLAN_NOT_AVAILABLE" ? "This plan is not available." : "Billing is temporarily unavailable.", retryable: code === "BILLING_UNAVAILABLE" }, requestId }, code === "PLAN_NOT_AVAILABLE" ? 400 : 503);
    }
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return createCheckoutHandler({ authenticate: async () => (await requireVerifiedUser(userClient)).id, environment: process.env, store: createSupabaseBillingCustomerStore(createAdminSupabaseClient()) })(request);
}
