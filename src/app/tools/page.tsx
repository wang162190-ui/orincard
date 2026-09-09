import Link from "next/link";
import { WorkspaceShell } from "@/components/workspace-shell";
import { TOOL_REGISTRY } from "@/features/tools/registry";

export default function ToolsPage() {
  return <WorkspaceShell current="workspace" title="Tools"><section><h1>Creator tools</h1><p>Generate a candidate independently or from project context you explicitly select.</p><div className="card-grid">{TOOL_REGISTRY.map((tool) => <Link className="card" href={`/tools/${tool.id}`} key={tool.id}><h2>{tool.label}</h2><p>{tool.resultType} candidate</p></Link>)}</div></section></WorkspaceShell>;
}
