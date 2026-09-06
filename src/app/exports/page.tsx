import { WorkspaceShell } from "@/components/workspace-shell";
import { ExportCenter } from "@/features/exports/export-dialog";

export default function ExportsPage() {
  return (
    <WorkspaceShell current="workspace" title="Exports">
      <section>
        <h1>Exports</h1>
        <p>Download finished files or regenerate an expired format from its saved revision.</p>
        <ExportCenter />
      </section>
    </WorkspaceShell>
  );
}
