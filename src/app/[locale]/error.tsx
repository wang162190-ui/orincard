"use client";

import { useTranslations } from "next-intl";

// 刻意**不**复用 PublicHeader / PublicFooter：它们是服务端组件，内部用 `@/i18n/navigation`
// 的 Link。从一个 "use client" 文件导入会把 next/link 的 react-server 构建拉进客户端图，
// Next 直接抛 "link.react-server.js was instantiated because it was required from…"，
// 而且这个编译错误会污染整个 `[locale]` 段——实测连 `/pricing` 都一起 500。
//
// 同理用 <a> 而不是 Link：错误边界之后做一次整页加载本来就更可靠，此时不值得为了
// 客户端路由再把导航模块拉进来。
//
// 只显示 digest，绝不显示 error.message 或堆栈：开发构建里的 message 未经脱敏，
// 渲染出来等于在用户可见的页面上泄露内部细节。digest 是能与服务端日志对上的稳定引用。
export default function LocaleError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const t = useTranslations("AppError");
  return (
    <main className="container" style={{ paddingBlock: "clamp(48px, 8vw, 96px)" }}>
      <section style={{ maxWidth: 640 }} className="stack">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1>{t("title")}</h1>
        <p className="lead">{t("body")}</p>
        <div className="row wrap">
          <button type="button" className="btn btn-primary" onClick={reset}>{t("retry")}</button>
          <a className="btn btn-secondary" href="/">{t("backHome")}</a>
        </div>
        {error.digest ? <p className="meta">{t("digestLabel")}: {error.digest}</p> : null}
      </section>
    </main>
  );
}
