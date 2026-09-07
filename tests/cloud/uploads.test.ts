import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AssetUploadError,
  UPLOAD_MAX_BYTES,
  createSupabaseUploadIntentStore,
  createUploadIntentService,
  inspectUploadedObject,
  type UploadIntentRecord,
  type UploadIntentStore,
} from "../../src/server/assets/upload";
import { executeAssetValidation } from "../../src/trigger/validate-asset";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_HASH_SECRET = "test-upload-request-hash-secret";
const OPERATION_KEY = "upload-operation-1";

// Real magic bytes: the whole point of T038 is that validation reads the object instead
// of trusting the declared media type, so the fixtures have to be recognisable files.
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n", "utf8");
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDRorincard-fixture", "utf8"),
]);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function intentBody(overrides: Record<string, unknown> = {}) {
  return {
    originalName: "quarterly deck.pdf",
    declaredMime: "application/pdf",
    size: PDF_BYTES.byteLength,
    sha256: digest(PDF_BYTES),
    purpose: "source",
    rightsConfirmation: true,
    ...overrides,
  };
}

function record(overrides: Partial<UploadIntentRecord> = {}): UploadIntentRecord {
  return {
    assetId: ASSET_ID,
    bucket: "sources",
    objectKey: `${OWNER_ID}/${OBJECT_ID}/quarterly-deck.pdf`,
    state: "pending_upload",
    ...overrides,
  };
}

function store(overrides: Partial<UploadIntentStore> = {}): UploadIntentStore {
  return {
    create: vi.fn().mockResolvedValue(record()),
    signUpload: vi.fn().mockResolvedValue({
      url: "https://storage.orincard.test/object/upload/sign/sources/key",
      token: "signed-upload-token",
    }),
    ...overrides,
  };
}

function service(overrides: Partial<UploadIntentStore> = {}) {
  return createUploadIntentService({
    store: store(overrides),
    requestHashSecret: REQUEST_HASH_SECRET,
    createId: () => OBJECT_ID,
  });
}

describe("T038 upload intent service", () => {
  it("registers a declared upload under the owner prefix and returns an upload authorization", async () => {
    const create = vi.fn().mockResolvedValue(record());
    const signUpload = vi.fn().mockResolvedValue({
      url: "https://storage.orincard.test/object/upload/sign/sources/key",
      token: "signed-upload-token",
    });

    const intent = await service({ create, signUpload }).create(
      OWNER_ID,
      intentBody(),
      OPERATION_KEY,
    );

    expect(create).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      kind: "upload",
      purpose: "source",
      bucket: "sources",
      objectKey: `${OWNER_ID}/${OBJECT_ID}/quarterly-deck.pdf`,
      mime: "application/pdf",
      bytes: PDF_BYTES.byteLength,
      sha256: digest(PDF_BYTES),
      idempotencyKey: OPERATION_KEY,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(signUpload).toHaveBeenCalledWith("sources", record().objectKey);
    expect(intent).toMatchObject({
      assetId: ASSET_ID,
      state: "pending_upload",
      upload: { url: expect.stringContaining("https://"), token: "signed-upload-token" },
    });
  });

  it("keeps the object key inside the owner prefix even for a hostile file name", async () => {
    const create = vi.fn().mockResolvedValue(record());

    await service({ create }).create(
      OWNER_ID,
      intentBody({ originalName: "../../../etc/passwd\u0000 .pdf" }),
      OPERATION_KEY,
    );

    const written = create.mock.calls[0][0] as { readonly objectKey: string };
    expect(written.objectKey.startsWith(`${OWNER_ID}/`)).toBe(true);
    expect(written.objectKey).not.toContain("..");
    expect(written.objectKey).not.toContain(" ");
    expect(written.objectKey).not.toContain("\u0000");
  });

  it("rejects an oversized, unsupported or unconfirmed upload before any row is written", async () => {
    const create = vi.fn();
    const rejected = service({ create });

    await expect(
      rejected.create(OWNER_ID, intentBody({ size: UPLOAD_MAX_BYTES + 1 }), OPERATION_KEY),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    await expect(
      rejected.create(
        OWNER_ID,
        intentBody({ declaredMime: "application/x-msdownload" }),
        OPERATION_KEY,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", status: 415 });
    await expect(
      rejected.create(
        OWNER_ID,
        intentBody({ purpose: "media", declaredMime: "application/pdf" }),
        OPERATION_KEY,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", status: 415 });
    await expect(
      rejected.create(OWNER_ID, intentBody({ rightsConfirmation: false }), OPERATION_KEY),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(
      rejected.create(OWNER_ID, intentBody({ sha256: "not-a-digest" }), OPERATION_KEY),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(
      rejected.create(OWNER_ID, intentBody(), "short"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(
      rejected.create("", intentBody(), OPERATION_KEY),
    ).rejects.toEqual(
      new AssetUploadError("AUTH_REQUIRED", "Sign in before uploading a file.", 401),
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("maps the receipt conflict and expiry error codes of the upload intent RPC", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "23505" } })
      .mockResolvedValueOnce({ data: null, error: { code: "55000" } });
    const storage = { from: () => ({ createSignedUploadUrl: vi.fn() }) };
    const supabaseStore = createSupabaseUploadIntentStore({ rpc, storage } as never);
    const write = {
      ownerId: OWNER_ID,
      kind: "upload" as const,
      purpose: "source" as const,
      bucket: "sources" as const,
      objectKey: `${OWNER_ID}/${OBJECT_ID}/deck.pdf`,
      mime: "application/pdf",
      bytes: 4096,
      sha256: "a".repeat(64),
      idempotencyKey: OPERATION_KEY,
      requestHash: "1".repeat(64),
    };

    await expect(supabaseStore.create(write)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    await expect(supabaseStore.create(write)).rejects.toMatchObject({
      code: "OPERATION_EXPIRED",
      status: 410,
    });
  });

  it("registers the intent through the atomic RPC instead of an asset insert", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        assetId: ASSET_ID,
        bucket: "sources",
        objectKey: `${OWNER_ID}/${OBJECT_ID}/deck.pdf`,
        state: "pending_upload",
        httpStatus: 201,
      },
      error: null,
    });
    const createSignedUploadUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.orincard.test/sign", token: "token" },
      error: null,
    });
    const supabaseStore = createSupabaseUploadIntentStore({
      rpc,
      storage: { from: () => ({ createSignedUploadUrl }) },
    } as never);

    const created = await supabaseStore.create({
      ownerId: OWNER_ID,
      kind: "upload",
      purpose: "source",
      bucket: "sources",
      objectKey: `${OWNER_ID}/${OBJECT_ID}/deck.pdf`,
      mime: "application/pdf",
      bytes: 4096,
      sha256: "a".repeat(64),
      idempotencyKey: OPERATION_KEY,
      requestHash: "1".repeat(64),
    });

    expect(rpc).toHaveBeenCalledWith("server_create_upload_intent", {
      p_owner_id: OWNER_ID,
      p_kind: "upload",
      p_purpose: "source",
      p_bucket: "sources",
      p_object_key: `${OWNER_ID}/${OBJECT_ID}/deck.pdf`,
      p_mime: "application/pdf",
      p_bytes: 4096,
      p_sha256: "a".repeat(64),
      p_idempotency_key: OPERATION_KEY,
      p_request_hash: "1".repeat(64),
    });
    expect(created).toEqual(record({ objectKey: `${OWNER_ID}/${OBJECT_ID}/deck.pdf` }));
  });
});

describe("T038 uploaded object inspection", () => {
  const declared = {
    purpose: "source" as const,
    mime: "application/pdf",
    bytes: PDF_BYTES.byteLength,
    sha256: digest(PDF_BYTES),
  };

  it("accepts an object whose real bytes, digest and sniffed type match the declaration", () => {
    expect(inspectUploadedObject(declared, PDF_BYTES)).toEqual({
      ok: true,
      mime: "application/pdf",
      bytes: PDF_BYTES.byteLength,
      sha256: digest(PDF_BYTES),
    });
  });

  it("refuses a file that only claims to be the declared type", () => {
    expect(
      inspectUploadedObject(
        {
          purpose: "media",
          mime: "image/jpeg",
          bytes: PNG_BYTES.byteLength,
          sha256: digest(PNG_BYTES),
        },
        PNG_BYTES,
      ),
    ).toEqual({ ok: false, code: "MIME_MISMATCH" });
  });

  it("refuses swapped content, a wrong size and an empty object", () => {
    const swapped = Buffer.concat([PDF_BYTES, Buffer.from("appended", "utf8")]);
    expect(
      inspectUploadedObject({ ...declared, bytes: swapped.byteLength }, swapped),
    ).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
    expect(inspectUploadedObject(declared, swapped)).toEqual({
      ok: false,
      code: "SIZE_MISMATCH",
    });
    expect(inspectUploadedObject(declared, Buffer.alloc(0))).toEqual({
      ok: false,
      code: "FILE_MISSING",
    });
  });

  it("refuses a media upload that is not one of the allowed image types", () => {
    expect(
      inspectUploadedObject(
        {
          purpose: "media",
          mime: "image/png",
          bytes: PDF_BYTES.byteLength,
          sha256: digest(PDF_BYTES),
        },
        PDF_BYTES,
      ),
    ).toEqual({ ok: false, code: "UNSUPPORTED_FORMAT" });
    expect(
      inspectUploadedObject(
        {
          purpose: "media",
          mime: "image/png",
          bytes: PNG_BYTES.byteLength,
          sha256: digest(PNG_BYTES),
        },
        PNG_BYTES,
      ),
    ).toMatchObject({ ok: true, mime: "image/png" });
  });

  it("reports every failure with a safe database error class", () => {
    const outcome = inspectUploadedObject(declared, Buffer.from("plain text", "utf8"));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toMatch(/^[A-Z_]{3,40}$/);
  });
});

function validationClient(options: {
  readonly claimed?: readonly Record<string, unknown>[];
  readonly object?: Buffer | null;
}) {
  const rpc = vi.fn(async (name: string, _parameters: Record<string, unknown>) => {
    if (name === "server_claim_asset_validation") {
      return { data: options.claimed ?? [], error: null };
    }
    return { data: { id: ASSET_ID, state: "ready" }, error: null };
  });
  const download = vi.fn(async () =>
    options.object
      ? { data: new Blob([new Uint8Array(options.object)]), error: null }
      : { data: null, error: { message: "not found" } },
  );
  return {
    rpc,
    download,
    client: { rpc, storage: { from: () => ({ download }) } } as unknown as SupabaseClient,
  };
}

function claimedAsset(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    owner_id: OWNER_ID,
    purpose: "source",
    bucket: "sources",
    object_key: `${OWNER_ID}/${OBJECT_ID}/deck.pdf`,
    mime: "application/pdf",
    bytes: bytes.byteLength,
    sha256: digest(bytes),
    state: "validating",
    ...overrides,
  };
}

describe("T038 asset validation task", () => {
  it("promotes an upload that matches its declaration to ready", async () => {
    const { rpc, client } = validationClient({
      claimed: [claimedAsset(PDF_BYTES)],
      object: PDF_BYTES,
    });

    await expect(executeAssetValidation(ASSET_ID, client)).resolves.toEqual({
      assetId: ASSET_ID,
      state: "ready",
    });
    expect(rpc).toHaveBeenLastCalledWith("server_finalize_asset_validation", {
      p_asset_id: ASSET_ID,
      p_ok: true,
      p_mime: "application/pdf",
      p_bytes: PDF_BYTES.byteLength,
      p_sha256: digest(PDF_BYTES),
      p_width: null,
      p_height: null,
      p_duration_ms: null,
      p_error_code: null,
    });
  });

  it("fails an upload whose stored bytes are not what the client declared", async () => {
    const { rpc, client } = validationClient({
      claimed: [claimedAsset(PDF_BYTES)],
      object: PNG_BYTES,
    });

    await expect(executeAssetValidation(ASSET_ID, client)).resolves.toEqual({
      assetId: ASSET_ID,
      state: "failed",
    });
    expect(rpc).toHaveBeenLastCalledWith("server_finalize_asset_validation", {
      p_asset_id: ASSET_ID,
      p_ok: false,
      p_mime: null,
      p_bytes: null,
      p_sha256: null,
      p_width: null,
      p_height: null,
      p_duration_ms: null,
      p_error_code: "SIZE_MISMATCH",
    });
  });

  it("fails an intent whose object never arrived instead of leaving it validating", async () => {
    const { rpc, client } = validationClient({
      claimed: [claimedAsset(PDF_BYTES)],
      object: null,
    });

    await expect(executeAssetValidation(ASSET_ID, client)).resolves.toEqual({
      assetId: ASSET_ID,
      state: "failed",
    });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_error_code: "FILE_MISSING" });
  });

  it("does nothing when the claim finds no pending upload to work on", async () => {
    const { rpc, download, client } = validationClient({ claimed: [], object: PDF_BYTES });

    await expect(executeAssetValidation(ASSET_ID, client)).resolves.toEqual({
      assetId: ASSET_ID,
      state: "skipped",
    });
    expect(download).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

const route = vi.hoisted(() => {
  const state = {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
    intent: vi.fn(),
    dispatched: vi.fn(),
    asset: null as Record<string, unknown> | null,
  };
  return { state };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: vi.fn().mockReturnValue([]),
    set: vi.fn(),
  }),
}));

vi.mock("@/server/environment", () => ({
  readServerEnvironment: () => ({
    appUrl: "https://orincard.test",
    supabaseSecretKey: REQUEST_HASH_SECRET,
  }),
}));

vi.mock("@/server/supabase", () => ({
  createAdminSupabaseClient: () => ({
    rpc: async (_name: string, value: unknown) => {
      route.state.intent(value);
      return {
        data: {
          assetId: ASSET_ID,
          bucket: "sources",
          objectKey: `${OWNER_ID}/${OBJECT_ID}/deck.pdf`,
          state: "pending_upload",
          httpStatus: 201,
        },
        error: null,
      };
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({
          data: { signedUrl: "https://storage.orincard.test/sign", token: "token" },
          error: null,
        }),
      }),
    },
  }),
  createServerSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: route.state.asset, error: null }) }),
      }),
    }),
  }),
  requireVerifiedUser: async () => {
    if (!route.state.userId) {
      throw new Error("Authentication required");
    }
    return { id: route.state.userId };
  },
}));

vi.mock("@/server/assets/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetValidationDispatcher: {
    trigger: async (payload: unknown, key: string) => {
      route.state.dispatched({ payload, key });
      return { id: "run_validate_asset" };
    },
  },
}));

function intentRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://orincard.test/api/v1/assets/upload-intent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://orincard.test",
      "idempotency-key": OPERATION_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("T038 POST /api/v1/assets/upload-intent", () => {
  afterAll(() => {
    route.state.userId = OWNER_ID;
  });

  it("returns an asset id and a storage upload authorization instead of accepting bytes", async () => {
    route.state.userId = OWNER_ID;
    route.state.intent.mockClear();
    const { POST } = await import("../../src/app/api/v1/assets/upload-intent/route");

    const response = await POST(intentRequest(intentBody()));
    const payload = (await response.json()) as {
      readonly data: {
        readonly assetId: string;
        readonly bucket: string;
        readonly objectKey: string;
        readonly upload: { readonly url: string; readonly token: string };
      };
      readonly requestId: string;
    };

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload.data.assetId).toBe(ASSET_ID);
    // The bytes go straight to Storage with this authorization, so no route on the
    // serverless platform ever has to carry a 50 MiB request body.
    expect(payload.data.upload.url).toContain("https://");
    expect(payload.data.upload.token).toBe("token");
    expect(payload.data.objectKey.startsWith(`${OWNER_ID}/`)).toBe(true);
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(route.state.intent).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-origin, anonymous or unkeyed intent without registering an asset", async () => {
    const { POST } = await import("../../src/app/api/v1/assets/upload-intent/route");

    route.state.userId = OWNER_ID;
    route.state.intent.mockClear();
    const foreign = await POST(
      intentRequest(intentBody(), { origin: "https://evil.test" }),
    );
    expect(foreign.status).toBe(400);

    const unkeyed = await POST(
      new Request("https://orincard.test/api/v1/assets/upload-intent", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://orincard.test" },
        body: JSON.stringify(intentBody()),
      }),
    );
    expect(unkeyed.status).toBe(400);

    route.state.userId = null;
    const anonymous = await POST(intentRequest(intentBody()));
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED", retryable: false },
    });

    expect(route.state.intent).not.toHaveBeenCalled();
  });

  it("returns FILE_TOO_LARGE for an oversized declaration without registering an asset", async () => {
    route.state.userId = OWNER_ID;
    route.state.intent.mockClear();
    const { POST } = await import("../../src/app/api/v1/assets/upload-intent/route");

    const response = await POST(
      intentRequest(intentBody({ size: UPLOAD_MAX_BYTES + 1 })),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FILE_TOO_LARGE", retryable: false },
    });
    expect(route.state.intent).not.toHaveBeenCalled();
  });
});

function completeRequest(assetId: string): {
  readonly request: Request;
  readonly context: { readonly params: Promise<{ readonly id: string }> };
} {
  return {
    request: new Request(
      `https://orincard.test/api/v1/assets/${assetId}/complete`,
      {
        method: "POST",
        headers: { origin: "https://orincard.test" },
      },
    ),
    context: { params: Promise.resolve({ id: assetId }) },
  };
}

describe("T038 POST /api/v1/assets/[id]/complete", () => {
  afterAll(() => {
    route.state.userId = OWNER_ID;
    route.state.asset = null;
  });

  it("starts validation for the owner and carries only identifiers in the task payload", async () => {
    route.state.userId = OWNER_ID;
    route.state.asset = { id: ASSET_ID, owner_id: OWNER_ID, state: "pending_upload" };
    route.state.dispatched.mockClear();
    const { POST } = await import("../../src/app/api/v1/assets/[id]/complete/route");

    const { request, context } = completeRequest(ASSET_ID);
    const response = await POST(request, context);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: { assetId: ASSET_ID, state: "validating" },
    });
    expect(route.state.dispatched).toHaveBeenCalledTimes(1);
    const [dispatch] = route.state.dispatched.mock.calls[0] as [
      { readonly payload: Record<string, unknown>; readonly key: string },
    ];
    expect(Object.keys(dispatch.payload).sort()).toEqual([
      "assetId",
      "requestId",
      "schemaVersion",
    ]);
  });

  it("returns NOT_FOUND and dispatches nothing for an asset the caller does not own", async () => {
    route.state.userId = OTHER_OWNER_ID;
    route.state.asset = null;
    route.state.dispatched.mockClear();
    const { POST } = await import("../../src/app/api/v1/assets/[id]/complete/route");

    const { request, context } = completeRequest(ASSET_ID);
    const response = await POST(request, context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", retryable: false },
    });
    expect(route.state.dispatched).not.toHaveBeenCalled();
  });

  it("reports a decided asset without starting a second validation", async () => {
    route.state.userId = OWNER_ID;
    route.state.asset = { id: ASSET_ID, owner_id: OWNER_ID, state: "ready" };
    route.state.dispatched.mockClear();
    const { POST } = await import("../../src/app/api/v1/assets/[id]/complete/route");

    const { request, context } = completeRequest(ASSET_ID);
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { assetId: ASSET_ID, state: "ready" },
    });
    expect(route.state.dispatched).not.toHaveBeenCalled();
  });
});

const cloud = process.env.ORINCARD_RUN_UPLOADS_CLOUD === "1" ? describe : describe.skip;

cloud("T038 real development Supabase direct upload", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await cleanup?.();
  });

  it("validates a real direct upload and refuses to promote a tampered one", async () => {
    const required = (name: string) => {
      const value = process.env[name]?.trim();
      if (!value) {
        throw new Error(
          `ORINCARD_RUN_UPLOADS_CLOUD=1 requires development variable ${name}`,
        );
      }
      return value;
    };
    const { createClient } = await import("@supabase/supabase-js");
    const url = required("NEXT_PUBLIC_SUPABASE_URL");
    const publishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const secretKey = required("SUPABASE_SECRET_KEY");
    const email = required("ORINCARD_AUTH_TEST_EMAIL");
    const password = required("ORINCARD_AUTH_TEST_PASSWORD");
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

    const bytes = Buffer.concat([PDF_BYTES, Buffer.from(crypto.randomUUID(), "utf8")]);
    const uploadService = createUploadIntentService({
      store: createSupabaseUploadIntentStore(adminClient),
      requestHashSecret: secretKey,
    });
    const intent = await uploadService.create(
      ownerId!,
      {
        originalName: "cloud-upload.pdf",
        declaredMime: "application/pdf",
        size: bytes.byteLength,
        sha256: digest(bytes),
        purpose: "source",
        rightsConfirmation: true,
      },
      `cloud-upload-${crypto.randomUUID()}`,
    );
    cleanup = async () => {
      await adminClient.storage.from(intent.bucket).remove([intent.objectKey]);
      await adminClient.from("assets").delete().eq("id", intent.assetId);
      await userClient.auth.signOut({ scope: "local" });
    };

    // A pending upload must not be usable anywhere yet: the file source RPC is the first
    // consumer that would put it in front of the generation and export pipeline.
    const premature = await adminClient.rpc("server_create_file_source", {
      p_owner_id: ownerId,
      p_kind: "pdf",
      p_asset_id: intent.assetId,
      p_metadata: {},
      p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      p_idempotency_key: `cloud-premature-${crypto.randomUUID()}`,
      p_request_hash: "0".repeat(64),
    });
    expect(premature.error).not.toBeNull();

    const uploaded = await userClient.storage
      .from(intent.bucket)
      .uploadToSignedUrl(intent.objectKey, intent.upload.token, bytes, {
        contentType: "application/pdf",
      });
    expect(uploaded.error).toBeNull();

    await expect(
      executeAssetValidation(intent.assetId, adminClient),
    ).resolves.toEqual({ assetId: intent.assetId, state: "ready" });

    const read = await userClient
      .from("assets")
      .select("id,owner_id,state,mime,bytes,sha256,error_code")
      .eq("id", intent.assetId)
      .single();
    expect(read.error).toBeNull();
    expect(read.data).toMatchObject({
      owner_id: ownerId,
      state: "ready",
      mime: "application/pdf",
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      error_code: null,
    });
  }, 120_000);
});
