import { useTranslations } from "next-intl";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import { Link } from "@/i18n/navigation";

export default function PricingPage() {
  const t = useTranslations("Pricing");
  const plans = [
    { name: t("freeName"), intro: t("freeIntro"), points: [t("freePoint1"), t("freePoint2"), t("freePoint3")] },
    { name: t("proName"), intro: t("proIntro"), points: [t("proPoint1"), t("proPoint2"), t("proPoint3")] },
    { name: t("creatorName"), intro: t("creatorIntro"), points: [t("creatorPoint1"), t("creatorPoint2"), t("creatorPoint3")] },
  ] as const;

  return <><PublicHeader /><main className="container" style={{ paddingBlock: "clamp(48px, 8vw, 96px)" }}><section style={{ maxWidth: 760 }}><p className="eyebrow">{t("eyebrow")}</p><h1>{t("headline")}</h1><p className="lead" style={{ marginTop: 20 }}>{t("lead")}</p></section><section aria-label={t("overviewLabel")} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginTop: 48 }}>{plans.map((plan, index) => <article className="panel" key={plan.name} style={{ borderColor: index === 1 ? "var(--fg)" : undefined }}><div className="panel-body stack"><p className="eyebrow">{index === 0 ? t("availableNow") : t("inPreparation")}</p><h2>{plan.name}</h2><p>{plan.intro}</p><ul style={{ paddingLeft: 20 }}>{plan.points.map((point) => <li key={point}>{point}</li>)}</ul>{index === 0 ? <Link className="btn btn-secondary" href="/create">{t("startCreating")}</Link> : <a className="btn btn-primary" href="#waitlist">{t("joinWaitlist")}</a>}</div></article>)}</section><section id="waitlist" className="panel" style={{ marginTop: 32, background: "var(--sig-yellow)" }}><div className="panel-body stack"><p className="eyebrow">{t("waitlistEyebrow")}</p><h2>{t("waitlistTitle")}</h2><p style={{ maxWidth: 680 }}>{t("waitlistBody")}</p><div><Link className="btn btn-primary" href="/">{t("returnHome")}</Link></div></div></section></main><PublicFooter /></>;
}
