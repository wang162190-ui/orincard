export const AUTH_MAIL_DELIVERY = {
  owner: "supabase-auth",
  transport: "custom-smtp",
  provider: "resend",
} as const;

interface AuthCodeClient {
  readonly auth: {
    exchangeCodeForSession(code: string): Promise<{ readonly error: Error | null }>;
  };
}

interface PasswordRecoveryClient {
  readonly auth: {
    getUser(): Promise<{
      readonly data: { readonly user: unknown | null };
      readonly error: Error | null;
    }>;
    signOut(options: { readonly scope: "local" }): Promise<{
      readonly error: Error | null;
    }>;
    updateUser(input: { readonly password: string }): Promise<{
      readonly error: Error | null;
    }>;
  };
}

function appOrigin(appUrl: string): URL {
  const url = new URL(appUrl);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new TypeError("Auth callback origin must use HTTPS outside local development.");
  }
  return new URL(url.origin);
}

export function safeNextPath(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/";
  }
  return value;
}

export function buildAuthCallbackUrl(appUrl: string, next: string): string {
  const callback = new URL("/auth/callback", appOrigin(appUrl));
  callback.searchParams.set("next", safeNextPath(next));
  return callback.toString();
}

export function buildAppRedirect(appUrl: string, next: string): string {
  return new URL(safeNextPath(next), appOrigin(appUrl)).toString();
}

export function buildPasswordRecoveryUrl(appUrl: string): string {
  return buildAuthCallbackUrl(appUrl, "/reset-password?mode=update");
}

export async function consumeAuthCode(
  client: AuthCodeClient,
  code: string | null | undefined,
): Promise<boolean> {
  if (!code?.trim()) {
    return false;
  }
  const result = await client.auth.exchangeCodeForSession(code);
  return !result.error;
}

export async function completePasswordRecovery(
  client: PasswordRecoveryClient,
  password: string,
): Promise<void> {
  if (password.length < 8) {
    throw new TypeError("Password must be at least 8 characters.");
  }
  const verified = await client.auth.getUser();
  if (verified.error || !verified.data.user) {
    throw new Error("This recovery link is expired or has already been used.");
  }
  const updated = await client.auth.updateUser({ password });
  if (updated.error) {
    throw updated.error;
  }
  const signedOut = await client.auth.signOut({ scope: "local" });
  if (signedOut.error) {
    throw signedOut.error;
  }
}
