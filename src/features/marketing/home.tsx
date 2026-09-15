import { useTranslations } from "next-intl";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import { Link } from "@/i18n/navigation";

export function MarketingHome() {
  const t = useTranslations("Marketing");
  const features = [
    [t("featureSourcesTitle"), t("featureSourcesBody")],
    [t("featureEditTitle"), t("featureEditBody")],
    [t("featureKeepTitle"), t("featureKeepBody")],
  ] as const;

  return <>
    <aside role="note" style={{ background: "var(--fg)", color: "var(--on-ink)", paddingBlock: 12 }}><div className="container row wrap" style={{ gap: 10, alignItems: "baseline" }}><strong className="meta" style={{ color: "var(--sig-yellow)" }}>{t("previewNoticeLabel")}</strong><span className="meta" style={{ color: "var(--on-ink-dim)" }}>{t("previewNoticeBody")}</span></div></aside>
    <PublicHeader />
    <main>
      <section className="container" style={{ paddingBlock: "clamp(64px, 10vw, 128px)" }}><div style={{ maxWidth: 830 }}><p className="eyebrow">{t("eyebrow")}</p><h1>{t("headline")}</h1><p className="lead" style={{ marginTop: 24 }}>{t("lead")}</p><div className="row wrap" style={{ marginTop: 28 }}><Link className="btn btn-primary" href="/create">{t("primaryCta")}</Link><Link className="btn btn-secondary" href="/tools">{t("secondaryCta")}</Link></div><p className="meta" style={{ marginTop: 14 }}>{t("note")}</p></div></section>
      <section aria-labelledby="workflow-title" style={{ background: "var(--fg)", color: "var(--on-ink)", paddingBlock: "var(--gap-xl)" }}><div className="container"><p className="eyebrow" style={{ color: "var(--on-ink-dim)" }}>{t("workflowEyebrow")}</p><h2 id="workflow-title" style={{ maxWidth: 650 }}>{t("workflowTitle")}</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 1, marginTop: 36, background: "var(--on-ink-soft)" }}>{features.map(([title, body], index) => <article key={title} style={{ minHeight: 210, padding: 24, background: "var(--fg)" }}><p className="meta" style={{ color: "var(--sig-yellow)" }}>0{index + 1}</p><h3 style={{ marginTop: 36 }}>{title}</h3><p style={{ color: "var(--on-ink-dim)" }}>{body}</p></article>)}</div></div></section>
      <section className="container grid-2" style={{ paddingBlock: "var(--gap-2xl)", alignItems: "center" }}><div><p className="eyebrow">{t("formatsEyebrow")}</p><h2>{t("formatsTitle")}</h2><p className="lead" style={{ marginTop: 18 }}>{t("formatsLead")}</p></div><div aria-label={t("formatsExampleLabel")} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, minHeight: 300 }}>{[t("formatsCard1"), t("formatsCard2"), t("formatsCard3")].map((label, index) => <div key={label} style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 18, border: "1px solid var(--fg)", borderRadius: "var(--radius)", background: ["var(--sig-yellow)", "var(--sig-pink)", "var(--sig-blue)"][index], transform: `translateY(${index * 18}px)` }}><span className="meta">0{index + 1}</span><strong style={{ fontFamily: "var(--font-display)", fontSize: 21, lineHeight: 1.1 }}>{label}</strong></div>)}</div></section>
      <section style={{ background: "var(--sig-yellow)", paddingBlock: "var(--gap-xl)" }}><div className="container row-between wrap"><div><p className="eyebrow">{t("waitlistEyebrow")}</p><h2>{t("waitlistTitle")}</h2></div><Link className="btn btn-primary" href="/pricing#waitlist">{t("waitlistCta")}</Link></div></section>
    </main>
    <PublicFooter />
  </>;
}
