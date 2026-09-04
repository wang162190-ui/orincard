import type { CSSProperties, ReactNode } from "react";
import type { CarouselDocument, Platform } from "../domain/document";
import { getPlatformDimensions } from "../domain/document";
import "./slide.css";

type Slide = CarouselDocument["slides"][number];
type TextBlock = Slide["bodyBlocks"][number];

export type SlideRenderAsset = {
  readonly id: string;
  readonly src: string;
  readonly state: "ready" | "loading" | "failed";
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
};

export type SlideRenderInput = {
  readonly slide: Slide;
  readonly platform: Platform;
  readonly theme: CarouselDocument["theme"];
  readonly brandSnapshot: CarouselDocument["brandSnapshot"];
  readonly assets: Readonly<Record<string, SlideRenderAsset | undefined>>;
  readonly slideNumber: number;
  readonly slideCount: number;
};

type SlideStyle = CSSProperties & {
  "--slide-accent"?: string;
  "--slide-aspect": string;
  "--slide-bg": string;
  "--slide-bg-opacity": number;
  "--slide-fg"?: string;
  "--slide-font-body"?: string;
  "--slide-font-display"?: string;
  "--slide-radius": string;
  "--slide-text-scale": number;
  "--slide-title-scale": number;
};

const FONT_PAIR_STYLES: Record<
  string,
  { readonly body: string; readonly display: string }
> = {
  "source-serif-inter": {
    body: '"Inter Variable", "Noto Sans SC", sans-serif',
    display: '"Source Serif 4 Variable", "Noto Sans SC", serif',
  },
};

function textBlock(block: TextBlock, index: number): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p key={index}>{block.text}</p>;
    case "bullets":
      return (
        <ul key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{item}</li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <figure key={index}>
          <blockquote>{block.text}</blockquote>
          {block.attribution ? <figcaption>— {block.attribution}</figcaption> : null}
        </figure>
      );
  }
}

function SlideImage({
  asset,
  className,
  slot,
}: {
  readonly asset: SlideRenderAsset;
  readonly className?: string;
  readonly slot: Slide["assetSlots"][number];
}) {
  const centerX = (slot.crop.x + slot.crop.width / 2) * 100;
  const centerY = (slot.crop.y + slot.crop.height / 2) * 100;

  return (
    <img
      alt={slot.alt || asset.alt}
      className={className}
      data-asset-id={asset.id}
      data-slot-id={slot.slotId}
      decoding="async"
      height={asset.height}
      loading="eager"
      src={asset.src}
      style={{
        objectFit: slot.fit,
        objectPosition: `${centerX}% ${centerY}%`,
        opacity: slot.opacity,
      }}
      width={asset.width}
    />
  );
}

function VisualAsset({ input }: { readonly input: SlideRenderInput }) {
  if (input.slide.mode === "text") {
    return null;
  }

  const images = input.slide.assetSlots.map((slot, index) => {
    const asset = input.assets[slot.assetId];
    return asset && asset.state !== "failed" ? (
      <SlideImage asset={asset} key={`${slot.slotId}-${index}`} slot={slot} />
    ) : (
      <div
        className="orincard-slide__asset-placeholder"
        data-slot-id={slot.slotId}
        key={`${slot.slotId}-${index}`}
        role="status"
      >
        Image required
      </div>
    );
  });

  if (input.slide.mode === "image") {
    return (
      <div className="orincard-slide__bleed">
        {images.length > 0 ? (
          images
        ) : (
          <div className="orincard-slide__asset-placeholder" role="status">
            Image required
          </div>
        )}
      </div>
    );
  }

  if (input.slide.mode === "screenshot") {
    return (
      <div className="orincard-slide__screenshot">
        <div className="orincard-slide__screenshot-bar" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {images.length > 0 ? (
          images
        ) : (
          <div className="orincard-slide__asset-placeholder" role="status">
            Image required
          </div>
        )}
      </div>
    );
  }

  return input.slide.mode === "text_image" ? (
    <div className="orincard-slide__figure">
      {images.length > 0 ? (
        images
      ) : (
        <div className="orincard-slide__asset-placeholder" role="status">
          Image required
        </div>
      )}
    </div>
  ) : null;
}

function BrandFooter({ input }: { readonly input: SlideRenderInput }) {
  const brand = input.brandSnapshot;
  if (!brand || (input.slide.role !== "intro" && input.slide.role !== "outro")) {
    return input.slide.cta ? (
      <footer className="orincard-slide__footer" data-slide-content>
        <span className="orincard-slide__cta" data-slide-content>
          {input.slide.cta}
        </span>
      </footer>
    ) : null;
  }

  const portraitId = brand.headshotAssetId ?? brand.logoAssetId;
  const portrait = portraitId ? input.assets[portraitId] : undefined;

  return (
    <footer className="orincard-slide__footer" data-slide-content>
      {portrait && portrait.state !== "failed" ? (
        <img
          alt=""
          data-asset-id={portrait.id}
          decoding="async"
          height={portrait.height}
          loading="eager"
          src={portrait.src}
          width={portrait.width}
        />
      ) : null}
      <span className="orincard-slide__brand">
        <b>{brand.displayName ?? brand.name}</b>
        {brand.website ? <span>{brand.website}</span> : null}
      </span>
      {input.slide.cta ? (
        <span className="orincard-slide__cta" data-slide-content>
          {input.slide.cta}
        </span>
      ) : null}
    </footer>
  );
}

export function SlideRenderer({ input }: { readonly input: SlideRenderInput }) {
  const { slide, theme } = input;
  const { width, height } = getPlatformDimensions(input.platform);
  const colors = theme.colors ?? [];
  const fontPair = FONT_PAIR_STYLES[theme.fontPairId];
  const backgroundOverride = slide.overrides.background;
  const foregroundOverride = slide.overrides.foreground;
  const accentOverride = slide.overrides.accent;
  const titleScaleOverride = slide.overrides.titleScale;
  const textScaleOverride = slide.overrides.textScale;
  const radiusOverride = slide.overrides.radius;
  const alignmentOverride = slide.overrides.alignment;
  const style: SlideStyle = {
    "--slide-accent":
      typeof accentOverride === "string" ? accentOverride : colors[2],
    "--slide-aspect": `${width} / ${height}`,
    "--slide-bg":
      typeof backgroundOverride === "string"
        ? backgroundOverride
        : theme.background.value,
    "--slide-bg-opacity": theme.background.opacity,
    "--slide-fg":
      typeof foregroundOverride === "string" ? foregroundOverride : colors[1],
    "--slide-font-body": fontPair?.body,
    "--slide-font-display": fontPair?.display,
    "--slide-radius": `${
      typeof radiusOverride === "number" && radiusOverride >= 0
        ? radiusOverride
        : theme.radius
    }px`,
    "--slide-text-scale":
      typeof textScaleOverride === "number" && textScaleOverride > 0
        ? textScaleOverride
        : theme.textScale,
    "--slide-title-scale":
      typeof titleScaleOverride === "number" && titleScaleOverride > 0
        ? titleScaleOverride
        : 1,
    textAlign:
      alignmentOverride === "left" ||
      alignmentOverride === "center" ||
      alignmentOverride === "right"
        ? alignmentOverride
        : theme.alignment,
  };

  return (
    <article
      className={`orincard-slide orincard-slide--${slide.mode} orincard-slide--${slide.role} orincard-slide--palette-${theme.paletteId ?? "custom"} orincard-slide--layout-${slide.layoutId}`}
      data-arrow={theme.arrow}
      data-background-shape={theme.background.shape ?? undefined}
      data-background-texture={theme.background.texture ?? undefined}
      data-font-pair={theme.fontPairId}
      data-layout={slide.layoutId}
      data-mode={slide.mode}
      data-platform={input.platform}
      data-slide-content
      data-spacing={theme.spacing}
      data-slide-id={slide.id}
      data-slide-number={input.slideNumber}
      style={style}
    >
      <span className="orincard-slide__background" aria-hidden="true" />
      {slide.mode === "image" ? <VisualAsset input={input} /> : null}
      {slide.mode === "image" ? <div className="orincard-slide__veil" aria-hidden="true" /> : null}
      {theme.background.shape ? <span className="orincard-slide__shape" aria-hidden="true" /> : null}
      {slide.counterVisible && theme.counterStyle !== "none" ? (
        <span className="orincard-slide__counter" data-slide-content>
          {theme.counterStyle === "fraction"
            ? `${input.slideNumber} / ${input.slideCount}`
            : input.slideNumber}
        </span>
      ) : null}
      {slide.eyebrow ? (
        <p className="orincard-slide__eyebrow" data-slide-content>
          {slide.eyebrow}
        </p>
      ) : null}
      <div className="orincard-slide__main" data-slide-content>
        {slide.mode === "text_image" || slide.mode === "screenshot" ? (
          <VisualAsset input={input} />
        ) : null}
        <div className="orincard-slide__text">
          {slide.title ? <h2>{slide.title}</h2> : null}
          {slide.bodyBlocks.length > 0 ? (
            <div className="orincard-slide__body">
              {slide.bodyBlocks.map(textBlock)}
            </div>
          ) : null}
        </div>
      </div>
      <BrandFooter input={input} />
      {theme.arrow !== "none" ? (
        <span
          aria-hidden="true"
          className={`orincard-slide__arrow orincard-slide__arrow--${theme.arrow}`}
        />
      ) : null}
    </article>
  );
}
