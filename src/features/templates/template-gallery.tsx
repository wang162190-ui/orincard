"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { platformKeys, platformPresets } from "@/domain/document";
import { Button } from "@/components/ui";
import { groupByCategory, type TemplateCard, type TemplateCategory } from "./catalog";

export function TemplateGallery({ templates }: { readonly templates: readonly TemplateCard[] }) {
  const t = useTranslations("Templates");
  const [active, setActive] = useState<TemplateCategory | null>(null);
  const zh = useLocale() === "zh-Hans";
  const [platform, setPlatform] = useState("");
  const [mode, setMode] = useState("");

  // 分组只依赖入参，筛选切换时不必重算。
  const groups = useMemo(() => groupByCategory(templates), [templates]);
  const visible = groups.filter((group) => !active || group.category === active).map((group) => ({ ...group, items: group.items.filter((card) => (!platform || card.platform === platform) && (!mode || Boolean(card.hasImages) === (mode === "image"))) })).filter((group) => group.items.length);
  const count = visible.reduce((total, group) => total + group.items.length, 0);

  return (
    <div className="stack-lg">
      <div className="stack">
        <div className="row wrap" role="group" aria-label={t("filterLabel")}>
          <Button
            variant="secondary"
            size="small"
            aria-pressed={active === null}
            onClick={() => setActive(null)}
          >
            {t("filterAll")}
          </Button>
          {groups.map((group) => (
            <Button
              key={group.category}
              variant="secondary"
              size="small"
              aria-pressed={active === group.category}
              onClick={() => setActive(group.category)}
            >
              {t(`category${group.category}`)}
            </Button>
          ))}
        </div>
        <div className="row wrap"><label>{zh ? "画布" : "Canvas"}<select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="">{zh ? "全部平台" : "All platforms"}</option>{platformKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label><label>{zh ? "内容类型" : "Content"}<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">{zh ? "全部类型" : "All styles"}</option><option value="image">{zh ? "图文" : "With images"}</option><option value="text">{zh ? "文字排版" : "Typography"}</option></select></label></div>
        <p className="meta" role="status">
          {t("countLabel", { count })}
        </p>
      </div>

      <div className="stack-lg" data-testid="template-list">
        {visible.map((group) => (
          <section className="stack" key={group.category}>
            <h2>{t(`category${group.category}`)}</h2>
            <div className="card-grid">
              {group.items.map((template) => (
                <article className="card stack showcase-card" key={template.slug}>
                  {template.thumbnail ? <Link href={`/templates/${template.slug}`} aria-label={`${t("view")} ${template.name}`}><img className="template-cover" src={template.thumbnail} alt={template.name} width={360} height={450} loading="lazy" /></Link> : null}
                  <p className="eyebrow">
                    {t(`category${group.category}`)} · {template.platform}
                  </p>
                  <h3>{template.name}</h3>
                  <p>{template.description}</p>
                  <p className="meta">{t("editablePages", { count: template.slideCount })}</p>
                  <p className="meta">{platformPresets[template.platform as keyof typeof platformPresets]?.width} × {platformPresets[template.platform as keyof typeof platformPresets]?.height} · {template.hasImages ? (zh ? "含原创素材" : "Original imagery included") : (zh ? "文字排版" : "Typography")}</p>
                  <div>
                    <Link className="btn btn-primary" href={`/templates/${template.slug}`}>
                      {t("view")}
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      {count === 0 ? <p role="status">{zh ? "没有匹配的模板，请调整筛选条件。" : "No templates match. Try another filter."}</p> : null}
    </div>
  );
}
