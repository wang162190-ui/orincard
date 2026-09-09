import { cookies } from "next/headers";
import { WorkspaceShell } from "../../../components/workspace-shell";
import type { CarouselDocument } from "../../../domain/document";
import { Editor } from "../../../features/editor/editor";
import { createSupabaseProjectStore } from "../../../server/projects";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../server/supabase";

interface EditorPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function EditorPage({ params }: EditorPageProps) {
  const { id } = await params;
  let cloudProject:
    | { readonly ownerId: string; readonly document: CarouselDocument; readonly revision: number }
    | undefined;

  if (UUID_PATTERN.test(id)) {
    try {
      const cookieStore = await cookies();
      const userClient = createServerSupabaseClient({
        getAll: () => cookieStore.getAll(),
        set: () => undefined,
      });
      const ownerId = (await requireVerifiedUser(userClient)).id;
      const project = await createSupabaseProjectStore(createAdminSupabaseClient()).get(ownerId, id);
      if (project) cloudProject = { ownerId, document: project.document, revision: project.revision };
    } catch {
      cloudProject = undefined;
    }
  }

  return (
    <WorkspaceShell current="workspace" title="Editor">
      <Editor
        draftId={id}
        initialDocument={cloudProject?.document}
        projectRevision={cloudProject?.revision}
        draftOwner={cloudProject ? { kind: "account", userId: cloudProject.ownerId } : undefined}
      />
    </WorkspaceShell>
  );
}
