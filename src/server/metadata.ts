import type { Metadata } from "next";

export const PRIVATE_ROUTE_PREFIXES = [
  "/api", "/auth", "/billing", "/brand-kits", "/create", "/editor", "/exports",
  "/login", "/projects", "/reset-password", "/settings", "/signup", "/tools",
] as const;

export function siteOrigin(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const value = environment.NEXT_PUBLIC_APP_URL?.trim();
  return value ? new URL(value).origin : "http://localhost:3000";
}

export function isPrivateRoute(pathname: string) {
  return PRIVATE_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function publicMetadata(input: { readonly title: string; readonly description: string; readonly path?: string }, environment: Readonly<Record<string, string | undefined>> = process.env): Metadata {
  const preview = environment.VERCEL_ENV === "preview";
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical: new URL(input.path ?? "/", siteOrigin(environment)).toString() },
    robots: preview ? { index: false, follow: false } : { index: true, follow: true },
  };
}
