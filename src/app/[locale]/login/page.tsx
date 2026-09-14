import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthForm } from "@/features/auth/auth-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Auth");
  return { title: t("loginTitle"), robots: { index: false, follow: false } };
}

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
