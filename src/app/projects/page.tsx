import { cookies } from "next/headers";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ProjectLibrary } from "@/features/projects/library";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { createSupabaseProjectStore } from "@/server/projects";
import type { ProjectSummary } from "@/server/projects";

export default async function ProjectsPage() {
  let projects: ProjectSummary[] = [];
  try {
    const cookieStore = await cookies();
    const user = await requireVerifiedUser(createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: () => undefined }));
    projects = [...await createSupabaseProjectStore(createAdminSupabaseClient()).list({ ownerId: user.id, limit: 20 })];
  } catch {
    projects = [];
  }
  return <WorkspaceShell current="workspace" title="Projects"><ProjectLibrary initialProjects={projects} /></WorkspaceShell>;
}
