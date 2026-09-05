"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "../../components/ui";
import { createBrowserSupabaseClient } from "./client";

type AuthMode = "login" | "signup";

export function AuthForm({ mode }: { readonly mode: AuthMode }) {
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
        setNotice("Check your email to confirm your account, then sign in.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Authentication is temporarily unavailable. Please try again.");
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
      setError("Google sign in is temporarily unavailable. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 520, paddingBlock: 64 }}>
      <Panel>
        <PanelHeader>
          <div>
            <p className="eyebrow">Orincard account</p>
            <h1 style={{ fontSize: 34 }}>{isSignup ? "Create account" : "Welcome back"}</h1>
          </div>
        </PanelHeader>
        <PanelBody className="stack">
          <p className="lead" style={{ fontSize: 16 }}>
            {isSignup
              ? "Create an account to save projects. Your anonymous draft stays on this device until you choose to migrate it."
              : "Sign in to continue working on your saved carousels."}
          </p>

          <form className="stack" onSubmit={submit}>
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
            <label className="stack" style={{ gap: 6 }}>
              <span className="label">Password</span>
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
              {pending ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
            </Button>
          </form>

          <Button disabled={pending} onClick={continueWithGoogle} variant="secondary">
            Continue with Google
          </Button>

          <p className="meta" style={{ margin: 0 }}>
            {isSignup ? "Already have an account? " : "New to Orincard? "}
            <Link href={isSignup ? "/login" : "/signup"}>
              {isSignup ? "Sign in" : "Create account"}
            </Link>
            {!isSignup ? (
              <>
                {" · "}
                <Link href="/reset-password">Forgot password?</Link>
              </>
            ) : null}
          </p>
        </PanelBody>
      </Panel>
    </main>
  );
}
