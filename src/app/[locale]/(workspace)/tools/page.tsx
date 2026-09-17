import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { WorkspacePage } from "@/components/workspace-page";
import { TOOL_REGISTRY } from "@/features/tools/registry";

export default async function ToolsPage() {
  const t = await getTranslations("Tools");
  return <WorkspacePage title={t("shellTitle")}><section><h1>{t("heading")}</h1><p>{t("lead")}</p><div className="card-grid">{TOOL_REGISTRY.map((tool) => <Link className="card" href={`/tools/${tool.id}`} key={tool.id}><h2>{t(tool.messageKey)}</h2><p>{t("candidate", { type: tool.resultType })}</p></Link>)}</div></section></WorkspacePage>;
}
