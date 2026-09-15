"use client";

// 最外层兜底：只有 `[locale]/layout.tsx` 自身崩溃时才会命中这里。此时那个 layout 没能
// 渲染，于是既没有 <html>/<body>，也没有 NextIntlClientProvider——所以这份文件必须
// 自带文档骨架，且**不能**用 useTranslations（provider 不在，调用会直接再抛一次）。
//
// 文案因此是写死的双语并列，不是漏翻。这是整个应用唯一一处没有词条的用户可见文案，
// 它的出现频率应当是零；真出现了，两种语言的用户都得看懂。
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "48px 24px" }}>
        <main style={{ maxWidth: 560, marginInline: "auto" }}>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Something went wrong / 出错了</h1>
          <p style={{ lineHeight: 1.6, marginBottom: 24 }}>
            The application failed to start rendering. Try again, or reload the page.
            <br />
            应用未能开始渲染。请重试，或刷新页面。
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ padding: "10px 18px", fontSize: 15, cursor: "pointer" }}
          >
            Try again / 重试
          </button>
          {error.digest ? (
            <p style={{ marginTop: 24, fontSize: 13, opacity: 0.7 }}>
              Error reference / 错误编号: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
