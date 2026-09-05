import type { Metadata } from "next";
import { AuthForm } from "../../features/auth/auth-form";

export const metadata: Metadata = {
  title: "Create account — Orincard",
  robots: { index: false, follow: false },
};

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
