import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { isPlanKey, type PlanKey } from "@/domain/entitlements";
import { readServerEnvironment } from "@/server/environment";
import { createAdminSupabaseClient, createServerSupabaseClient } from "@/server/supabase";

const SOURCES = ["pricing", "billing", "home"] as const;
const LOCALES = ["en", "zh-Hans"] as const;
// 邮箱校验故意保持宽松：唯一能证明一个地址存在的方法是发信过去，正则再严也只会
// 把合法地址挡在外面。这里只拦明显不是地址的输入，去重交给 lower(email) 唯一索引。
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type WaitlistRequest = {
  readonly email: string;
  readonly planKey?: Exclude<PlanKey, "free">;
  readonly source: (typeof SOURCES)[number];
  readonly locale: (typeof LOCALES)[number];
};

export function parseWaitlistRequest(value: unknown): WaitlistRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const input = value as Record<string, unknown>;
  // 小写化在这里做，不在数据库里做：唯一约束建在列上，列里存的必须已经是小写，
  // 否则 Foo@x.com 和 foo@x.com 会各占一行。
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) throw new Error("INVALID_REQUEST");
  if (!SOURCES.includes(input.source as WaitlistRequest["source"])) throw new Error("INVALID_REQUEST");
  if (!LOCALES.includes(input.locale as WaitlistRequest["locale"])) throw new Error("INVALID_REQUEST");
  // free 不是可登记的档位——它现在就能用，登记它没有意义，多半是前端传错了。
  if (input.planKey !== undefined && (!isPlanKey(input.planKey) || input.planKey === "free")) throw new Error("INVALID_REQUEST");
  const allowed = ["email", "locale", "source", ...(input.planKey === undefined ? [] : ["planKey"])].sort().join(",");
  if (Object.keys(input).sort().join(",") !== allowed) throw new Error("INVALID_REQUEST");
  return {
    email,
    ...(input.planKey === undefined ? {} : { planKey: input.planKey as Exclude<PlanKey, "free"> }),
    source: input.source as WaitlistRequest["source"],
    locale: input.locale as WaitlistRequest["locale"],
  };
}

export function createWaitlistHandler(dependencies: {
  readonly appUrl: string;
  readonly currentUserId: () => Promise<string | null>;
  readonly record: (entry: WaitlistRequest & { readonly ownerId: string | null }) => Promise<void>;
}) {
  return async (request: Request) => {
    const requestId = randomUUID();
    try {
      if (request.headers.get("origin") !== new URL(dependencies.appUrl).origin) {
        return Response.json({ error: { code: "INVALID_REQUEST", message: "The request origin is not allowed.", retryable: false }, requestId }, { status: 400 });
      }
      const input = parseWaitlistRequest(await request.json());
      // 登记不要求登录——定价页是公开的，要求先注册才能表达付费意向是本末倒置。
      // 已登录就顺手关联账户，失败也不影响登记本身。
      const ownerId = await dependencies.currentUserId().catch(() => null);
      await dependencies.record({ ...input, ownerId });
      // 重复提交返回 201 而不是 409：对提交的人来说「你已经在名单上了」和
      // 「你刚上了名单」是同一件事，区分它们只会泄露某个邮箱是否登记过。
      return Response.json({ data: { recorded: true } , requestId }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const invalid = error instanceof Error && (error.message === "INVALID_REQUEST" || error instanceof SyntaxError);
      return Response.json({ error: { code: invalid ? "INVALID_REQUEST" : "WAITLIST_UNAVAILABLE", message: invalid ? "The waitlist request is invalid." : "The waitlist is temporarily unavailable.", retryable: !invalid }, requestId }, { status: invalid ? 400 : 503 });
    }
  };
}

export async function POST(request: Request) {
  const environment = readServerEnvironment(process.env);
  const cookieStore = await cookies();
  return createWaitlistHandler({
    appUrl: environment.appUrl,
    currentUserId: async () => {
      const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },
    record: async (entry) => {
      // 这张表开了 RLS 且没有任何策略，anon / authenticated 都碰不到，
      // 所以写入必须走 service role。名单里的邮箱因此读不出去。
      const admin = createAdminSupabaseClient();
      const { error } = await admin.from("waitlist_signups").upsert({
        email: entry.email,
        plan_key: entry.planKey ?? null,
        source: entry.source,
        locale: entry.locale,
        owner_id: entry.ownerId,
      }, { onConflict: "email", ignoreDuplicates: true });
      if (error) throw new Error("WAITLIST_UNAVAILABLE");
    },
  })(request);
}
