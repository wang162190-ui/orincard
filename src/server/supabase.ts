import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { readServerEnvironment } from "./environment";

interface Cookie {
  readonly name: string;
  readonly value: string;
}

interface CookieToSet extends Cookie {
  readonly options?: Record<string, unknown>;
}

export interface SupabaseCookieStore {
  getAll(): Cookie[] | Promise<Cookie[]>;
  set(name: string, value: string, options?: Record<string, unknown>): void;
}

export function createServerSupabaseClient(
  cookieStore: SupabaseCookieStore,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = readServerEnvironment(environment);
  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookies: CookieToSet[]) => {
        for (const cookie of cookies) {
          cookieStore.set(cookie.name, cookie.value, cookie.options);
        }
      },
    },
  });
}

export function createAdminSupabaseClient(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = readServerEnvironment(environment);
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function requireVerifiedUser(client: SupabaseClient): Promise<User> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new Error("Authentication required");
  }
  return data.user;
}
