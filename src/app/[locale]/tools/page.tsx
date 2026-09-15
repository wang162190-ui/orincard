import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { WorkspaceShell } from "@/components/workspace-shell";
import { TOOL_REGISTRY } from "@/features/tools/registry";

export default async function ToolsPage() {
  const t = await getTranslations("Tools");
  return <WorkspaceShell current="tools" title={t("shellTitle")}><section><h1>{t("heading")}</h1><p>{t("lead")}</p><div className="card-grid">{TOOL_REGISTRY.map((tool) => <Link className="card" href={`/tools/${tool.id}`} key={tool.id}><h2>{t(tool.messageKey)}</h2><p>{t("candidate", { type: tool.resultType })}</p></Link>)}</div></section></WorkspaceShell>;
}
