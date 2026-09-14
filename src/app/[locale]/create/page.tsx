"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Panel, PanelBody, PanelHeader } from "@/components/ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { SourceInput } from "@/features/generation/source-input";
import {
  DEFAULT_GENERATION_OPTIONS,
  GenerationOptionsFields,
} from "@/features/generation/options";

export default function CreatePage() {
  const t = useTranslations("Create");
  const [options, setOptions] = useState(DEFAULT_GENERATION_OPTIONS);

  return (
    <WorkspaceShell current="create" title={t("shellTitle")}>
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
            <h2 className="h3">{t("chooseSource")}</h2>
          </PanelHeader>
          <PanelBody>
            <SourceInput
              options={options}
              optionsFields={(
                <GenerationOptionsFields
                  value={options}
                  onChange={setOptions}
                />
              )}
            />
          </PanelBody>
        </Panel>
      </div>
    </WorkspaceShell>
  );
}
