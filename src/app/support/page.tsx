import { WorkspaceShell } from "@/components/workspace-shell";
import { SupportForm } from "@/features/support/form";

export default function SupportPage() {
  return <WorkspaceShell current="workspace" title="Support"><section><h1>Contact support</h1><p>Ask about your account, billing, exports, or copyright. You control which diagnostic IDs are attached.</p><SupportForm /></section></WorkspaceShell>;
}
