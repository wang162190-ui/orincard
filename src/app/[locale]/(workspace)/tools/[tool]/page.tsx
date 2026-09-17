import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { WorkspacePage } from "@/components/workspace-page";
import { TOOL_IDS, type ToolId } from "@/domain/tools";
import { ToolWorkspace } from "@/features/tools/tool-workspace";

export default async function ToolPage({ params }: { readonly params: Promise<{ readonly tool: string }> }) {
  const { tool } = await params;
  const t = await getTranslations("Tools");
  if (!TOOL_IDS.includes(tool as ToolId)) notFound();
  return <WorkspacePage title={t("shellTitle")}><ToolWorkspace tool={tool as ToolId} /></WorkspacePage>;
}
