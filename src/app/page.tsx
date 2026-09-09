import Link from "next/link";
import { Panel, PanelBody, PanelHeader } from "../components/ui";
import { WorkspaceShell } from "../components/workspace-shell";

export default function HomePage() {
  return (
    <WorkspaceShell current="workspace" title="Workspace">
      <div className="stack" data-page="workspace" style={{ maxWidth: 900 }}>
        <header>
          <p className="eyebrow">Workspace</p>
          <h1 style={{ fontSize: 34 }}>Your workspace</h1>
          <p className="lead" style={{ marginTop: 8, fontSize: 16 }}>
            Start a carousel draft from a topic, text, URL, video, PDF, or slides.
          </p>
        </header>

        <div className="grid-2">
          <Panel>
            <PanelHeader>
              <h2 className="h3">New carousel</h2>
            </PanelHeader>
            <PanelBody className="stack">
              <p style={{ margin: 0 }}>
                Choose a source and prepare an editable carousel draft for LinkedIn,
                Instagram, or TikTok.
              </p>
              <div>
                <Link className="btn btn-primary" href="/create">
                  Choose a source
                </Link>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <h2 className="h3">Saved projects</h2>
            </PanelHeader>
            <PanelBody className="stack">
              <p style={{ margin: 0 }}>Search, filter, copy, archive, or continue a saved project.</p>
              <p className="meta" style={{ margin: 0 }}>
                Recent projects appear first.
              </p>
              <div><Link className="btn btn-secondary" href="/projects">Open project library</Link></div>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </WorkspaceShell>
  );
}
