import { useTranslations } from "next-intl";
import { WorkspaceShell } from "@/components/workspace-shell";
import { AccountSettings } from "@/features/settings/account-settings";

export default function SettingsPage() {
  const t = useTranslations("Settings");
  return (
    <WorkspaceShell current="settings" title={t("shellTitle")}>
      <section>
        <h1>{t("heading")}</h1>
        <p>{t("lead")}</p>
        <AccountSettings />
      </section>
    </WorkspaceShell>
  );
}
