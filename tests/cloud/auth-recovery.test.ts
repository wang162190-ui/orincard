import { describe, expect, it, vi } from "vitest";
import {
  AUTH_MAIL_DELIVERY,
  buildAuthCallbackUrl,
  buildPasswordRecoveryUrl,
  consumeAuthCode,
  safeNextPath,
} from "../../src/server/mail";

describe("T022 callback and recovery contract", () => {
  it("accepts internal destinations and rejects open redirects", () => {
    expect(safeNextPath("/projects?view=recent")).toBe("/projects?view=recent");
    for (const unsafe of [
      "https://attacker.example/path",
      "//attacker.example/path",
      "/\\attacker.example/path",
      "javascript:alert(1)",
      "projects",
    ]) {
      expect(safeNextPath(unsafe)).toBe("/");
    }
  });

  it("anchors confirmation and recovery redirects to the configured app origin", () => {
    expect(
      buildAuthCallbackUrl("https://app.example/base", "/projects"),
    ).toBe("https://app.example/auth/callback?next=%2Fprojects");
    expect(buildPasswordRecoveryUrl("https://app.example")).toBe(
      "https://app.example/auth/callback?next=%2Freset-password%3Fmode%3Dupdate",
    );
  });

  it("treats an expired or repeated auth code as consumed", async () => {
    const exchangeCodeForSession = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: new Error("Auth code has expired") });
    const client = { auth: { exchangeCodeForSession } };

    await expect(consumeAuthCode(client, "one-time-code")).resolves.toBe(true);
    await expect(consumeAuthCode(client, "one-time-code")).resolves.toBe(false);
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(2);
  });

  it("declares Resend only as Supabase Auth custom SMTP", () => {
    expect(AUTH_MAIL_DELIVERY).toEqual({
      owner: "supabase-auth",
      transport: "custom-smtp",
      provider: "resend",
    });
  });
});

const cloud =
  process.env.ORINCARD_RUN_AUTH_RECOVERY_CLOUD === "1" ? describe : describe.skip;

cloud("T022 real development recovery email", () => {
  it("asks Supabase Auth to send a recovery message through configured SMTP", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const email = process.env.ORINCARD_AUTH_TEST_EMAIL;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!url || !key || !email || !appUrl) {
      throw new Error(
        "ORINCARD_RUN_AUTH_RECOVERY_CLOUD=1 requires the development Supabase URL, publishable key, app URL, and auth test email.",
      );
    }

    const client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const result = await client.auth.resetPasswordForEmail(email, {
      redirectTo: buildPasswordRecoveryUrl(appUrl),
    });
    expect(result.error).toBeNull();
  });
});
