export const TOOL_IMAGE_SIZES = {
  "quote-square": { id: "quote-square", width: 1080, height: 1080 },
  "infographic-portrait": { id: "infographic-portrait", width: 1080, height: 1350 },
  "portrait-square": { id: "portrait-square", width: 1024, height: 1024 },
} as const;

export type ToolImageSizeId = keyof typeof TOOL_IMAGE_SIZES;
export type ToolImageDimensions<K extends ToolImageSizeId = ToolImageSizeId> =
  (typeof TOOL_IMAGE_SIZES)[K];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function document(content: string, dimensions: ToolImageDimensions): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:${dimensions.width}px;height:${dimensions.height}px;overflow:hidden}
    body{font-family:Inter,Arial,sans-serif;background:#f5f1e8;color:#171717}.canvas{width:100%;height:100%;padding:9%;display:flex;flex-direction:column}
    .rule{width:72px;height:8px;background:#e85d3f;margin-bottom:8%}.quote{margin:auto 0;font-family:Georgia,serif;font-size:68px;line-height:1.12;letter-spacing:-1.5px}
    .attribution{margin-top:7%;font-size:25px;font-weight:700}.title{font-family:Georgia,serif;font-size:58px;line-height:1.05;margin:0 0 7%}.points{display:grid;gap:28px}
    .point{border-top:2px solid #171717;padding-top:20px;font-size:28px;line-height:1.35}.number{color:#e85d3f;font-weight:800;margin-right:14px}
  </style></head><body>${content}</body></html>`;
}

export function quoteCardTemplate(input: {
  readonly quote: string;
  readonly attribution?: string;
  readonly attributionConfirmed: boolean;
}): { readonly html: string; readonly dimensions: ToolImageDimensions<"quote-square"> } {
  const dimensions = TOOL_IMAGE_SIZES["quote-square"];
  const attribution = input.attributionConfirmed && input.attribution?.trim()
    ? `<p class="attribution">— ${escapeHtml(input.attribution.trim())}</p>`
    : "";
  return {
    dimensions,
    html: document(`<main class="canvas"><div class="rule"></div><blockquote class="quote">“${escapeHtml(input.quote.trim())}”</blockquote>${attribution}</main>`, dimensions),
  };
}

export function infographicTemplate(input: {
  readonly title: string;
  readonly points: readonly string[];
}): { readonly html: string; readonly dimensions: ToolImageDimensions<"infographic-portrait"> } {
  const dimensions = TOOL_IMAGE_SIZES["infographic-portrait"];
  const points = input.points.map((point, index) => `<div class="point"><span class="number">${String(index + 1).padStart(2, "0")}</span>${escapeHtml(point)}</div>`).join("");
  return {
    dimensions,
    html: document(`<main class="canvas"><div class="rule"></div><h1 class="title">${escapeHtml(input.title)}</h1><section class="points">${points}</section></main>`, dimensions),
  };
}
