import { describe, expect, it, vi } from "vitest";
import {
  AUTH_MAIL_DELIVERY,
  buildAuthCallbackUrl,
  buildPasswordRecoveryUrl,
  completePasswordRecovery,
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

  it("updates a verified recovery session then clears it locally", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1" } },
          error: null,
        }),
        updateUser,
        signOut,
      },
    };

    await completePasswordRecovery(client, "new-password");

    expect(updateUser).toHaveBeenCalledWith({ password: "new-password" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("does not update or sign out an expired recovery session", async () => {
    const updateUser = vi.fn();
    const signOut = vi.fn();
    const client = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new Error("JWT expired"),
        }),
        updateUser,
        signOut,
      },
    };

    await expect(
      completePasswordRecovery(client, "new-password"),
    ).rejects.toThrow("expired or has already been used");
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
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
