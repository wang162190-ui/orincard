import { useTranslations } from "next-intl";
import { WorkspacePage } from "@/components/workspace-page";
import { AccountSettings } from "@/features/settings/account-settings";

export default function SettingsPage() {
  const t = useTranslations("Settings");
  return (
    <WorkspacePage title={t("shellTitle")}>
      <section>
        <h1>{t("heading")}</h1>
        <p>{t("lead")}</p>
        <AccountSettings />
      </section>
    </WorkspacePage>
  );
}
