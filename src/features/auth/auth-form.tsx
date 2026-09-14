"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "../../components/ui";
import { Link, useRouter } from "../../i18n/navigation";
import { createBrowserSupabaseClient } from "./client";

type AuthMode = "login" | "signup";

export function AuthForm({ mode }: { readonly mode: AuthMode }) {
  const t = useTranslations("Auth");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignup = mode === "signup";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    try {
      const form = new FormData(event.currentTarget);
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      const password = String(form.get("password") ?? "");
      const client = createBrowserSupabaseClient();
      const result = isSignup
        ? await client.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/auth/callback?next=%2F`,
            },
          })
        : await client.auth.signInWithPassword({ email, password });

      if (result.error) {
        setError(result.error.message);
        return;
      }
      if (isSignup && !result.data.session) {
        setNotice(t("confirmEmail"));
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError(t("unavailable"));
    } finally {
      setPending(false);
    }
  }

  async function continueWithGoogle() {
    setError(null);
    setPending(true);
    try {
      const client = createBrowserSupabaseClient();
      const result = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=%2F`,
        },
      });
      if (result.error) {
        setError(result.error.message);
      }
    } catch {
      setError(t("googleUnavailable"));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 520, paddingBlock: 64 }}>
      <Panel>
        <PanelHeader>
          <div>
            <p className="eyebrow">{t("eyebrow")}</p>
            <h1 style={{ fontSize: 34 }}>{isSignup ? t("headingSignup") : t("headingLogin")}</h1>
          </div>
        </PanelHeader>
        <PanelBody className="stack">
          <p className="lead" style={{ fontSize: 16 }}>
            {isSignup ? t("leadSignup") : t("leadLogin")}
          </p>

          <form className="stack" onSubmit={submit}>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label">{t("email")}</span>
              <input
                autoComplete="email"
                name="email"
                required
                type="email"
                style={{ minHeight: 42, padding: "8px 12px" }}
              />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <span className="label">{t("password")}</span>
              <input
                autoComplete={isSignup ? "new-password" : "current-password"}
                minLength={8}
                name="password"
                required
                type="password"
                style={{ minHeight: 42, padding: "8px 12px" }}
              />
            </label>
            {error ? <p role="alert">{error}</p> : null}
            {notice ? <p role="status">{notice}</p> : null}
            <Button disabled={pending} type="submit">
              {pending ? t("pending") : isSignup ? t("submitSignup") : t("submitLogin")}
            </Button>
          </form>

          <Button disabled={pending} onClick={continueWithGoogle} variant="secondary">
            {t("google")}
          </Button>

          <p className="meta" style={{ margin: 0 }}>
            {isSignup ? t("switchFromSignup") : t("switchFromLogin")}
            <Link href={isSignup ? "/login" : "/signup"}>
              {isSignup ? t("submitLogin") : t("submitSignup")}
            </Link>
            {!isSignup ? (
              <>
                {" · "}
                <Link href="/reset-password">{t("forgotPassword")}</Link>
              </>
            ) : null}
          </p>
        </PanelBody>
      </Panel>
    </main>
  );
}
