import type { Metadata } from "next";
import { AuthForm } from "../../features/auth/auth-form";

export const metadata: Metadata = {
  title: "Sign in — Orincard",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
