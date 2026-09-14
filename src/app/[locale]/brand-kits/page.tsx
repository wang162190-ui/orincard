import { useTranslations } from "next-intl";
import { WorkspaceShell } from "@/components/workspace-shell";
import { BrandEditor } from "@/features/brands/brand-editor";

export default function BrandKitsPage() {
  const t = useTranslations("BrandKits");
  return <WorkspaceShell current="workspace" title={t("shellTitle")}><section><h1>{t("heading")}</h1><p>{t("lead")}</p><BrandEditor /></section></WorkspaceShell>;
}
