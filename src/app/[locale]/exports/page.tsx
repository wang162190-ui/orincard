import { useTranslations } from "next-intl";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ExportCenter } from "@/features/exports/export-dialog";

export default function ExportsPage() {
  const t = useTranslations("Exports");
  return (
    <WorkspaceShell current="workspace" title={t("shellTitle")}>
      <section>
        <h1>{t("heading")}</h1>
        <p>{t("lead")}</p>
        <ExportCenter />
      </section>
    </WorkspaceShell>
  );
}
