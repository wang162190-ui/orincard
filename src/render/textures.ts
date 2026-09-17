/**
 * The values `theme.background.texture` may take.
 *
 * The drawing itself lives in slide.css, keyed off `[data-background-texture="…"]`; this module
 * exists so the themes, the tests and any future picker all read one list instead of three copies
 * that drift. tests/ui/slide-texture.test.tsx parses slide.css and fails if the two disagree.
 *
 * The field stays a plain string in the document schema: a deck saved with a texture this build
 * does not know still renders, it just renders flat.
 */
export const TEXTURE_IDS = [
  "paper-grain",
  "dot-grid",
  "grid-lines",
  "diagonal-stripes",
  "cross-hatch",
  "lattice",
  "concentric-rings",
  "scales",
  "confetti",
  "halftone",
] as const;

export type TextureId = (typeof TEXTURE_IDS)[number];
