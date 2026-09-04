import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CreatePage from "../../src/app/create/page";
import RootLayout, { metadata } from "../../src/app/layout";
import HomePage from "../../src/app/page";
import { WorkspaceShell } from "../../src/components/workspace-shell";

describe("application routes", () => {
  it("defines the approved product metadata and English document language", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <p>Route content</p>
      </RootLayout>,
    );

    expect(metadata.title).toBe("Orincard — Create Social Carousels with AI");
    expect(metadata.description).toContain("editable LinkedIn, Instagram, and TikTok");
    expect(metadata.icons.icon).toMatch(/^data:image\/svg\+xml/);
    expect(markup).toContain('<html lang="en">');
  });

  it("renders the root as a product workspace with a working create entry", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain('data-page="workspace"');
    expect(markup).toContain("Your workspace");
    expect(markup).toContain('href="/create"');
    expect(markup).not.toContain("Prototype map");
    expect(markup).not.toContain(".html");
  });

  it("renders the create route with every approved source type", () => {
    const markup = renderToStaticMarkup(<CreatePage />);

    expect(markup).toContain('data-page="create"');
    expect(markup).toContain("Create a carousel");
    for (const source of ["Topic", "Text", "URL", "Video", "PDF", "Slides"]) {
      expect(markup).toContain(source);
    }
  });
});

describe("workspace shell", () => {
  it("uses the approved crane, rail, and current-page navigation semantics", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell current="create" title="New carousel">
        <p>Content</p>
      </WorkspaceShell>,
    );

    expect(markup).toContain('class="app"');
    expect(markup).toContain('class="rail"');
    expect(markup).toContain('aria-label="Main navigation"');
    expect(markup).toContain('aria-label="Orincard home"');
    expect(markup).toContain('aria-label="New carousel"');
    const createLink = markup.match(/<a[^>]*href="\/create"[^>]*>/)?.[0];
    expect(createLink).toContain('aria-current="page"');
  });

  it("does not link primary navigation to unimplemented or prototype routes", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell current="workspace" title="Workspace">
        <p>Content</p>
      </WorkspaceShell>,
    );
    const hrefs = [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(hrefs)).toEqual(new Set(["/", "/create"]));
    expect(markup).not.toContain("Prototype");
    expect(markup).not.toContain("Projects");
    expect(markup).not.toContain("Brand Kits");
    expect(markup).not.toContain("Editor");
  });
});
