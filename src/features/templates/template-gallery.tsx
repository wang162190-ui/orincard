"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui";
import { groupByCategory, type TemplateCard, type TemplateCategory } from "./catalog";

export function TemplateGallery({ templates }: { readonly templates: readonly TemplateCard[] }) {
  const t = useTranslations("Templates");
  const [active, setActive] = useState<TemplateCategory | null>(null);

  // 分组只依赖入参，筛选切换时不必重算。
  const groups = useMemo(() => groupByCategory(templates), [templates]);
  const visible = active ? groups.filter((group) => group.category === active) : groups;
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
                <article className="card stack" key={template.slug}>
                  <p className="eyebrow">
                    {t(`category${group.category}`)} · {template.platform}
                  </p>
                  <h3>{template.name}</h3>
                  <p>{template.description}</p>
                  <p className="meta">{t("editablePages", { count: template.slideCount })}</p>
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
    </div>
  );
}
