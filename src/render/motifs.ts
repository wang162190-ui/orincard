/**
 * The values `theme.background.motif` may take.
 *
 * A motif is a full-bleed generative drawing behind the text, built from the boring-avatars
 * generators vendored into src/assets/generated/boring-avatars.tsx. It is the vector themes'
 * graphic layer: nothing is a bitmap, everything takes its colour from the palette, so one motif
 * id renders correctly at 1080×1350 and at 1920×1080 in every theme.
 *
 * `beam` is deliberately absent. It draws a face, which reads as an avatar rather than as
 * decoration, so it stays available in the generated module for author bylines but is not
 * offered as a background.
 *
 * The field stays a plain string in the document schema, like `texture` and `bulletIcon`: a deck
 * saved with a motif this build does not know still renders, it just renders without one.
 */
export const MOTIF_IDS = ["marble", "bauhaus", "sunset", "ring", "pixel"] as const;

export type MotifId = (typeof MOTIF_IDS)[number];
