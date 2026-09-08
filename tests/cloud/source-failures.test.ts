import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { executeSourceParse } from "../../src/trigger/parse-source";

const sourceId = "81111111-1111-4111-8111-111111111111";
const jobId = "82222222-2222-4222-8222-222222222222";
const leaseToken = "83333333-3333-4333-8333-333333333333";

// These are control-flow unit tests, not evidence of Storage, AI or cloud success.
describe("T044 parse worker budget boundary (unit)", () => {
  it.each(["failed", "skipped"])("does no file work when the atomic claim returns %s", async (state) => {
    const rpc = vi.fn().mockResolvedValue({ data: { sourceId, state }, error: null });
    const from = vi.fn(() => { throw new Error("file access before claim"); });
    const client = { rpc, from } as unknown as SupabaseClient;
    await expect(executeSourceParse(sourceId, client, "development")).resolves.toEqual({ sourceId, state });
    expect(rpc).toHaveBeenCalledWith("server_claim_source_parse", {
      p_source_id: sourceId, p_environment: "development",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("fails closed and sanitizes a failed claim without reading the file", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "private database detail" } });
    const from = vi.fn();
    await expect(executeSourceParse(sourceId, { rpc, from } as unknown as SupabaseClient, "development"))
      .rejects.toThrow("Source parse could not be claimed.");
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects missing environment before calling the database", async () => {
    const rpc = vi.fn();
    await expect(executeSourceParse(sourceId, { rpc } as unknown as SupabaseClient, ""))
      .rejects.toThrow("APP_ENV must be configured for source parsing.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("finalizes download failure with the claimed lease and no extracted content", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: {
        sourceId, state: "claimed", jobId, leaseToken,
        source: { id: sourceId, owner_id: sourceId, kind: "pdf", asset_id: jobId, state: "parsing", metadata: {} },
      }, error: null })
      .mockResolvedValue({ data: { sourceId, state: "failed" }, error: null });
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const client = { rpc, from: vi.fn(() => query) } as unknown as SupabaseClient;
    await expect(executeSourceParse(sourceId, client, "development"))
      .resolves.toEqual({ sourceId, state: "failed" });
    expect(rpc).toHaveBeenLastCalledWith("server_finalize_source_parse_job", expect.objectContaining({
      p_source_id: sourceId, p_job_id: jobId, p_lease_token: leaseToken,
      p_error_code: "SOURCE_UNAVAILABLE", p_segments: [],
    }));
  });

  it("does not retry a failed finalization transaction", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: {
        sourceId, state: "claimed", jobId, leaseToken,
        source: { id: sourceId, owner_id: sourceId, kind: "unsupported", asset_id: null, state: "parsing", metadata: {} },
      }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "transaction failed" } });
    const client = { rpc } as unknown as SupabaseClient;

    await expect(executeSourceParse(sourceId, client, "development"))
      .rejects.toThrow("Source parse could not be finalized.");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
