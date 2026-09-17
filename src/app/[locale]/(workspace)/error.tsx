"use client";

import { useTranslations } from "next-intl";

/**
 * 工作区自己的错误边界。
 *
 * 没有它的时候，这 15 个段里任何一个渲染抛错都会一路冒泡到 `[locale]/error.tsx`，
 * 整个外壳连同侧边栏被顶掉换成一张全屏错误页——一个页面的取数失败，代价是整个产品界面。
 * 放在这里之后爆炸半径收在 `div.main` 里：侧边栏还在，用户可以直接切去别的地方，
 * 或者按「重试」只重挂这一段。
 *
 * 这是搬到共享 layout 之后才做得到的事——之前外壳写在每个页面内部，错误边界套在外面
 * 就意味着套在外壳外面，收不住。
 *
 * 词条复用 `AppError`：文案在两种场景下要说的是同一件事，为此新造一组 key 只会多一处
 * 要同步翻译的地方。`<a>` 而不是 `Link` 的理由同 `[locale]/error.tsx` 顶部那段注释——
 * 从 "use client" 文件导入 `@/i18n/navigation` 会把 next/link 的 react-server 构建
 * 拉进客户端图，整段编译失败。
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const t = useTranslations("AppError");
  return (
    <>
      <header className="topbar">
        <div className="crumbs">
          <strong>{t("title")}</strong>
        </div>
      </header>
      <main className="work">
        <section style={{ maxWidth: 640 }} className="stack">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p className="lead">{t("body")}</p>
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={reset}>{t("retry")}</button>
            <a className="btn btn-secondary" href="/">{t("backHome")}</a>
          </div>
          {/* 只显示 digest，不显示 message 或堆栈：未脱敏的内部细节不该进用户可见的页面。 */}
          {error.digest ? <p className="meta">{t("digestLabel")}: {error.digest}</p> : null}
        </section>
      </main>
    </>
  );
}
