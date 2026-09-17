import { useTranslations } from "next-intl";
import { WorkspacePage } from "@/components/workspace-page";
import { SupportForm } from "@/features/support/form";

export default function SupportPage() {
  const t = useTranslations("Support");
  return <WorkspacePage title={t("shellTitle")}><section><h1>{t("heading")}</h1><p>{t("lead")}</p><SupportForm /></section></WorkspacePage>;
}
