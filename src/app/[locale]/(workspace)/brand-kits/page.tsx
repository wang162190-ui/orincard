import { useTranslations } from "next-intl";
import { WorkspacePage } from "@/components/workspace-page";
import { BrandEditor } from "@/features/brands/brand-editor";

export default function BrandKitsPage() {
  const t = useTranslations("BrandKits");
  return <WorkspacePage title={t("shellTitle")}><section><h1>{t("heading")}</h1><p>{t("lead")}</p><BrandEditor /></section></WorkspacePage>;
}
