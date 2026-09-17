import { boringAvatars } from "../assets/generated/boring-avatars";
import { MOTIF_IDS, type MotifId } from "./motifs";

export type { MotifId };

/** True only for a motif the generated module can actually draw. */
export function isMotifId(value: string): value is MotifId {
  return (MOTIF_IDS as readonly string[]).includes(value);
}

/**
 * The palette the generators paint with.
 *
 * These are CSS custom properties rather than hex strings so a motif recolours with the slide:
 * the palette rules in slide.css define `--motif-1…5`, and the fallbacks there derive from
 * `--slide-accent` / `--slide-fg`, so even a brand kit with custom colours gets a coherent motif
 * instead of a fixed set of upstream demo colours.
 *
 * Five entries because `ring` shuffles five and the others index fewer; a shorter array would
 * make two rings share a colour.
 */
const MOTIF_COLORS = [
  "var(--motif-1)",
  "var(--motif-2)",
  "var(--motif-3)",
  "var(--motif-4)",
  "var(--motif-5)",
];

/**
 * Draws the slide's background motif.
 *
 * The seed is the slide id, so every slide in a deck gets its own composition while the same deck
 * re-exports byte-identical. Unknown motif ids render nothing rather than throwing — the schema
 * lets them through on purpose.
 */
export function SlideMotif({ motif, seed }: { readonly motif: string; readonly seed: string }) {
  if (!isMotifId(motif)) return null;
  const Motif = boringAvatars[motif];
  return (
    <span className="orincard-slide__motif" data-motif={motif} aria-hidden="true">
      {/* square: the upstream default rounds the drawing into a circular avatar. The span is sized
          1:1 in slide.css, so the default `meet` already fills it without distorting ring's
          circles — no preserveAspectRatio override needed. */}
      <Motif name={`${motif}-${seed}`} colors={MOTIF_COLORS} square size="100%" />
    </span>
  );
}
