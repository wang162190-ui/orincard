"use client";

import { createBrowserClient } from "@supabase/ssr";

type BrowserEnvironmentInput = Readonly<Record<string, string | undefined>>;

export function readBrowserEnvironment(environment: BrowserEnvironmentInput) {
  const supabaseUrl = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabasePublishableKey =
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl) {
    throw new Error("Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
  }
  try {
    new URL(supabaseUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid URL");
  }
  if (
    !supabasePublishableKey?.startsWith("sb_publishable_") ||
    supabasePublishableKey.length <= "sb_publishable_".length
  ) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key",
    );
  }
  return { supabaseUrl, supabasePublishableKey };
}

export function createBrowserSupabaseClient() {
  const environment = readBrowserEnvironment({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });

  return createBrowserClient(
    environment.supabaseUrl,
    environment.supabasePublishableKey,
  );
}
