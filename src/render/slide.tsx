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
  "--slide-fg"?: string;
  "--slide-radius": string;
  "--slide-text-scale": number;
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

function assetFor(input: SlideRenderInput): {
  asset: SlideRenderAsset;
  slot: Slide["assetSlots"][number];
} | null {
  const slot = input.slide.assetSlots[0];
  const asset = slot ? input.assets[slot.assetId] : undefined;
  return slot && asset && asset.state !== "failed" ? { asset, slot } : null;
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
  const resolved = assetFor(input);
  if (!resolved) {
    return input.slide.mode === "text" ? null : (
      <div className="orincard-slide__asset-placeholder" role="status">
        Image required
      </div>
    );
  }

  const { asset, slot } = resolved;
  if (input.slide.mode === "image") {
    return (
      <div className="orincard-slide__bleed">
        <SlideImage asset={asset} slot={slot} />
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
        <SlideImage asset={asset} slot={slot} />
      </div>
    );
  }

  return input.slide.mode === "text_image" ? (
    <div className="orincard-slide__figure">
      <SlideImage asset={asset} slot={slot} />
    </div>
  ) : null;
}

function BrandFooter({ input }: { readonly input: SlideRenderInput }) {
  const brand = input.brandSnapshot;
  if (!brand || (input.slide.role !== "intro" && input.slide.role !== "outro")) {
    return input.slide.cta ? (
      <footer className="orincard-slide__footer">
        <span className="orincard-slide__cta">{input.slide.cta}</span>
      </footer>
    ) : null;
  }

  const portraitId = brand.headshotAssetId ?? brand.logoAssetId;
  const portrait = portraitId ? input.assets[portraitId] : undefined;

  return (
    <footer className="orincard-slide__footer">
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
        <span className="orincard-slide__cta">{input.slide.cta}</span>
      ) : null}
    </footer>
  );
}

export function SlideRenderer({ input }: { readonly input: SlideRenderInput }) {
  const { slide, theme } = input;
  const { width, height } = getPlatformDimensions(input.platform);
  const colors = theme.colors ?? [];
  const style: SlideStyle = {
    "--slide-accent": colors[2],
    "--slide-aspect": `${width} / ${height}`,
    "--slide-bg": theme.background.value,
    "--slide-fg": colors[1],
    "--slide-radius": `${theme.radius}px`,
    "--slide-text-scale": theme.textScale,
    textAlign: theme.alignment,
  };

  return (
    <article
      className={`orincard-slide orincard-slide--${slide.mode} orincard-slide--${slide.role} orincard-slide--palette-${theme.paletteId ?? "custom"}`}
      data-mode={slide.mode}
      data-platform={input.platform}
      data-spacing={theme.spacing}
      data-slide-id={slide.id}
      data-slide-number={input.slideNumber}
      style={style}
    >
      {slide.mode === "image" ? <VisualAsset input={input} /> : null}
      {slide.mode === "image" ? <div className="orincard-slide__veil" aria-hidden="true" /> : null}
      {theme.background.shape ? <span className="orincard-slide__shape" aria-hidden="true" /> : null}
      {slide.counterVisible && theme.counterStyle !== "none" ? (
        <span className="orincard-slide__counter">
          {theme.counterStyle === "fraction"
            ? `${input.slideNumber} / ${input.slideCount}`
            : input.slideNumber}
        </span>
      ) : null}
      {slide.eyebrow ? <p className="orincard-slide__eyebrow">{slide.eyebrow}</p> : null}
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
    </article>
  );
}
