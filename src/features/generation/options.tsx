"use client";

import type { GenerationOptions } from "../../server/generation";

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  language: "English",
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
  function update<Key extends keyof GenerationOptions>(
    key: Key,
    value: GenerationOptions[Key],
  ) {
    props.onChange({ ...props.value, [key]: value });
  }

  return (
    <fieldset disabled={props.disabled} className="stack" style={{ border: 0, padding: 0 }}>
      <legend className="h3">Generation options</legend>
      <div className="grid-2">
        <label className="field">
          Platform
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
          Template
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
          Language
          <input
            className="input"
            value={props.value.language}
            maxLength={80}
            onChange={(event) => update("language", event.target.value)}
          />
        </label>
        <label className="field">
          Content format
          <select
            className="select"
            value={props.value.format}
            onChange={(event) => update("format", event.target.value)}
          >
            <option value="educational">Educational</option>
            <option value="story">Story</option>
            <option value="list">List</option>
          </select>
        </label>
        <label className="field">
          Number of slides
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
        Instructions
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
