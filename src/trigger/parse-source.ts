import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { PDF_PARSE_LIMITS, createPdfSourceParser } from "../server/sources/pdf";
import { SLIDES_PARSE_LIMITS, createSlidesSourceParser } from "../server/sources/slides";
import { VIDEO_PARSE_LIMITS, createVideoSourceParser } from "../server/sources/video";
import type { SourceParseResult } from "../server/sources/index";
import { createAdminSupabaseClient } from "../server/supabase";
import { PARSE_SOURCE_TASK_ID } from "./dispatch";

export { PARSE_SOURCE_TASK_ID };

// T042. The one worker that turns an uploaded file into source segments. Which parser runs
// is decided by the source row, not by the payload: the payload carries a reference and
// nothing else, so a caller cannot talk the worker into reading a different file.

const payloadSchema = z
  .object({
    sourceId: z.string().uuid(),
    schemaVersion: z.literal(1),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export type SourceParsePayload = z.infer<typeof payloadSchema>;

export function parseSourceTaskPayload(payload: unknown): SourceParsePayload {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Source parse payload must be reference-only.");
  }
  return parsed.data;
}

// The three kinds server_create_file_source will register. topic, text and url are parsed
// in the request that creates them and never reach a worker.
const FILE_SOURCE_KINDS = ["pdf", "slides", "video"] as const;
type FileSourceKind = (typeof FILE_SOURCE_KINDS)[number];

interface SourceRow {
  id: string;
  owner_id: string;
  kind: string;
  asset_id: string | null;
  state: string;
  metadata: Record<string, unknown> | null;
}

interface AssetRow {
  bucket: string;
  object_key: string;
  bytes: number | string | null;
}

export type SourceParseOutcome = {
  readonly sourceId: string;
  readonly state: "ready" | "failed" | "skipped";
};

async function finalize(
  client: SupabaseClient,
  source: SourceRow,
  result: SourceParseResult,
): Promise<SourceParseOutcome> {
  const base = (source.metadata ?? {}) as Record<string, unknown>;
  const { error } = await client.rpc("server_finalize_source_parse", {
    p_source_id: source.id,
    p_owner_id: source.owner_id,
    p_segments: result.ok ? result.segments : [],
    // On failure the metadata keeps the alternative action and its message so the page can
    // offer the user a way forward. Neither carries any of the parsed text.
    p_metadata: result.ok
      ? { ...base, ...result.metadata }
      : { ...base, action: result.action, message: result.message },
    p_error_code: result.ok ? null : result.code,
  });
  if (error) throw new Error("Source parse could not be finalized.");
  return { sourceId: source.id, state: result.ok ? "ready" : "failed" };
}

export async function executeSourceParse(
  sourceId: string,
  client: SupabaseClient = createAdminSupabaseClient(),
): Promise<SourceParseOutcome> {
  const { data: source, error } = await client
    .from("sources")
    .select("id, owner_id, kind, asset_id, state, metadata")
    .eq("id", sourceId)
    .maybeSingle<SourceRow>();
  if (error) throw new Error("Source could not be read.");
  // A missing row or one that already reached a terminal state is the normal outcome of a
  // retried run. Re-parsing it would spend the transcription budget a second time.
  if (!source || source.state !== "parsing") return { sourceId, state: "skipped" };
  if (!FILE_SOURCE_KINDS.includes(source.kind as FileSourceKind) || !source.asset_id) {
    return finalize(client, source, {
      ok: false,
      code: "SOURCE_UNSUPPORTED_FORMAT",
      action: "upload-file",
      message: "This source can't be parsed here. Upload the file again.",
    });
  }

  const { data: asset, error: assetError } = await client
    .from("assets")
    .select("bucket, object_key, bytes")
    .eq("id", source.asset_id)
    .eq("owner_id", source.owner_id)
    .eq("state", "ready")
    .maybeSingle<AssetRow>();
  if (assetError) throw new Error("Source file could not be read.");
  if (!asset) {
    return finalize(client, source, {
      ok: false,
      code: "SOURCE_UNAVAILABLE",
      action: "upload-file",
      message: "The uploaded file is no longer available. Upload it again.",
    });
  }

  const { data: blob, error: downloadError } = await client.storage
    .from(asset.bucket)
    .download(asset.object_key);
  if (downloadError || !blob) {
    return finalize(client, source, {
      ok: false,
      code: "SOURCE_UNAVAILABLE",
      action: "upload-file",
      message: "The uploaded file could not be opened. Upload it again.",
    });
  }
  const bytes = Buffer.from(await blob.arrayBuffer());

  if (source.kind === "slides") {
    // The PPTX reader works on the archive in memory; no temporary file is involved.
    return finalize(
      client,
      source,
      await createSlidesSourceParser().parse(
        { data: bytes, title: readTitle(source.metadata) },
        SLIDES_PARSE_LIMITS,
      ),
    );
  }

  // poppler and ffmpeg are separate processes that read a path, so these two kinds need
  // the bytes on disk. The directory is removed whatever the parser decides.
  const directory = await mkdtemp(join(tmpdir(), "orincard-source-"));
  const filePath = join(directory, source.kind === "pdf" ? "source.pdf" : "source.media");
  try {
    await writeFile(filePath, bytes);
    const input = {
      filePath,
      byteLength: bytes.byteLength,
      ...(readTitle(source.metadata) ? { title: readTitle(source.metadata) } : {}),
    };
    const result =
      source.kind === "pdf"
        ? await createPdfSourceParser().parse(input, PDF_PARSE_LIMITS)
        : await createVideoSourceParser().parse(
            { ...input, ...readVideoHints(source.metadata) },
            VIDEO_PARSE_LIMITS,
          );
    return finalize(client, source, result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readTitle(metadata: Record<string, unknown> | null): string | undefined {
  const title = metadata?.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

// The spoken language is registered on the source row when it is created, so the worker
// reads it here rather than accepting it in its payload.
//
// A transcript the user already holds is deliberately not carried this way. Source
// metadata is documented as safe metadata only — counts, durations, a title — with the
// body living in segments, which expire. A user with a transcript in hand has a text
// source, not a video one; parsing still accepts subtitleText for a sidecar file, but it
// never arrives by way of a metadata column.
function readVideoHints(metadata: Record<string, unknown> | null): { language?: string } {
  const language = metadata?.language;
  return typeof language === "string" && /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(language)
    ? { language }
    : {};
}

export const parseSourceTask = task({
  id: PARSE_SOURCE_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => {
    const input = parseSourceTaskPayload(payload);
    return executeSourceParse(input.sourceId);
  },
});
