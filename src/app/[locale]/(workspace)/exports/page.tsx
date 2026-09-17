import { useTranslations } from "next-intl";
import { WorkspacePage } from "@/components/workspace-page";
import { ExportCenter } from "@/features/exports/export-dialog";

export default function ExportsPage() {
  const t = useTranslations("Exports");
  return (
    <WorkspacePage title={t("shellTitle")}>
      <section>
        <h1>{t("heading")}</h1>
        <p>{t("lead")}</p>
        <ExportCenter />
      </section>
    </WorkspacePage>
  );
}
