"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

// next-intl 的 usePathname 返回的是**剥掉语言段**的路径，所以在 /zh-Hans/editor/abc
// 上切回英文会落到 /editor/abc，而不是拼成 /en/zh-Hans/editor/abc。
// router.replace 会让 middleware 写下 NEXT_LOCALE，选择因此被记住。
export function LanguageSwitcher() {
  const t = useTranslations("Language");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="label">{t("label")}</span>
      <select
        className="select"
        aria-label={t("label")}
        value={locale}
        onChange={(event) => router.replace(pathname, { locale: event.target.value as Locale })}
      >
        {routing.locales.map((value) => (
          <option key={value} value={value}>
            {t(value)}
          </option>
        ))}
      </select>
    </label>
  );
}
