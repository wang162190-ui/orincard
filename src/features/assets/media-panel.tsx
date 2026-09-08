"use client";

import type { CarouselDocument } from "../../domain/document";
import { FULL_ASSET_CROP, normalizeAssetCrop } from "./crop";

export const MEDIA_SOURCES = [
  { id: "upload", label: "Upload" },
  { id: "stock", label: "Pexels" },
  { id: "screenshot", label: "Screenshot" },
  { id: "generated", label: "AI image" },
  { id: "portrait", label: "Portrait" },
  { id: "emoji", label: "Emoji" },
] as const;

export type MediaSource = (typeof MEDIA_SOURCES)[number]["id"];
export type MediaAsset = {
  readonly id: string;
  readonly label: string;
  readonly source: MediaSource;
  readonly previewUrl?: string;
  readonly assetRef: CarouselDocument["assetRefs"][number];
};

export interface MediaPanelProps {
  readonly document: CarouselDocument;
  readonly selectedSlideId: string;
  readonly assets: readonly MediaAsset[];
  readonly onDocumentChange: (document: CarouselDocument) => void;
  readonly onRequestSource?: (source: MediaSource) => void;
}

function primarySlot(document: CarouselDocument, selectedSlideId: string) {
  return document.slides.find((slide) => slide.id === selectedSlideId)?.assetSlots[0];
}

function updateSelectedSlide(
  document: CarouselDocument,
  selectedSlideId: string,
  update: (slide: CarouselDocument["slides"][number]) => CarouselDocument["slides"][number],
): CarouselDocument {
  let changed = false;
  const slides = document.slides.map((slide) => {
    if (slide.id !== selectedSlideId) return slide;
    changed = true;
    return { ...update(slide), revision: slide.revision + 1 };
  });
  return changed ? { ...document, slides } : document;
}

function withAsset(
  document: CarouselDocument,
  selectedSlideId: string,
  asset: MediaAsset,
): CarouselDocument {
  const current = primarySlot(document, selectedSlideId);
  const next = updateSelectedSlide(document, selectedSlideId, (slide) => ({
    ...slide,
    assetSlots: [
      {
        slotId: current?.slotId ?? `primary-${slide.id}`,
        assetId: asset.id,
        fit: current?.fit ?? "cover",
        crop: current?.crop ?? FULL_ASSET_CROP,
        opacity: current?.opacity ?? 1,
        alt: current?.alt || asset.label,
      },
      ...slide.assetSlots.slice(1),
    ],
  }));
  return next.assetRefs.some((reference) => reference.id === asset.id)
    ? next
    : { ...next, assetRefs: [...next.assetRefs, asset.assetRef] };
}

export function MediaPanel({
  document,
  selectedSlideId,
  assets,
  onDocumentChange,
  onRequestSource,
}: MediaPanelProps) {
  const selectedSlide = document.slides.find((slide) => slide.id === selectedSlideId);
  const slot = primarySlot(document, selectedSlideId);
  const crop = normalizeAssetCrop(slot?.crop ?? FULL_ASSET_CROP);

  if (!selectedSlide) return null;

  function replaceCrop(update: Partial<typeof crop>) {
    if (!slot) return;
    const nextCrop = normalizeAssetCrop({ ...crop, ...update });
    onDocumentChange(updateSelectedSlide(document, selectedSlideId, (slide) => ({
      ...slide,
      assetSlots: slide.assetSlots.map((candidate) =>
        candidate.slotId === slot.slotId ? { ...candidate, crop: nextCrop } : candidate,
      ),
    })));
  }

  return (
    <section aria-label="Media" className="stack" style={{ gap: 12 }}>
      <div>
        <h2 className="h3">Media</h2>
        <p className="meta">Choose a source, then reuse any accepted image on another slide.</p>
      </div>
      <div aria-label="Media sources" className="row wrap" style={{ gap: 6 }}>
        {MEDIA_SOURCES.map((source) => (
          <button key={source.id} onClick={() => onRequestSource?.(source.id)} type="button">
            {source.label}
          </button>
        ))}
      </div>
      <div aria-label="Available media" className="stack" style={{ gap: 6 }}>
        {assets.map((asset) => (
          <button
            aria-pressed={slot?.assetId === asset.id}
            key={asset.id}
            onClick={() => onDocumentChange(withAsset(document, selectedSlideId, asset))}
            type="button"
          >
            {asset.label} · {asset.source}
          </button>
        ))}
        {assets.length === 0 ? <p className="meta">No media is available yet.</p> : null}
      </div>
      <fieldset disabled={!slot}>
        <legend>Crop</legend>
        {(["x", "y", "width", "height"] as const).map((key) => (
          <label className="field" key={key}>
            <span>{key === "x" ? "Horizontal position" : key === "y" ? "Vertical position" : key === "width" ? "Crop width" : "Crop height"}</span>
            <input
              max="1"
              min={key === "width" || key === "height" ? "0.01" : "0"}
              onChange={(event) => replaceCrop({ [key]: Number(event.target.value) })}
              step="0.01"
              type="range"
              value={crop[key]}
            />
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Opacity</span>
        <input
          disabled={!slot}
          max="1"
          min="0"
          onChange={(event) => {
            if (!slot) return;
            const opacity = Math.min(1, Math.max(0, Number(event.target.value)));
            onDocumentChange(updateSelectedSlide(document, selectedSlideId, (slide) => ({
              ...slide,
              assetSlots: slide.assetSlots.map((candidate) =>
                candidate.slotId === slot.slotId ? { ...candidate, opacity } : candidate,
              ),
            })));
          }}
          step="0.01"
          type="range"
          value={slot?.opacity ?? 1}
        />
      </label>
    </section>
  );
}
