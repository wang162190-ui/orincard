"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "../../components/ui";
import { createBrowserSupabaseClient } from "../../features/auth/client";
import {
  buildPasswordRecoveryUrl,
  completePasswordRecovery,
} from "../../server/mail";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const updating = searchParams.get("mode") === "update";
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(updating);
  const [sessionValid, setSessionValid] = useState(!updating);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!updating) {
      return;
    }
    let active = true;
    const client = createBrowserSupabaseClient();
    void client.auth.getUser().then(({ data, error: sessionError }) => {
      if (!active) {
        return;
      }
      setSessionValid(Boolean(data.user) && !sessionError);
      setError(sessionError || !data.user ? "This recovery link is expired or has already been used." : null);
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [updating]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const form = new FormData(event.currentTarget);
      const client = createBrowserSupabaseClient();

      if (!updating) {
        const email = String(form.get("email") ?? "").trim().toLowerCase();
        const result = await client.auth.resetPasswordForEmail(email, {
          redirectTo: buildPasswordRecoveryUrl(window.location.origin),
        });
        if (result.error) {
          setError(result.error.message);
          return;
        }
        setNotice("If an account exists for that email, a recovery link is on its way.");
        return;
      }

      const password = String(form.get("password") ?? "");
      await completePasswordRecovery(client, password);
      router.replace("/login?reset=complete");
      router.refresh();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Password recovery is temporarily unavailable. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 520, paddingBlock: 64 }}>
      <Panel>
        <PanelHeader>
          <div>
            <p className="eyebrow">Account recovery</p>
            <h1 style={{ fontSize: 34 }}>
              {updating ? "Choose a new password" : "Reset your password"}
            </h1>
          </div>
        </PanelHeader>
        <PanelBody className="stack">
          <p className="lead" style={{ fontSize: 16 }}>
            {updating
              ? "Use a new password with at least eight characters."
              : "We’ll send a one-time recovery link if the address belongs to an account."}
          </p>
          {checking ? <p role="status">Checking recovery link…</p> : null}
          <form className="stack" onSubmit={submit}>
            {updating ? (
              <label className="stack" style={{ gap: 6 }}>
                <span className="label">New password</span>
                <input
                  autoComplete="new-password"
                  disabled={!sessionValid || checking}
                  minLength={8}
                  name="password"
                  required
                  type="password"
                  style={{ minHeight: 42, padding: "8px 12px" }}
                />
              </label>
            ) : (
              <label className="stack" style={{ gap: 6 }}>
                <span className="label">Email</span>
                <input
                  autoComplete="email"
                  name="email"
                  required
                  type="email"
                  style={{ minHeight: 42, padding: "8px 12px" }}
                />
              </label>
            )}
            {error ? <p role="alert">{error}</p> : null}
            {notice ? <p role="status">{notice}</p> : null}
            <Button disabled={pending || checking || (updating && !sessionValid)} type="submit">
              {pending ? "Please wait…" : updating ? "Update password" : "Send recovery link"}
            </Button>
          </form>
          <p className="meta" style={{ margin: 0 }}>
            <Link href="/login">Back to sign in</Link>
          </p>
        </PanelBody>
      </Panel>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p role="status">Loading account recovery…</p>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
