import { useTranslations } from "next-intl";
import { WorkspaceShell } from "@/components/workspace-shell";
import { SupportForm } from "@/features/support/form";

export default function SupportPage() {
  const t = useTranslations("Support");
  return <WorkspaceShell current="help" title={t("shellTitle")}><section><h1>{t("heading")}</h1><p>{t("lead")}</p><SupportForm /></section></WorkspaceShell>;
}
