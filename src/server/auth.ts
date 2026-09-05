import type { User } from "@supabase/supabase-js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MINIMUM_PASSWORD_LENGTH = 8;

interface ProviderErrorResult {
  readonly error: Error | null;
}

interface PasswordResult extends ProviderErrorResult {
  readonly data: {
    readonly session: unknown | null;
    readonly user: User | null;
  };
}

export interface AuthClient {
  readonly auth: {
    getUser(): Promise<{
      readonly data: { readonly user: User | null };
      readonly error: Error | null;
    }>;
    signInWithOAuth(input: {
      readonly provider: "google";
      readonly options: { readonly redirectTo: string };
    }): Promise<ProviderErrorResult>;
    signInWithPassword(input: {
      readonly email: string;
      readonly password: string;
    }): Promise<PasswordResult>;
    signUp(input: {
      readonly email: string;
      readonly password: string;
      readonly options: { readonly emailRedirectTo: string };
    }): Promise<PasswordResult>;
  };
}

export class AuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthInputError";
  }
}

function credentials(input: { readonly email: string; readonly password: string }) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new AuthInputError("Enter a valid email address.");
  }
  if (input.password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new AuthInputError("Password must be at least 8 characters.");
  }
  return { email, password: input.password };
}

export async function signInWithEmail(
  client: AuthClient,
  input: { readonly email: string; readonly password: string },
) {
  const result = await client.auth.signInWithPassword(credentials(input));
  if (result.error) {
    throw result.error;
  }
  if (!result.data.user || !result.data.session) {
    throw new Error("Sign in did not create a session.");
  }
  return result.data;
}

export async function signUpWithEmail(
  client: AuthClient,
  input: {
    readonly email: string;
    readonly password: string;
    readonly emailRedirectTo: string;
  },
) {
  const auth = credentials(input);
  const result = await client.auth.signUp({
    ...auth,
    options: { emailRedirectTo: input.emailRedirectTo },
  });
  if (result.error) {
    throw result.error;
  }
  if (!result.data.user) {
    throw new Error("Sign up did not create a user.");
  }
  return result.data;
}

export async function startGoogleSignIn(
  client: AuthClient,
  redirectTo: string,
): Promise<void> {
  const result = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
  if (result.error) {
    throw result.error;
  }
}

export async function assertFreshSession(client: AuthClient): Promise<User> {
  const result = await client.auth.getUser();
  if (result.error || !result.data.user) {
    throw new Error("Session expired. Sign in again.");
  }
  return result.data.user;
}
