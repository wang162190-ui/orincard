import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Panel,
  PanelBody,
  PanelHeader,
} from "../../src/components/ui";

const tokens = readFileSync(
  new URL("../../src/styles/tokens.css", import.meta.url),
  "utf8",
);
const primitives = readFileSync(
  new URL("../../src/components/ui.css", import.meta.url),
  "utf8",
);

describe("approved UI tokens", () => {
  it("keeps the paper, ink, and three signal colours from the design snapshot", () => {
    expect(tokens).toContain("--bg: oklch(96.8% 0.007 116)");
    expect(tokens).toContain("--fg: oklch(19.3% 0.010 117)");
    expect(tokens).toContain("--sig-pink: oklch(86.9% 0.058 347)");
    expect(tokens).toContain("--sig-yellow: oklch(90.5% 0.108 94)");
    expect(tokens).toContain("--sig-blue: oklch(83.0% 0.063 250)");
  });

  it("uses the pinned self-hosted font families", () => {
    expect(tokens).toContain('--font-display: "Source Serif 4 Variable"');
    expect(tokens).toContain('--font-body: "Inter Variable", "Noto Sans SC"');
  });
});

describe("UI primitives", () => {
  it("renders button variants with safe native defaults", () => {
    const markup = renderToStaticMarkup(
      <Button variant="secondary" size="small" aria-pressed>
        Preview
      </Button>,
    );

    expect(markup).toContain('type="button"');
    expect(markup).toContain('class="btn btn-secondary btn-sm"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("renders the approved panel structure without hiding native attributes", () => {
    const markup = renderToStaticMarkup(
      <Panel aria-label="Brand settings">
        <PanelHeader>Brand</PanelHeader>
        <PanelBody>Palette</PanelBody>
      </Panel>,
    );

    expect(markup).toContain('<section class="panel"');
    expect(markup).toContain('aria-label="Brand settings"');
    expect(markup).toContain('<div class="panel-head">Brand</div>');
    expect(markup).toContain('<div class="panel-body">Palette</div>');
  });

  it("renders a labelled modal dialog and supports the hidden state", () => {
    const markup = renderToStaticMarkup(
      <Dialog labelledBy="delete-title" hidden>
        <DialogHeader>
          <h2 id="delete-title">Delete project?</h2>
        </DialogHeader>
        <DialogBody>This cannot be undone.</DialogBody>
        <DialogFooter>Cancel</DialogFooter>
      </Dialog>,
    );

    expect(markup).toContain('class="scrim" hidden=""');
    expect(markup).toContain(
      'class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1"',
    );
    expect(markup).toContain('<div class="dialog-head">');
    expect(markup).toContain('<div class="dialog-body">This cannot be undone.</div>');
    expect(markup).toContain('<div class="dialog-foot">Cancel</div>');
  });

  it("keeps keyboard focus and hidden dialog behaviour explicit", () => {
    expect(primitives).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/s);
    expect(primitives).toMatch(/\.scrim\[hidden\]\s*\{\s*display:\s*none;/);
    expect(primitives).toContain(".btn[disabled]");
  });

  it("provides the approved responsive workspace shell primitives", () => {
    expect(primitives).toMatch(/\.app\s*\{[^}]*grid-template-columns:\s*var\(--rail-w\) 1fr/s);
    expect(primitives).toMatch(/\.rail\s*\{[^}]*background:\s*var\(--fg\)/s);
    expect(primitives).toMatch(/\.topbar\s*\{[^}]*position:\s*sticky/s);
    expect(primitives).toMatch(
      /@media \(max-width:\s*1180px\)\s*\{[^}]*\.app\s*\{\s*grid-template-columns:\s*64px 1fr/s,
    );
  });
});
