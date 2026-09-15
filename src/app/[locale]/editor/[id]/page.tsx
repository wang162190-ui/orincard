import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import type { CarouselDocument } from "@/domain/document";
import { Editor } from "@/features/editor/editor";
import { createSupabaseProjectStore } from "@/server/projects";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";

interface EditorPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function EditorPage({ params }: EditorPageProps) {
  const { id } = await params;
  const t = await getTranslations("Nav");
  let cloudProject:
    | { readonly ownerId: string; readonly document: CarouselDocument; readonly revision: number }
    | undefined;

  if (UUID_PATTERN.test(id)) {
    // 两种失败以前被压成同一个 `cloudProject = undefined`，于是已登录用户打开一个不属于
    // 自己的（或根本不存在的）项目 id，会拿到一个空白的本地草稿外壳、HTTP 200，看起来
    // 像「项目被清空了」。现在分开处理。
    let ownerId: string | undefined;
    try {
      const cookieStore = await cookies();
      const userClient = createServerSupabaseClient({
        getAll: () => cookieStore.getAll(),
        set: () => undefined,
      });
      ownerId = (await requireVerifiedUser(userClient)).id;
    } catch {
      // 匿名访问：继续渲染本地草稿外壳、返回 200。这是刻意的——未登录用户可以直接用
      // 编辑器，见 docs/handoff/product-completion.md §1.1。不要在这里 404。
      ownerId = undefined;
    }

    if (ownerId) {
      const project = await createSupabaseProjectStore(createAdminSupabaseClient()).get(ownerId, id);
      // 已登录、id 是合法 UUID、却查不到 → 这个项目对这个用户不存在。404 而不是空壳。
      // 注意 store.get 是按 (ownerId, id) 查的，所以「别人的项目」与「不存在」在这里
      // 是同一种结果，也应当是同一种结果——否则 404 与 200 的差异会泄露 id 是否存在。
      if (!project) notFound();
      cloudProject = { ownerId, document: project.document, revision: project.revision };
    }
  }

  return (
    <WorkspaceShell current="projects" title={t("editor")}>
      <Editor
        draftId={id}
        initialDocument={cloudProject?.document}
        projectRevision={cloudProject?.revision}
        draftOwner={cloudProject ? { kind: "account", userId: cloudProject.ownerId } : undefined}
      />
    </WorkspaceShell>
  );
}
