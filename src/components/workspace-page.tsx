import type { ReactNode } from "react";

type WorkspacePageProps = {
  children: ReactNode;
  title: string;
};

/**
 * 工作区页面的上半截：标题栏 + 正文容器。
 *
 * 外壳（`div.app` / 侧边栏 / `div.main`）在 `app/[locale]/(workspace)/layout.tsx` 里，
 * 切页时不重建；只有这里的两个节点跟着页面换。标题栏留给页面而不是提到 layout，
 * 是因为标题有动态的——`templates/[slug]` 传的是模板名。
 */
export function WorkspacePage({ children, title }: WorkspacePageProps) {
  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <strong>{title}</strong>
        </div>
      </header>
      <main className="work">{children}</main>
    </>
  );
}
