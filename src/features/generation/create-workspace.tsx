"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Panel, PanelBody, PanelHeader } from "@/components/ui";
import { SourceInput } from "@/features/generation/source-input";
import {
  DEFAULT_GENERATION_OPTIONS,
  GenerationOptionsFields,
} from "@/features/generation/options";
import { TemplatePicker } from "@/features/templates/template-picker";
import type { TemplateCard } from "@/features/templates/catalog";
import type { GenerationOptions } from "@/server/generation";

export function CreateWorkspace({ cards }: { readonly cards: readonly TemplateCard[] }) {
  const t = useTranslations("Create");
  const [options, setOptions] = useState(DEFAULT_GENERATION_OPTIONS);

  return (
    <div className="stack" data-page="create" style={{ maxWidth: 900 }}>
      <header>
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1 style={{ fontSize: 34 }}>{t("heading")}</h1>
        <p className="lead" style={{ marginTop: 8, fontSize: 16 }}>
          {t("lead")}
        </p>
      </header>

      <Panel>
        <PanelHeader>
          <h2 className="h3">{t("templateStep")}</h2>
        </PanelHeader>
        <PanelBody>
          <TemplatePicker
            cards={cards}
            value={{ templateId: options.templateId, platform: options.platform }}
            onSelect={(seed) =>
              setOptions((current) => ({
                ...current,
                templateId: seed.templateId as GenerationOptions["templateId"],
                platform: seed.platform as GenerationOptions["platform"],
              }))
            }
          />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <h2 className="h3">{t("chooseSource")}</h2>
        </PanelHeader>
        <PanelBody>
          <SourceInput
            options={options}
            optionsFields={<GenerationOptionsFields value={options} onChange={setOptions} />}
          />
        </PanelBody>
      </Panel>
    </div>
  );
}
