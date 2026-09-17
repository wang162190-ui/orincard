import type { CSSProperties, ReactNode } from "react";
import type { CarouselDocument, Platform } from "../domain/document";
import { getPlatformDimensions } from "../domain/document";
import { resolveFontPair } from "./font-pairs";
import { isIconName, SlideIcon, type IconName } from "./icon";
import { SlideMotif } from "./motif";
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
  "--slide-density": number;
  "--slide-fg"?: string;
  "--slide-font-body"?: string;
  "--slide-font-display"?: string;
  "--slide-radius": string;
  "--slide-text-scale": number;
  "--slide-title-scale": number;
};

function textBlock(block: TextBlock, index: number, icon: IconName | null): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p key={index}>{block.text}</p>;
    case "bullets":
      return (
        // The marker is a real element rather than a ::marker glyph so it can be an icon; with no
        // icon set the list keeps its default disc via the list-style rule in slide.css.
        <ul key={index} data-bullet={icon ? "icon" : "disc"}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {icon ? <SlideIcon className="orincard-slide__bullet-icon" name={icon} /> : null}
              <span>{item}</span>
            </li>
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

  const slots = input.slide.assetSlots.map((slot, index) => {
    const asset = input.assets[slot.assetId];
    return (
      <div
        className="orincard-slide__asset-slot"
        data-slot-id={slot.slotId}
        key={`${slot.slotId}-${index}`}
        style={{ gridColumn: index + 1, gridRow: 1 }}
      >
        {asset && asset.state !== "failed" ? (
          <SlideImage asset={asset} slot={slot} />
        ) : (
          <div className="orincard-slide__asset-placeholder" role="status">
            Image required
          </div>
        )}
      </div>
    );
  });
  const gridStyle = slots.length > 0
    ? { gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }
    : undefined;

  if (input.slide.mode === "image") {
    return (
      <div className="orincard-slide__bleed" style={gridStyle}>
        {slots.length > 0 ? (
          slots
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
      <div className="orincard-slide__screenshot" style={gridStyle}>
        <div
          className="orincard-slide__screenshot-bar"
          aria-hidden="true"
          style={{ gridColumn: "1 / -1" }}
        >
          <i />
          <i />
          <i />
        </div>
        {slots.length > 0 ? (
          slots
        ) : (
          <div className="orincard-slide__asset-placeholder" role="status">
            Image required
          </div>
        )}
      </div>
    );
  }

  return input.slide.mode === "text_image" ? (
    <div className="orincard-slide__figure" style={gridStyle}>
      {slots.length > 0 ? (
        slots
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

/** 排版定标用的基准画幅，也就是 linkedin / instagram 的 1080×1350。 */
const BASELINE_ASPECT = 1350 / 1080;

/**
 * 字号与竖向节奏的密度系数。
 *
 * slide.css 里所有尺寸都是 `cqw`，也就是**按容器宽度**定标的。竖版画幅里宽度小于高度，
 * 这样定标没问题；一旦到了横屏，宽度反而是长边，同一个 `cqw` 在竖向上就被放大了
 * 1080/1350 ÷ 1080/1920 ≈ 2.2 倍——于是 16:9 会在正常文案长度上裁掉末行、把序号压到
 * 标题上、让箭头盖住正文。这是「按短边定标」的那一步。
 *
 * 只对**横屏**生效：宽 ≤ 高时恒为 1，所以 linkedin / instagram / tiktok / square 的
 * 计算值一个像素都不变，这条改动对已发货画幅不可能造成回归。
 */
function densityFor(width: number, height: number): number {
  if (width <= height) {
    return 1;
  }
  return Number((height / width / BASELINE_ASPECT).toFixed(4));
}

export function SlideRenderer({ input }: { readonly input: SlideRenderInput }) {
  const { slide, theme } = input;
  const { width, height } = getPlatformDimensions(input.platform);
  const colors = theme.colors ?? [];
  const fontPair = resolveFontPair(theme.fontPairId);
  const backgroundOverride = slide.overrides.background;
  const foregroundOverride = slide.overrides.foreground;
  const accentOverride = slide.overrides.accent;
  const titleScaleOverride = slide.overrides.titleScale;
  const textScaleOverride = slide.overrides.textScale;
  const radiusOverride = slide.overrides.radius;
  const alignmentOverride = slide.overrides.alignment;
  // An unknown name falls back to the plain marker rather than throwing: themes are stored
  // documents, and a deck saved against a later icon set must still render.
  const bulletIcon =
    theme.bulletIcon && isIconName(theme.bulletIcon) ? theme.bulletIcon : null;
  const style: SlideStyle = {
    "--slide-accent":
      typeof accentOverride === "string" ? accentOverride : colors[2],
    "--slide-aspect": `${width} / ${height}`,
    "--slide-bg":
      typeof backgroundOverride === "string"
        ? backgroundOverride
        : theme.background.value,
    "--slide-bg-opacity": theme.background.opacity,
    "--slide-density": densityFor(width, height),
    "--slide-fg":
      typeof foregroundOverride === "string" ? foregroundOverride : colors[1],
    "--slide-font-body": fontPair.body.css,
    "--slide-font-display": fontPair.display.css,
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
      data-background-motif={theme.background.motif ?? undefined}
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
      {/* Before the photo, not after: on an image slide the motif would otherwise sit on top of
          the picture it is meant to sit behind. */}
      {theme.background.motif ? (
        <SlideMotif motif={theme.background.motif} seed={slide.id} />
      ) : null}
      {slide.mode === "image" ? <VisualAsset input={input} /> : null}
      {slide.mode === "image" ? (
        <div
          className="orincard-slide__veil"
          aria-hidden="true"
          style={{ opacity: theme.background.opacity }}
        />
      ) : null}
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
          {/* Only the numbered-point layout sets its eyebrow in display type, so it is the one
              place where an icon reads as part of the mark rather than as decoration. */}
          {bulletIcon && slide.layoutId === "numbered-point" ? (
            <SlideIcon className="orincard-slide__eyebrow-icon" name={bulletIcon} />
          ) : null}
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
              {slide.bodyBlocks.map((block, index) => textBlock(block, index, bulletIcon))}
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
