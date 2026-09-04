import { WorkspaceShell } from "../../../components/workspace-shell";
import { Editor } from "../../../features/editor/editor";

interface EditorPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function EditorPage({ params }: EditorPageProps) {
  const { id } = await params;

  return (
    <WorkspaceShell current="workspace" title="Editor">
      <Editor draftId={id} />
    </WorkspaceShell>
  );
}
