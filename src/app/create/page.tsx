import { Panel, PanelBody, PanelHeader } from "../../components/ui";
import { WorkspaceShell } from "../../components/workspace-shell";

const sourceTypes = [
  ["Topic", "Begin with a focused idea or working title."],
  ["Text", "Bring a draft, newsletter, or set of notes."],
  ["URL", "Use a public article or web page."],
  ["Video", "Prepare a public video you have the right to use."],
  ["PDF", "Bring a readable document for source extraction."],
  ["Slides", "Start from an existing PPTX presentation."],
] as const;

export default function CreatePage() {
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
            <div className="grid-2">
              {sourceTypes.map(([name, description]) => (
                <article
                  id={name.toLowerCase()}
                  key={name}
                  style={{
                    padding: 16,
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    background: "var(--surface-2)",
                  }}
                >
                  <h3 className="h3">{name}</h3>
                  <p style={{ margin: "6px 0 0", color: "var(--muted)" }}>
                    {description}
                  </p>
                </article>
              ))}
            </div>
          </PanelBody>
        </Panel>
      </div>
    </WorkspaceShell>
  );
}
