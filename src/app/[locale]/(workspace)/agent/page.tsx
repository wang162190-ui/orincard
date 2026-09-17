import { getTranslations } from "next-intl/server";
import { WorkspacePage } from "@/components/workspace-page";
import { AgentPanel } from "@/features/agent/agent-panel";

export default async function AgentPage() {
  const t = await getTranslations("AgentPanel");
  return <WorkspacePage title={t("shellTitle")}><AgentPanel /></WorkspacePage>;
}
