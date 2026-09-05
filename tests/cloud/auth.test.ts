import { describe, expect, it, vi } from "vitest";
import {
  AuthInputError,
  assertFreshSession,
  signInWithEmail,
  signUpWithEmail,
  startGoogleSignIn,
} from "../../src/server/auth";

function authClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" } },
        error: null,
      }),
      signInWithOAuth: vi.fn().mockResolvedValue({ data: { url: null }, error: null }),
      signInWithPassword: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" }, session: { access_token: "token" } },
        error: null,
      }),
      signUp: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1" }, session: null },
        error: null,
      }),
      ...overrides,
    },
  };
}

describe("T021 authentication contract", () => {
  it("rejects malformed email and weak passwords before contacting Supabase", async () => {
    const client = authClient();

    await expect(
      signInWithEmail(client, { email: "not-an-email", password: "long-enough" }),
    ).rejects.toBeInstanceOf(AuthInputError);
    await expect(
      signUpWithEmail(client, {
        email: "person@example.com",
        password: "short",
        emailRedirectTo: "https://app.example/auth/callback",
      }),
    ).rejects.toThrow("at least 8 characters");

    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(client.auth.signUp).not.toHaveBeenCalled();
  });

  it("normalizes email and sends only authentication fields during signup", async () => {
    const client = authClient();

    await signUpWithEmail(client, {
      email: "  PERSON@Example.COM ",
      password: "correct-horse",
      emailRedirectTo: "https://app.example/auth/callback?next=%2F",
    });

    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "correct-horse",
      options: {
        emailRedirectTo: "https://app.example/auth/callback?next=%2F",
      },
    });
    expect(JSON.stringify(client.auth.signUp.mock.calls)).not.toContain(
      "anonymous carousel body",
    );
  });

  it("uses the password endpoint and reports provider errors without a session", async () => {
    const providerError = new Error("Invalid login credentials");
    const client = authClient({
      signInWithPassword: vi.fn().mockResolvedValue({
        data: { user: null, session: null },
        error: providerError,
      }),
    });

    await expect(
      signInWithEmail(client, {
        email: "person@example.com",
        password: "correct-horse",
      }),
    ).rejects.toBe(providerError);
  });

  it("rejects an expired or otherwise unverifiable session", async () => {
    const client = authClient({
      getUser: vi.fn().mockResolvedValue({
        data: { user: null },
        error: new Error("JWT expired"),
      }),
    });

    await expect(assertFreshSession(client)).rejects.toThrow("Session expired");
  });

  it("starts Google PKCE with the supplied trusted callback", async () => {
    const client = authClient();

    await startGoogleSignIn(client, "https://app.example/auth/callback?next=%2F");

    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "https://app.example/auth/callback?next=%2F",
      },
    });
  });
});

const cloud = process.env.ORINCARD_RUN_AUTH_CLOUD === "1" ? describe : describe.skip;

cloud("T021 real development Supabase", () => {
  it("signs in a configured test account and rejects an invalid password", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const email = process.env.ORINCARD_AUTH_TEST_EMAIL;
    const password = process.env.ORINCARD_AUTH_TEST_PASSWORD;
    if (!url || !key || !email || !password) {
      throw new Error(
        "ORINCARD_RUN_AUTH_CLOUD=1 requires the development Supabase URL, publishable key, and auth test account variables.",
      );
    }

    const client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.user?.email).toBe(email);

    const rejected = await client.auth.signInWithPassword({
      email,
      password: `${password}-invalid`,
    });
    expect(rejected.error).not.toBeNull();
    await client.auth.signOut({ scope: "local" });
  });
});
