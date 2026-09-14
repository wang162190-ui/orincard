"use client";

import { useTranslations } from "next-intl";
import { GENERATION_LANGUAGES, type GenerationOptions } from "../../server/generation";

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  language: "en",
  format: "educational",
  pageCount: 6,
  instructions: "",
  templateId: "paper",
  platform: "linkedin",
};

export function GenerationOptionsFields(props: {
  readonly value: GenerationOptions;
  readonly disabled?: boolean;
  readonly onChange: (value: GenerationOptions) => void;
}) {
  const t = useTranslations("Options");
  function update<Key extends keyof GenerationOptions>(
    key: Key,
    value: GenerationOptions[Key],
  ) {
    props.onChange({ ...props.value, [key]: value });
  }

  return (
    <fieldset disabled={props.disabled} className="stack" style={{ border: 0, padding: 0 }}>
      <legend className="h3">{t("legend")}</legend>
      <div className="grid-2">
        <label className="field">
          {t("platform")}
          <select
            className="select"
            value={props.value.platform}
            onChange={(event) => update("platform", event.target.value as GenerationOptions["platform"])}
          >
            <option value="linkedin">LinkedIn</option>
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
          </select>
        </label>
        <label className="field">
          {t("template")}
          <select
            className="select"
            value={props.value.templateId}
            onChange={(event) => update("templateId", event.target.value as GenerationOptions["templateId"])}
          >
            <option value="ink">Ink</option>
            <option value="paper">Paper</option>
            <option value="signal">Signal</option>
            <option value="blush">Blush</option>
            <option value="butter">Butter</option>
            <option value="sky">Sky</option>
          </select>
        </label>
        <label className="field">
          {t("language")}
          <select
            className="select"
            value={props.value.language}
            onChange={(event) => update("language", event.target.value as GenerationOptions["language"])}
          >
            {GENERATION_LANGUAGES.map((language) => (
              <option key={language} value={language}>{t(`language_${language}`)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("format")}
          <select
            className="select"
            value={props.value.format}
            onChange={(event) => update("format", event.target.value)}
          >
            <option value="educational">{t("formatEducational")}</option>
            <option value="story">{t("formatStory")}</option>
            <option value="list">{t("formatList")}</option>
          </select>
        </label>
        <label className="field">
          {t("pageCount")}
          <input
            className="input"
            type="number"
            min={4}
            max={12}
            step={1}
            value={props.value.pageCount}
            onChange={(event) => update("pageCount", Number(event.target.value))}
          />
        </label>
      </div>
      <label className="field">
        {t("instructions")}
        <textarea
          className="textarea"
          maxLength={2_000}
          value={props.value.instructions}
          onChange={(event) => update("instructions", event.target.value)}
        />
      </label>
    </fieldset>
  );
}
