import { getTranslations } from "next-intl/server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { AgentPanel } from "@/features/agent/agent-panel";

export default async function AgentPage() {
  const t = await getTranslations("AgentPanel");
  return <WorkspaceShell current="agent" title={t("shellTitle")}><AgentPanel /></WorkspaceShell>;
}
