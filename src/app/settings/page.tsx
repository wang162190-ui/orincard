import { WorkspaceShell } from "@/components/workspace-shell";
import { AccountSettings } from "@/features/settings/account-settings";

export default function SettingsPage() {
  return (
    <WorkspaceShell current="workspace" title="Settings">
      <section>
        <h1>Settings</h1>
        <p>Set creation defaults and export a copy of your account data.</p>
        <AccountSettings />
      </section>
    </WorkspaceShell>
  );
}
