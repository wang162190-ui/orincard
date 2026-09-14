import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// T088 release guards. Every check here is a blocking condition: it reads the repository as it
// stands and fails when the evidence for shipping is missing. Nothing in this file contacts a
// cloud service, and nothing reads a credential value beyond the shape checks noted below.
//
// This file lives under tests/cloud/ and is therefore excluded from `pnpm test`
// (`vitest run --exclude 'tests/cloud/**'`). Run it explicitly:
//   pnpm exec vitest run tests/cloud/release-guards.test.ts

const root = fileURLToPath(new URL("../..", import.meta.url));
const LICENCE_DOC = "docs/licenses/assets.md";

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function tracked(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function readText(relative: string): string | null {
  let contents: string;
  try {
    contents = read(relative);
  } catch {
    return null;
  }
  return contents.includes("\u0000") ? null : contents;
}

/** Rows of the first markdown table under `heading`, header row dropped, backticks stripped. */
function table(markdown: string, heading: string): readonly (readonly string[])[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  expect(start, `${LICENCE_DOC} is missing the section "${heading}".`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  expect(rows.length, `${LICENCE_DOC} section "${heading}" has no table rows.`).toBeGreaterThan(0);
  return rows.slice(1);
}

function cell(row: readonly string[], index: number): string {
  return row[index] ?? "";
}

const UNKNOWN = /^(|-|—|\?|n\/a|tbd|todo|unknown|未知|待定|未登记|待确认)$/i;

// --- Guard 1 scope: material that ships inside the repository ------------------------------

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".wav", ".m4a", ".mov",
  ".pdf", ".pptx", ".zip",
]);

// Template and fixture manifests are material too: they carry the copy, the layouts and the
// sample documents that leave the repository inside a product build or an acceptance run.
const EXTRA_ASSET_PATHS = /^(content\/templates\.json|tests\/fixtures\/[^/]+\.json|docs\/design\/reference\/.+\.(?:html|css|js|json))$/;

function distributedAssets(): readonly string[] {
  return tracked()
    .filter((file) => ASSET_EXTENSIONS.has(path.extname(file).toLowerCase()) || EXTRA_ASSET_PATHS.test(file))
    .sort();
}

interface RightsEntry {
  readonly rightsId: string;
  readonly license: string;
  readonly redistribution: string;
}

function rightsEntries(): readonly RightsEntry[] {
  const parsed: unknown = JSON.parse(read("tests/fixtures/rights.json"));
  const entries = (parsed as { entries?: unknown }).entries;
  expect(Array.isArray(entries), "tests/fixtures/rights.json has no entries array.").toBe(true);
  return (entries as readonly Record<string, unknown>[]).map((entry) => ({
    rightsId: String(entry.rightsId ?? ""),
    license: String(entry.license ?? ""),
    redistribution: String(entry.redistribution ?? ""),
  }));
}

describe("T088 guard 1 — no unknown licence ships", () => {
  it("records every distributed asset in the licence inventory", () => {
    const rows = table(read(LICENCE_DOC), "## 1. 随仓库分发的素材文件");
    const recorded = new Set(rows.map((row) => cell(row, 0)));
    const missing = distributedAssets().filter((file) => !recorded.has(file));
    expect(missing, `These files ship in the repository with no row in ${LICENCE_DOC}.`).toEqual([]);
  });

  it("carries no stale inventory row", () => {
    const rows = table(read(LICENCE_DOC), "## 1. 随仓库分发的素材文件");
    const present = new Set(distributedAssets());
    const stale = rows.map((row) => cell(row, 0)).filter((file) => !present.has(file));
    expect(stale, `${LICENCE_DOC} lists files that are no longer tracked.`).toEqual([]);
  });

  it("refuses an asset whose licence or evidence is unknown", () => {
    const rows = table(read(LICENCE_DOC), "## 1. 随仓库分发的素材文件");
    const unresolved = rows
      .filter((row) => UNKNOWN.test(cell(row, 2)) || UNKNOWN.test(cell(row, 4)))
      .map((row) => `${cell(row, 0)} → 许可「${cell(row, 2) || "(空)"}」/ 证据「${cell(row, 4) || "(空)"}」`);
    expect(unresolved, "An asset with an unknown licence or no provenance evidence blocks release.").toEqual([]);
  });

  it("registers every font declared by src/render/font-manifest.json", () => {
    const parsed: unknown = JSON.parse(read("src/render/font-manifest.json"));
    const fonts = ((parsed as { fonts?: readonly Record<string, unknown>[] }).fonts ?? []).map((font) => String(font.id ?? ""));
    const rows = table(read(LICENCE_DOC), "## 2. 字体（随构建分发，文件来自 npm 包）");
    const recorded = new Map(rows.map((row) => [cell(row, 0), cell(row, 3)]));
    expect(fonts.filter((id) => !recorded.has(id)), `Fonts declared in the manifest but absent from ${LICENCE_DOC}.`).toEqual([]);
    expect([...recorded].filter(([id]) => !fonts.includes(id)).map(([id]) => id), "Stale font rows.").toEqual([]);
    expect([...recorded].filter(([, licence]) => UNKNOWN.test(licence)).map(([id]) => id), "Fonts with an unknown licence.").toEqual([]);
  });

  it("agrees with tests/fixtures/rights.json on every rights entry", () => {
    const entries = rightsEntries();
    const rows = table(read(LICENCE_DOC), "## 3. 权利条目对照（对齐 tests/fixtures/rights.json）");
    const documented = new Map(rows.map((row) => [cell(row, 0), { license: cell(row, 1), redistribution: cell(row, 2) }]));
    expect([...documented.keys()].sort(), "rightsId sets differ between the two files.").toEqual(entries.map((entry) => entry.rightsId).sort());
    const drifted = entries
      .filter((entry) => {
        const row = documented.get(entry.rightsId);
        return !row || row.license !== entry.license || row.redistribution !== entry.redistribution;
      })
      .map((entry) => entry.rightsId);
    expect(drifted, `${LICENCE_DOC} and rights.json disagree on licence or redistribution.`).toEqual([]);
  });

  it("only cites rights ids that rights.json actually defines", () => {
    const known = new Set(rightsEntries().map((entry) => entry.rightsId));
    const cited = table(read(LICENCE_DOC), "## 1. 随仓库分发的素材文件")
      .map((row) => cell(row, 3))
      .filter((value) => value !== "-" && value.length > 0);
    expect([...new Set(cited)].filter((id) => !known.has(id)), "Asset rows cite rights ids that rights.json does not define.").toEqual([]);
  });

  it("only lets the corpus cite rights ids that rights.json defines", () => {
    const known = new Set(rightsEntries().map((entry) => entry.rightsId));
    const parsed: unknown = JSON.parse(read("tests/fixtures/corpus.json"));
    const samples = ((parsed as { samples?: readonly Record<string, unknown>[] }).samples ?? []);
    const orphans = samples
      .map((sample) => ({ id: String(sample.id ?? ""), rightsId: String(sample.rightsId ?? "") }))
      .filter((sample) => !known.has(sample.rightsId))
      .map((sample) => `${sample.id} → ${sample.rightsId || "(空)"}`);
    expect(orphans, "corpus.json samples reference rights ids that rights.json does not define.").toEqual([]);
  });
});

// --- Guard 2: the models we actually call are registered ------------------------------------

const MODEL_PATTERNS: readonly RegExp[] = [
  /\b(?:model|resourceId)\s*[:=]\s*"([^"]+)"/g,
  /\bAI_[A-Z_]*MODEL\s*=\s*"([^"]+)"/g,
  /process\.env\.AI_[A-Z_]*MODEL\s*\?\?\s*"([^"]+)"/g,
];

function modelsUsedInSource(): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, string[]>();
  for (const file of tracked().filter((entry) => entry.startsWith("src/") && /\.tsx?$/.test(entry))) {
    const contents = readText(file);
    if (contents === null) continue;
    for (const pattern of MODEL_PATTERNS) {
      for (const match of contents.matchAll(pattern)) {
        const model = match[1];
        if (!model) continue;
        const sites = found.get(model) ?? [];
        if (!sites.includes(file)) sites.push(file);
        found.set(model, sites);
      }
    }
  }
  return found;
}

describe("T088 guard 2 — every model in use is registered", () => {
  it("finds the models the source actually names", () => {
    // A regression fence: if this ever returns nothing, the extraction broke and guard 2 would
    // pass vacuously. Failing loudly is the point.
    expect([...modelsUsedInSource().keys()].length, "No model literal was extracted from src/; the scan is broken.").toBeGreaterThan(0);
  });

  it("registers each model with a purpose and a commercial-use verdict", () => {
    const rows = table(read(LICENCE_DOC), "## 4. 模型资格");
    const documented = new Map(rows.map((row) => [cell(row, 0), row]));
    const used = modelsUsedInSource();
    const unregistered = [...used].filter(([model]) => !documented.has(model)).map(([model, sites]) => `${model} (${sites.join(", ")})`);
    expect(unregistered, `Models called by src/ but absent from ${LICENCE_DOC}.`).toEqual([]);
    const incomplete = [...used.keys()]
      .map((model) => documented.get(model))
      .filter((row): row is readonly string[] => row !== undefined)
      .filter((row) => UNKNOWN.test(cell(row, 2)) || UNKNOWN.test(cell(row, 3)) || UNKNOWN.test(cell(row, 4)))
      .map((row) => cell(row, 0));
    expect(incomplete, "Registered models missing a purpose, a commercial-use verdict, or a retention note.").toEqual([]);
  });

  it("carries no model row that the code has stopped calling", () => {
    const used = modelsUsedInSource();
    const stale = table(read(LICENCE_DOC), "## 4. 模型资格")
      .map((row) => cell(row, 0))
      .filter((model) => !used.has(model));
    expect(stale, `${LICENCE_DOC} registers models that src/ no longer calls.`).toEqual([]);
  });
});

// --- Guard 3: payment configuration and policy copy ------------------------------------------

const STRIPE_ENV_IN_SOURCE = /\bprocess\.env(?:\.|\[")(STRIPE_[A-Z0-9_]+)/g;
const STRIPE_ENV_TEMPLATED = /environment\[`\$\{prefix\}_([A-Z0-9_]+)`\]/g;

function stripeVariablesReadBySource(): readonly string[] {
  const names = new Set<string>();
  for (const file of tracked().filter((entry) => entry.startsWith("src/") && /\.tsx?$/.test(entry))) {
    const contents = readText(file);
    if (contents === null) continue;
    for (const match of contents.matchAll(STRIPE_ENV_IN_SOURCE)) if (match[1]) names.add(match[1]);
    for (const match of contents.matchAll(STRIPE_ENV_TEMPLATED)) if (match[1]) names.add(`STRIPE_TEST_${match[1]}`);
  }
  return [...names].sort();
}

/** Names only. This never returns, logs or asserts on a credential value. */
function missingEnvironment(names: readonly string[]): readonly string[] {
  return names.filter((name) => (process.env[name]?.trim() ?? "") === "");
}

const REQUIRED_STRIPE_RUNTIME = [
  "STRIPE_TEST_SECRET_KEY",
  "STRIPE_TEST_MONTHLY_PRICES_JSON",
  "STRIPE_TEST_ACCEPTANCE_PLAN_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "RUN_STRIPE_SANDBOX_LIFECYCLE",
] as const;

describe("T088 guard 3 — payment configuration and policy are complete", () => {
  it("documents every STRIPE_* variable the source reads in .env.example", () => {
    const documented = new Set([...read(".env.example").matchAll(/^(STRIPE_[A-Z0-9_]+)=/gm)].map((match) => match[1] ?? ""));
    const undocumented = stripeVariablesReadBySource().filter((name) => !documented.has(name));
    expect(undocumented, "src/ reads STRIPE_* variables that .env.example does not document.").toEqual([]);
  });

  it("has the Stripe test-mode configuration present", () => {
    // Presence only. The single value inspection below is a prefix check that never prints.
    expect(missingEnvironment([...REQUIRED_STRIPE_RUNTIME]), "Release is blocked until these variables are configured in the operator's own shell.").toEqual([]);
  });

  it("refuses anything but a Stripe test key and a test Price mapping", () => {
    const secretKey = process.env.STRIPE_TEST_SECRET_KEY?.trim() ?? "";
    expect(secretKey.startsWith("sk_test_"), "STRIPE_TEST_SECRET_KEY is absent or is not a test-mode key (value never printed).").toBe(true);
    expect((process.env.STRIPE_TEST_MONTHLY_PRICES_JSON ?? "").includes("price_"), "STRIPE_TEST_MONTHLY_PRICES_JSON carries no price_ id.").toBe(true);
    expect(process.env.STRIPE_LIVE_SECRET_KEY?.trim() ?? "", "A live Stripe key must never be present during acceptance.").toBe("");
  });

  // S17 起每份法律文本有两个语言版本。只查英文那份，中文站可以挂着未审定条款照常上线。
  const LEGAL_SLUGS = ["terms", "privacy", "affiliate"] as const;
  const LEGAL_FILES = ["en", "zh-Hans"].flatMap((locale) =>
    LEGAL_SLUGS.map((slug) => (locale === "en" ? `content/legal/${slug}.mdx` : `content/${locale}/legal/${slug}.mdx`)),
  );

  it("ships approved payment policy copy in every locale", () => {
    for (const file of LEGAL_FILES) {
      const contents = read(file);
      const status = /^publicationStatus:\s*(\S+)/m.exec(contents)?.[1] ?? "";
      expect(status, `${file} is still ${status || "unlabelled"}; approved policy copy is a release precondition.`).toBe("approved");
    }
  });

  it("covers subscription, cancellation and refund terms in the copy", () => {
    const terms = read("content/legal/terms.mdx");
    for (const topic of ["subscription", "cancellation", "refund"]) {
      expect(new RegExp(topic, "i").test(terms), `content/legal/terms.mdx does not cover ${topic}.`).toBe(true);
    }
    // 中文版按中文关键词查同样三件事——照搬英文正则只会因为一个字都不匹配而误报。
    const zhTerms = read("content/zh-Hans/legal/terms.mdx");
    for (const topic of ["订阅|方案与账单", "取消", "退款"]) {
      expect(new RegExp(topic).test(zhTerms), `content/zh-Hans/legal/terms.mdx does not cover ${topic}.`).toBe(true);
    }
  });
});

// --- Guard 4: nothing improper is staged for release -----------------------------------------

const SECRET_SHAPES: readonly (readonly [string, RegExp])[] = [
  ["Stripe key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["Supabase/JWT bearer", /\beyJhbGciOi[A-Za-z0-9._-]{20,}/],
  ["PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["assigned secret", /\b(?:SUPABASE_SECRET_KEY|DEEPSEEK_API_KEY|APIMART_API_KEY|VOLCENGINE_SPEECH_API_KEY|TRIGGER_SECRET_KEY|RESEND_API_KEY|PEXELS_API_KEY)[ \t]*=[ \t]*\S+/],
];

const SCANNABLE = /\.(?:ts|tsx|js|mjs|cjs|json|md|mdx|sql|ya?ml|css|html|txt|example|sh)$/;

describe("T088 guard 4 — the release contains no secret, user copy or unlicensed material", () => {
  it("tracks no environment file other than .env.example", () => {
    const leaked = tracked().filter((file) => /(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example"));
    expect(leaked, "An .env file is tracked in Git.").toEqual([]);
  });

  it("commits no secret-shaped literal", () => {
    const hits: string[] = [];
    for (const file of tracked()) {
      if (!SCANNABLE.test(file) && !file.endsWith(".env.example")) continue;
      const contents = readText(file);
      if (contents === null) continue;
      for (const [label, pattern] of SECRET_SHAPES) {
        const match = pattern.exec(contents);
        if (!match) continue;
        // Report the file and the shape, never the matched text.
        hits.push(`${file}: ${label}`);
      }
    }
    expect(hits, "A committed file matches a credential shape.").toEqual([]);
  });

  it("commits no corpus material outside tests/fixtures", () => {
    const parsed: unknown = JSON.parse(read("tests/fixtures/corpus.json"));
    const samples = ((parsed as { samples?: readonly Record<string, unknown>[] }).samples ?? []);
    const passages = samples
      .map((sample) => (sample.material as { kind?: string; text?: string } | undefined))
      .filter((material): material is { kind: string; text: string } => material?.kind === "inline" && typeof material.text === "string" && material.text.length >= 24)
      .map((material) => material.text);
    const hits: string[] = [];
    for (const file of tracked()) {
      if (file.startsWith("tests/fixtures/") || !SCANNABLE.test(file)) continue;
      const contents = readText(file);
      if (contents === null) continue;
      for (const passage of passages) if (contents.includes(passage)) hits.push(`${file}`);
    }
    expect([...new Set(hits)], "Acceptance corpus material has been copied outside tests/fixtures.").toEqual([]);
  });

  it("commits no asset that the licence inventory cannot vouch for", () => {
    const cleared = new Set(
      table(read(LICENCE_DOC), "## 1. 随仓库分发的素材文件")
        .filter((row) => !UNKNOWN.test(cell(row, 2)) && !UNKNOWN.test(cell(row, 4)))
        .map((row) => cell(row, 0)),
    );
    const uncleared = distributedAssets().filter((file) => !cleared.has(file));
    expect(uncleared, "These assets are committed without a cleared licence row.").toEqual([]);
  });
});
