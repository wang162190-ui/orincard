"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui";
import { groupByCategory, type TemplateCard, type TemplateCategory } from "./catalog";

export interface TemplateSeed {
  readonly templateId: string;
  readonly platform: string;
}

/**
 * 生成之前的「从哪套模板起步」。
 *
 * 这里选的**不是**生成结果——文案仍然由模型写。选中一套模板只做一件事：把它的配色与画幅
 * 灌进生成选项。刻意不做成「套用整份文档」，因为生成会把 slides 整体替换掉，套进去的正文
 * 一行都留不下，那就是个假动作。
 *
 * 高亮完全由「当前选项是否仍等于这套模板的配色 + 画幅」决定：用户回头在下面的选项里改了
 * 画幅，这里的选中态会自己消失，而不是继续显示一个已经不成立的选择。
 */
export function TemplatePicker(props: {
  readonly cards: readonly TemplateCard[];
  readonly value: TemplateSeed;
  readonly disabled?: boolean;
  readonly onSelect: (seed: TemplateSeed) => void;
}) {
  const t = useTranslations("Create");
  const templateLabel = useTranslations("Templates");
  const [category, setCategory] = useState<TemplateCategory | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const groups = useMemo(() => groupByCategory(props.cards), [props.cards]);
  const visible = category ? groups.filter((group) => group.category === category) : groups;

  const selected = props.cards.find(
    (card) =>
      card.slug === picked &&
      card.templateId === props.value.templateId &&
      card.platform === props.value.platform,
  );

  return (
    <div className="stack" data-testid="template-picker">
      <p className="meta">{t("templateStepHint")}</p>

      <div className="row wrap" role="group" aria-label={templateLabel("filterLabel")}>
        <Button
          variant="secondary"
          size="small"
          disabled={props.disabled}
          aria-pressed={category === null}
          onClick={() => setCategory(null)}
        >
          {templateLabel("filterAll")}
        </Button>
        {groups.map((group) => (
          <Button
            key={group.category}
            variant="secondary"
            size="small"
            disabled={props.disabled}
            aria-pressed={category === group.category}
            onClick={() => setCategory(group.category)}
          >
            {templateLabel(`category${group.category}`)}
          </Button>
        ))}
      </div>

      <div className="card-grid" role="group" aria-label={t("templateStep")}>
        {visible.flatMap((group) =>
          group.items.map((card) => (
            <button
              key={card.slug}
              type="button"
              className="card stack template-option"
              disabled={props.disabled}
              aria-pressed={selected?.slug === card.slug}
              data-template-slug={card.slug}
              onClick={() => {
                setPicked(card.slug);
                props.onSelect({ templateId: card.templateId, platform: card.platform });
              }}
            >
              <span className="eyebrow">
                {templateLabel(`category${group.category}`)} · {card.platform}
              </span>
              <span className="h3">{card.name}</span>
              <span>{card.description}</span>
            </button>
          )),
        )}
      </div>

      <p className="meta" role="status">
        {selected ? t("templateSelected", { name: selected.name }) : t("templateNone")}
      </p>
    </div>
  );
}
