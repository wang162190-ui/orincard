import { getTranslations } from "next-intl/server";
import { WorkspaceShell } from "@/components/workspace-shell";
import { CreateWorkspace } from "@/features/generation/create-workspace";
import { templateCards } from "@/features/templates/catalog";

// 这一页从「整页 use client」改成了服务端外壳 + 客户端工作区，为的是别把整份
// templates.json（14 套完整 CarouselDocument）打进客户端包——选择器只要 6 个字段。
export default async function CreatePage() {
  const t = await getTranslations("Create");
  return (
    <WorkspaceShell current="create" title={t("shellTitle")}>
      <CreateWorkspace cards={templateCards} />
    </WorkspaceShell>
  );
}
