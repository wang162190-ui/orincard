"use client";

import { useState } from "react";
import { Panel, PanelBody, PanelHeader } from "../../components/ui";
import { WorkspaceShell } from "../../components/workspace-shell";
import { SourceInput } from "../../features/generation/source-input";
import {
  DEFAULT_GENERATION_OPTIONS,
  GenerationOptionsFields,
} from "../../features/generation/options";

export default function CreatePage() {
  const [options, setOptions] = useState(DEFAULT_GENERATION_OPTIONS);

  return (
    <WorkspaceShell current="create" title="New carousel">
      <div className="stack" data-page="create" style={{ maxWidth: 900 }}>
        <header>
          <p className="eyebrow">New carousel</p>
          <h1 style={{ fontSize: 34 }}>Create a carousel</h1>
          <p className="lead" style={{ marginTop: 8, fontSize: 16 }}>
            Pick a platform, give Orincard a source, and continue to an editable draft.
          </p>
        </header>

        <Panel>
          <PanelHeader>
            <h2 className="h3">Choose a source</h2>
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
            <p className="meta">
              URL, Video, PDF, and Slides sources are not available in this preview yet.
            </p>
          </PanelBody>
        </Panel>
      </div>
    </WorkspaceShell>
  );
}
