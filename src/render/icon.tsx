import { ICON_VIEW_BOX, tablerIcons, type IconName } from "../assets/generated/tabler-icons";

export type { IconName };

/** True only for a name the generated module actually defines. */
export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(tablerIcons, value);
}

/**
 * Draws one vendored icon inline.
 *
 * Inline rather than an <img src="/icons/…">: src/render/render-deck.ts refuses any asset whose
 * src is not data: or file:, and an icon that cannot inherit the slide's colour would have to be
 * re-exported once per palette.
 *
 * The markup is interpolated because React cannot build elements from a string. It is not user
 * input: it comes from src/assets/generated/tabler-icons.ts, which scripts/vendor-assets.mjs
 * regenerates from a commit-pinned archive with a SHA-256 per file, and
 * tests/unit/vendor-assets.test.ts asserts every entry is drawing commands with no <svg> wrapper
 * and no literal colour.
 */
export function SlideIcon({
  name,
  className,
}: {
  readonly name: IconName;
  readonly className?: string;
}) {
  const icon = tablerIcons[name];
  const stroke =
    icon.variant === "outline"
      ? {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round" as const,
          strokeLinejoin: "round" as const,
        }
      : { fill: "currentColor" };

  return (
    <svg
      aria-hidden="true"
      className={className}
      data-icon={name}
      focusable="false"
      viewBox={ICON_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
      {...stroke}
      dangerouslySetInnerHTML={{ __html: icon.markup }}
    />
  );
}
