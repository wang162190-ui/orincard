import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseToolOutputDownloadStore, persistToolOutput, ToolOutputError } from "../../src/server/tools/outputs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const OUTPUT = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";

function persistenceClient(rpcError: unknown = null) {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn().mockResolvedValue({ error: rpcError });
  return { client: { storage: { from: vi.fn(() => ({ upload, remove })) }, rpc } as never, upload, remove, rpc };
}

function downloadClient(record: unknown) {
  const calls: [string, unknown][] = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((field: string, value: unknown) => { calls.push([field, value]); return query; }),
    maybeSingle: vi.fn().mockResolvedValue({ data: record, error: null }),
  };
  return { client: { from: vi.fn(() => query) } as never, calls };
}

describe("T065 independent tool outputs", () => {
  it("persists text without creating a project or storage object", async () => {
    const mock = persistenceClient();
    const result = await persistToolOutput(mock.client, { ownerId: OWNER, jobId: JOB, tool: "caption", content: { kind: "text", markdown: "Ready" }, expiresAt: new Date("2099-01-01T00:00:00Z") }, () => OUTPUT);
    expect(result.result).toEqual({ kind: "text", markdown: "Ready" });
    expect(mock.upload).not.toHaveBeenCalled();
    expect(mock.rpc).toHaveBeenCalledWith("server_register_tool_output", expect.objectContaining({ p_id: OUTPUT, p_owner_id: OWNER, p_job_id: JOB, p_context_project_id: null, p_asset_id: null }));
    await expect(persistToolOutput(mock.client, { ownerId: OWNER, jobId: JOB, tool: "portrait", content: { kind: "text", markdown: "wrong" }, expiresAt: new Date("2099-01-01T00:00:00Z") })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("stores image and MP4 bytes under an owner/job/output private key", async () => {
    const image = persistenceClient();
    const ids = [OUTPUT, ASSET];
    const result = await persistToolOutput(image.client, { ownerId: OWNER, jobId: JOB, tool: "quote-card", content: { kind: "image", bytes: new Uint8Array([1, 2, 3]), mime: "image/png", width: 1080, height: 1350 }, expiresAt: new Date("2099-01-01T00:00:00Z") }, () => ids.shift()!);
    expect(result.result).toEqual({ kind: "image", assetId: ASSET, width: 1080, height: 1350 });
    expect(image.upload).toHaveBeenCalledWith(`${OWNER}/${JOB}/${OUTPUT}/result.png`, expect.any(Uint8Array), expect.objectContaining({ contentType: "image/png", upsert: false }));

    const video = persistenceClient();
    const videoIds = [OUTPUT, ASSET];
    const savedVideo = await persistToolOutput(video.client, { ownerId: OWNER, jobId: JOB, tool: "carousel-to-video", content: { kind: "video", bytes: new Uint8Array([4, 5]), mime: "video/mp4", durationSeconds: 12 }, expiresAt: new Date("2099-01-01T00:00:00Z") }, () => videoIds.shift()!);
    expect(savedVideo.result).toEqual({ kind: "video", outputId: OUTPUT, durationSeconds: 12 });
    expect(video.rpc).toHaveBeenCalledWith("server_register_tool_output", expect.objectContaining({ p_mime: "video/mp4", p_duration_ms: 12000 }));
  });

  it("removes an uploaded object when database registration fails", async () => {
    const mock = persistenceClient(new Error("db unavailable"));
    const ids = [OUTPUT, ASSET];
    await expect(persistToolOutput(mock.client, { ownerId: OWNER, jobId: JOB, tool: "infographic", content: { kind: "image", bytes: new Uint8Array([1]), mime: "image/jpeg", width: 100, height: 100 }, expiresAt: new Date("2099-01-01T00:00:00Z") }, () => ids.shift()!)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(mock.remove).toHaveBeenCalledWith([`${OWNER}/${JOB}/${OUTPUT}/result.jpg`]);
  });

  it("authorizes a private object by owner, output and job together", async () => {
    const mock = downloadClient({ id: OUTPUT, state: "ready", expires_at: "2099-01-01T00:00:00Z", asset_id: ASSET, assets: { bucket: "exports", object_key: `${OWNER}/${JOB}/${OUTPUT}/result.mp4`, mime: "video/mp4", purpose: "tool_output", state: "ready" } });
    await expect(createSupabaseToolOutputDownloadStore(mock.client).authorize(OWNER, OUTPUT, JOB, new Date("2026-01-01T00:00:00Z"))).resolves.toMatchObject({ mime: "video/mp4" });
    expect(mock.calls).toEqual(expect.arrayContaining([["id", OUTPUT], ["owner_id", OWNER], ["job_id", JOB]]));
  });

  it("rejects deleted, expired, foreign or text-only outputs", async () => {
    const deleted = downloadClient({ state: "deleted", expires_at: "2099-01-01T00:00:00Z" });
    await expect(createSupabaseToolOutputDownloadStore(deleted.client).authorize(OWNER, OUTPUT, JOB, new Date())).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const expired = downloadClient({ state: "ready", expires_at: "2020-01-01T00:00:00Z" });
    await expect(createSupabaseToolOutputDownloadStore(expired.client).authorize(OWNER, OUTPUT, JOB, new Date())).rejects.toMatchObject({ code: "OUTPUT_EXPIRED", status: 410 });
    const foreign = downloadClient(null);
    await expect(createSupabaseToolOutputDownloadStore(foreign.client).authorize(OWNER, OUTPUT, JOB, new Date())).rejects.toBeInstanceOf(ToolOutputError);
    const text = downloadClient({ state: "ready", expires_at: "2099-01-01T00:00:00Z", asset_id: null });
    await expect(createSupabaseToolOutputDownloadStore(text.client).authorize(OWNER, OUTPUT, JOB, new Date())).rejects.toMatchObject({ code: "NOT_READY", status: 409 });
  });

  it("comments the model and keeps registration service-only", async () => {
    const sql = await readFile(new URL("../../supabase/definitions/tool-outputs.sql", import.meta.url), "utf8");
    expect(sql.match(/comment on column public\.tool_outputs\./g)).toHaveLength(11);
    expect(sql).toContain("comment on table public.tool_outputs");
    expect(sql).toMatch(/server_register_tool_output[\s\S]+tool job is not accessible[\s\S]+tool context is not accessible/);
    expect(sql).toMatch(/revoke execute on function public\.server_register_tool_output[\s\S]+grant execute[\s\S]+to service_role/);
    expect(sql).toContain("storage_download_owned_tool_outputs");
  });
});
