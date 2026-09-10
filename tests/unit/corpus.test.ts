import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sourceParseFailure, type SourceKind } from "../../src/server/sources";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function repoPathExists(path: string): boolean {
  return existsSync(new URL(path, `file://${repoRoot}`));
}

// The six values public.source_kind accepts. T090 has to cover every one of them, so the
// list is spelled out here and cross-checked against the SourceKind union below.
const SOURCE_KINDS = ["topic", "text", "url", "pdf", "slides", "video"] as const;
const kindsMatchUnion: readonly SourceKind[] = SOURCE_KINDS;
void kindsMatchUnion;

// Traits the acceptance matrix must exercise on top of plain source coverage: mixed
// scripts, the OCR path, real media, and hostile input.
const REQUIRED_TRAITS = ["mixed-script", "ocr", "media", "malicious"] as const;

const TRAITS = [
  ...REQUIRED_TRAITS,
  "emoji",
  "long-form",
  "edge-case",
  "subtitles",
  "transcription",
] as const;

// A rights record that says "unknown" is exactly the thing T088's licence review is meant
// to catch. Reject the vocabulary here so it can never reach the corpus in the first place.
const UNCHECKABLE_LICENCES = ["", "unknown", "unclear", "tbd", "n/a", "none", "assumed"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const nonEmpty = z.string().trim().min(1);

const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo-path"), value: nonEmpty }),
  z.object({ kind: z.literal("statement"), value: nonEmpty }),
]);

const rightsEntrySchema = z.object({
  rightsId: nonEmpty,
  holder: nonEmpty,
  origin: z.enum(["original", "synthesised", "public-domain", "licensed", "not-ingested"]),
  license: nonEmpty,
  grant: nonEmpty,
  acquiredOn: z.string().regex(ISO_DATE),
  evidence: evidenceSchema,
  redistribution: z.enum(["internal-acceptance-only", "public"]),
  notes: nonEmpty,
});

const rightsSchema = z.object({
  schemaVersion: z.literal(1),
  reviewedOn: z.string().regex(ISO_DATE),
  reviewedBy: nonEmpty,
  entries: z.array(rightsEntrySchema).min(1),
});

const materialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), text: z.string().min(1) }),
  z.object({ kind: z.literal("repo-file"), path: nonEmpty }),
  z.object({ kind: z.literal("hosted-repo-file"), path: nonEmpty, route: nonEmpty }),
  z.object({ kind: z.literal("url"), url: nonEmpty }),
  z.object({ kind: z.literal("derived"), recipe: nonEmpty, from: nonEmpty.optional() }),
]);

const sampleSchema = z.object({
  id: nonEmpty,
  kind: z.enum(SOURCE_KINDS),
  traits: z.array(z.enum(TRAITS)),
  summary: nonEmpty,
  rightsId: nonEmpty,
  material: materialSchema,
  expected: z.object({
    outcome: z.enum(["accept", "reject"]),
    failureCode: nonEmpty.optional(),
    note: nonEmpty,
  }),
});

const corpusSchema = z.object({
  schemaVersion: z.literal(1),
  task: z.literal("T090"),
  samples: z.array(sampleSchema).min(1),
});

const rights = rightsSchema.parse(readFixture("rights.json"));
const corpus = corpusSchema.parse(readFixture("corpus.json"));

describe("T090 authorised acceptance corpus", () => {
  it("registers exactly twenty samples under unique ids", () => {
    expect(corpus.samples).toHaveLength(20);
    const ids = corpus.samples.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all six source kinds", () => {
    const covered = new Set(corpus.samples.map((sample) => sample.kind));
    expect([...covered].sort()).toEqual([...SOURCE_KINDS].sort());
  });

  it("exercises mixed scripts, OCR, media and hostile input", () => {
    for (const trait of REQUIRED_TRAITS) {
      const matching = corpus.samples.filter((sample) => sample.traits.includes(trait));
      // One sample per trait proves nothing about the matrix; each of these paths has its
      // own failure modes and needs more than a single shape to be worth calling covered.
      expect(matching.length, `trait ${trait}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("gives every sample a rights entry that exists", () => {
    const known = new Set(rights.entries.map((entry) => entry.rightsId));
    for (const sample of corpus.samples) {
      expect(known, `${sample.id} rights`).toContain(sample.rightsId);
    }
  });

  it("leaves no rights entry unused and no id duplicated", () => {
    const ids = rights.entries.map((entry) => entry.rightsId);
    expect(new Set(ids).size).toBe(ids.length);
    const referenced = new Set(corpus.samples.map((sample) => sample.rightsId));
    for (const id of ids) {
      // An orphan rights record is a record nobody checked against real material.
      expect(referenced, `unused rights entry ${id}`).toContain(id);
    }
  });

  it("keeps every licence checkable rather than assumed", () => {
    for (const entry of rights.entries) {
      expect(
        UNCHECKABLE_LICENCES,
        `${entry.rightsId} licence`,
      ).not.toContain(entry.license.trim().toLowerCase());
      expect(Date.parse(entry.acquiredOn)).not.toBeNaN();
      if (entry.evidence.kind === "repo-path") {
        // Repo-path evidence is the only kind a machine can confirm, so confirm it.
        expect(repoPathExists(entry.evidence.value), entry.evidence.value).toBe(true);
      }
    }
  });

  it("points every repository-backed sample at a file that is really there", () => {
    for (const sample of corpus.samples) {
      const material = sample.material;
      if (material.kind === "repo-file" || material.kind === "hosted-repo-file") {
        expect(repoPathExists(material.path), `${sample.id} -> ${material.path}`).toBe(true);
      }
      if (material.kind === "derived" && material.from !== undefined) {
        expect(repoPathExists(material.from), `${sample.id} -> ${material.from}`).toBe(true);
      }
      if (material.kind === "url") {
        expect(() => new URL(material.url), `${sample.id} url`).not.toThrow();
      }
    }
  });

  it("states an expected outcome the source contract can actually produce", () => {
    for (const sample of corpus.samples) {
      if (sample.expected.outcome === "accept") {
        expect(sample.expected.failureCode, `${sample.id}`).toBeUndefined();
        continue;
      }
      expect(sample.expected.failureCode, `${sample.id}`).toBeDefined();
      const code = sample.expected.failureCode as Parameters<typeof sourceParseFailure>[0];
      // Throws for a code the parser contract does not define, which keeps the corpus from
      // drifting away from SourceParseFailureCode.
      const failure = sourceParseFailure(code);
      expect(failure.code).toBe(code);
      expect(failure.action.length).toBeGreaterThan(0);
    }
  });

  it("carries no material whose provenance is left to inference", () => {
    for (const sample of corpus.samples) {
      const entry = rights.entries.find((candidate) => candidate.rightsId === sample.rightsId);
      expect(entry, sample.id).toBeDefined();
      if (entry === undefined) continue;
      // Every sample is either written for Orincard, produced by us from our own text, or
      // an input we reject before reading a single byte. Nothing third-party is ingested.
      expect(["original", "synthesised", "not-ingested"], sample.id).toContain(entry.origin);
      if (entry.origin === "not-ingested") {
        expect(sample.expected.outcome, `${sample.id} must be rejected`).toBe("reject");
      }
    }
  });
});
