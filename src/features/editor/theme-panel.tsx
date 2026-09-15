"use client";

import { useTranslations } from "next-intl";
import { platformKeys, type CarouselDocument, type Platform } from "../../domain/document";
import {
  THEME_IDS,
  getThemeId,
  previewAppearance,
  themes,
  type AppearancePreview,
  type ThemeId,
} from "../../render/templates";

export interface ThemePanelProps {
  readonly document: CarouselDocument;
  readonly onChange: (preview: AppearancePreview) => void;
  readonly disabled?: boolean;
}

export function ThemePanel({
  document,
  onChange,
  disabled = false,
}: ThemePanelProps) {
  const t = useTranslations("Theme");
  // 画幅清单从 platformPresets 派生，标签走 Platform 词条：加一种画幅只改这两处。
  const platformLabel = useTranslations("Platform");
  const selectedTheme = getThemeId(document);
  const currentPreview = previewAppearance(document, {});

  function selectTheme(themeId: ThemeId) {
    onChange(previewAppearance(document, { themeId }));
  }

  function selectPlatform(platform: Platform) {
    onChange(previewAppearance(document, { platform }));
  }

  return (
    <section aria-label={t("label")} className="theme-panel">
      <fieldset disabled={disabled}>
        <legend>{t("theme")}</legend>
        <div className="theme-panel__themes">
          {THEME_IDS.map((themeId) => (
            <label key={themeId} className="theme-panel__option">
              <input
                type="radio"
                name="carousel-theme"
                value={themeId}
                checked={selectedTheme === themeId}
                onChange={() => selectTheme(themeId)}
              />
              <span aria-hidden="true" data-theme-preview={themeId} />
              <span>{themes[themeId].name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>{t("platform")}</legend>
        <div className="theme-panel__platforms">
          {platformKeys.map((platform) => (
            <label key={platform}>
              <input
                type="radio"
                name="carousel-platform"
                value={platform}
                checked={document.platform === platform}
                onChange={() => selectPlatform(platform)}
              />
              <span>{platformLabel(platform)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div role="status" aria-live="polite" aria-atomic="true">
        {currentPreview.conflicts.length === 0 ? (
          <p>{t("noConflicts")}</p>
        ) : (
          <ul>
            {currentPreview.conflicts.map((conflict) => (
              <li key={`${conflict.slideId}-${conflict.code}`}>
                {conflict.slideId}: {conflict.message} {conflict.repairAction}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
