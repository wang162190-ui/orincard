import { useTranslations } from "next-intl";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import type { PlanKey } from "@/domain/entitlements";
import { WaitlistForm } from "@/features/billing/waitlist-form";
import { Link } from "@/i18n/navigation";
import { readPlanBenefits, type PlanBenefits } from "@/server/billing/plan-benefits";

export default function PricingPage() {
  const t = useTranslations("Pricing");
  // 权益直接读运行时真正在执行的那份策略，不在页面里另抄一份数字——
  // 抄一份就一定会和实际发放的额度对不上，而对不上的那一份还偏偏是对外承诺的那一份。
  const benefits = readPlanBenefits(process.env);
  const plans = [
    { key: "free" as PlanKey, name: t("freeName"), intro: t("freeIntro"), points: [t("freePoint1"), t("freePoint2"), t("freePoint3")] },
    { key: "pro" as PlanKey, name: t("proName"), intro: t("proIntro"), points: [t("proPoint1"), t("proPoint2"), t("proPoint3")] },
    { key: "creator" as PlanKey, name: t("creatorName"), intro: t("creatorIntro"), points: [t("creatorPoint1"), t("creatorPoint2"), t("creatorPoint3")] },
  ] as const;

  function benefitLines(state: PlanBenefits): readonly string[] | null {
    if (state.state !== "published") return null;
    const entitlements = state.entitlements;
    return [
      t("benefitPages", { count: entitlements.maxPages }),
      t("benefitGenerations", { count: entitlements.monthlyGenerations }),
      ...(entitlements.monthlyImages === undefined ? [] : [t("benefitImages", { count: entitlements.monthlyImages })]),
      `${t("benefitHd")} — ${t(entitlements.hdExport ? "included" : "notIncluded")}`,
      `${t("benefitPptx")} — ${t(entitlements.pptxExport ? "included" : "notIncluded")}`,
      `${t("benefitMp4")} — ${t(entitlements.mp4Export ? "included" : "notIncluded")}`,
    ];
  }

  return <><PublicHeader /><main className="container" style={{ paddingBlock: "clamp(48px, 8vw, 96px)" }}>
    <section style={{ maxWidth: 760 }}><p className="eyebrow">{t("eyebrow")}</p><h1>{t("headline")}</h1><p className="lead" style={{ marginTop: 20 }}>{t("lead")}</p></section>
    <section aria-label={t("overviewLabel")} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginTop: 48 }}>{plans.map((plan, index) => {
      const lines = benefitLines(benefits[plan.key]);
      return <article className="panel" key={plan.name} style={{ borderColor: index === 1 ? "var(--fg)" : undefined }}><div className="panel-body stack">
        <p className="eyebrow">{index === 0 ? t("availableNow") : t("inPreparation")}</p>
        <h2>{plan.name}</h2>
        <p>{plan.intro}</p>
        {/* 有已审定的权益就写具体数字；没有就退回定性描述，并说明数字为什么不在这里。
            价格一栏三档都是空的：价格是商业决策，代码里没有，我不会替它编一个。 */}
        {lines
          ? <ul style={{ paddingLeft: 20 }}>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
          : <><ul style={{ paddingLeft: 20 }}>{plan.points.map((point) => <li key={point}>{point}</li>)}</ul><p className="meta">{t(benefits[plan.key].state === "unavailable" ? "benefitsUnavailable" : "benefitsUnapproved")}</p></>}
        <p className="meta">{t("priceUnannounced")}</p>
        {index === 0 ? <Link className="btn btn-secondary" href="/create">{t("startCreating")}</Link> : <a className="btn btn-primary" href="#waitlist">{t("joinWaitlist")}</a>}
      </div></article>;
    })}</section>
    <section id="waitlist" className="panel" style={{ marginTop: 32, background: "var(--sig-yellow)" }}><div className="panel-body stack">
      <p className="eyebrow">{t("waitlistEyebrow")}</p>
      <h2>{t("waitlistTitle")}</h2>
      <p style={{ maxWidth: 680 }}>{t("waitlistBody")}</p>
      <WaitlistForm source="pricing" />
    </div></section>
  </main><PublicFooter /></>;
}
