import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNodeDnsResolver,
  createNodeHttpConnector,
  createSafeFetcher,
  safeFetch,
} from "../../src/server/sources/safe-fetch";
import { createUrlSourceParser } from "../../src/server/sources/url";
import type { SourceParseLimits } from "../../src/server/sources";
import { missingCloudKeys } from "../setup";

// This suite reaches the public internet and an isolated development Supabase project,
// so it stays behind an explicit switch. It never skips for missing credentials: a
// missing variable has to be a loud failure, not a silent pass.
const cloud = process.env.ORINCARD_RUN_URL_SOURCE_CLOUD === "1" ? describe : describe.skip;

const NETWORK_KEYS = ["ORINCARD_URL_SOURCE_PROBE_URL"] as const;
const SUPABASE_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ORINCARD_AUTH_TEST_EMAIL",
  "ORINCARD_AUTH_TEST_PASSWORD",
] as const;

const LIMITS: SourceParseLimits = {
  maxBytes: 2_000_000,
  maxSegments: 200,
  maxCharacters: 40_000,
  timeoutMs: 15_000,
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`ORINCARD_RUN_URL_SOURCE_CLOUD=1 requires development variable ${name}`);
  }
  return value;
}

function transport() {
  return { resolve: createNodeDnsResolver(), connect: createNodeHttpConnector() };
}

cloud("T039 real URL fetching over the public network", () => {
  beforeAll(() => {
    const missing = missingCloudKeys(NETWORK_KEYS);
    if (missing.length > 0) {
      throw new Error(
        `ORINCARD_RUN_URL_SOURCE_CLOUD=1 is missing required keys: ${missing.join(", ")}`,
      );
    }
  });

  it("extracts readable body text from a real public https article", async () => {
    const target = required("ORINCARD_URL_SOURCE_PROBE_URL");
    expect(target.startsWith("https://")).toBe(true);

    const parser = createUrlSourceParser({ fetch: createSafeFetcher(transport()) });
    const result = await parser.parse(target, LIMITS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.metadata.characterCount).toBeGreaterThan(50);
    expect(result.metadata.publicUrl?.startsWith("https://")).toBe(true);
    // Nothing that only a browser would have produced may leak into a segment.
    for (const segment of result.segments) {
      expect(segment.text).not.toContain("<script");
      expect(segment.text).not.toContain("</");
      expect(segment.text.trim().length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("refuses the cloud metadata endpoint with a real socket available", async () => {
    const result = await safeFetch("http://169.254.169.254/latest/meta-data/", {
      ...transport(),
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  }, 30_000);

  it("refuses a name that real DNS answers with a loopback address", async () => {
    const result = await safeFetch("http://localhost/", { ...transport(), timeoutMs: 5_000 });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  }, 30_000);

  it("refuses a real non-http scheme without opening a socket", async () => {
    const result = await safeFetch("file:///etc/passwd", transport());
    expect(result).toEqual({ ok: false, reason: "unsupported-scheme" });
  }, 30_000);

  it("stops a real oversized response at the byte limit", async () => {
    const target = required("ORINCARD_URL_SOURCE_PROBE_URL");
    const result = await safeFetch(target, { ...transport(), maxBytes: 64, timeoutMs: 15_000 });
    expect(result).toEqual({ ok: false, reason: "too-large" });
  }, 60_000);
});

cloud("T039 real development Supabase URL source", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(() => {
    const missing = missingCloudKeys(SUPABASE_KEYS);
    if (missing.length > 0) {
      throw new Error(
        `ORINCARD_RUN_URL_SOURCE_CLOUD=1 is missing required keys: ${missing.join(", ")}`,
      );
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("stores a parsed URL source the owner can read and refuses an unusable one", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const url = required("NEXT_PUBLIC_SUPABASE_URL");
    const publishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const secretKey = required("SUPABASE_SECRET_KEY");
    const email = required("ORINCARD_AUTH_TEST_EMAIL");
    const password = required("ORINCARD_AUTH_TEST_PASSWORD");
    const probe = required("ORINCARD_URL_SOURCE_PROBE_URL");

    const userClient = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const adminClient = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const login = await userClient.auth.signInWithPassword({ email, password });
    expect(login.error).toBeNull();
    const ownerId = login.data.user?.id;
    expect(ownerId).toBeTruthy();

    const parsed = await createUrlSourceParser({
      fetch: createSafeFetcher(transport()),
    }).parse(probe, LIMITS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const idempotencyKey = `cloud-url-source-${randomUUID()}`;
    // Only the URL and the request shape are hashed. The fetched body never leaves the
    // segments column and never reaches a receipt, a log or an error.
    const requestHash = createHmac("sha256", secretKey)
      .update(JSON.stringify({ kind: "url", url: probe }))
      .digest("hex");

    const created = await adminClient.rpc("server_create_url_source", {
      p_owner_id: ownerId!,
      p_metadata: parsed.metadata,
      p_segments: parsed.segments,
      p_expires_at: expiresAt,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
    });
    expect(created.error).toBeNull();
    const sourceId = (created.data as { readonly sourceId?: string } | null)?.sourceId;
    expect(sourceId).toBeTruthy();
    cleanup = async () => {
      await adminClient.from("sources").delete().eq("id", sourceId!);
      await userClient.auth.signOut({ scope: "local" });
    };

    const read = await userClient
      .from("sources")
      .select("id,owner_id,kind,state,metadata,expires_at")
      .eq("id", sourceId!)
      .single();
    expect(read.error).toBeNull();
    expect(read.data).toMatchObject({ owner_id: ownerId, kind: "url", state: "ready" });
    expect(String((read.data!.metadata as { publicUrl?: string }).publicUrl)).toMatch(/^https:\/\//);

    // The same call replayed with the same key returns the same source instead of a
    // second row.
    const replay = await adminClient.rpc("server_create_url_source", {
      p_owner_id: ownerId!,
      p_metadata: parsed.metadata,
      p_segments: parsed.segments,
      p_expires_at: expiresAt,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
    });
    expect(replay.error).toBeNull();
    expect((replay.data as { readonly sourceId?: string } | null)?.sourceId).toBe(sourceId);

    // A parse that produced nothing must never reach the database as an empty success,
    // and a non-https public URL must never be stored.
    const empty = await adminClient.rpc("server_create_url_source", {
      p_owner_id: ownerId!,
      p_metadata: { characterCount: 0, publicUrl: probe },
      p_segments: [],
      p_expires_at: expiresAt,
      p_idempotency_key: `cloud-url-empty-${randomUUID()}`,
      p_request_hash: requestHash,
    });
    expect(empty.error).not.toBeNull();

    const insecure = await adminClient.rpc("server_create_url_source", {
      p_owner_id: ownerId!,
      p_metadata: { characterCount: 12, publicUrl: "http://docs.example.com/a" },
      p_segments: [{ segmentId: randomUUID(), text: "Insecure source." }],
      p_expires_at: expiresAt,
      p_idempotency_key: `cloud-url-insecure-${randomUUID()}`,
      p_request_hash: requestHash,
    });
    expect(insecure.error).not.toBeNull();
  }, 120_000);
});
