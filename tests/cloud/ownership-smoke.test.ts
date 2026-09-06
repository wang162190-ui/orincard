import { afterAll, describe, expect, it } from "vitest";

const cloud = process.env.ORINCARD_RUN_OWNERSHIP_CLOUD === "1" ? describe : describe.skip;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Ownership acceptance is missing required variable: ${name}`);
  }
  return value;
}

cloud("T026 real account ownership isolation", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await cleanup?.();
  });

  it("matches an unknown project when another authenticated account guesses its ID", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const url = required("NEXT_PUBLIC_SUPABASE_URL");
    const publishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const secretKey = required("SUPABASE_SECRET_KEY");
    const ownerEmail = required("ORINCARD_AUTH_TEST_EMAIL");
    const ownerPassword = required("ORINCARD_AUTH_TEST_PASSWORD");
    const otherEmail = required("ORINCARD_AUTH_OTHER_EMAIL");
    const otherPassword = required("ORINCARD_AUTH_OTHER_PASSWORD");
    const owner = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const other = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const admin = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const [ownerLogin, otherLogin] = await Promise.all([
      owner.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword }),
      other.auth.signInWithPassword({ email: otherEmail, password: otherPassword }),
    ]);
    expect(ownerLogin.error).toBeNull();
    expect(otherLogin.error).toBeNull();
    const ownerId = ownerLogin.data.user?.id;
    expect(ownerId).toBeTruthy();

    const runId = crypto.randomUUID();
    const title = `Ownership ${runId}`;
    const document = { schemaVersion: 1, title, platform: "linkedin" };
    const created = await admin.rpc("server_create_project", {
      p_owner_id: ownerId,
      p_title: title,
      p_platform: "linkedin",
      p_document: document,
      p_idempotency_key: `ownership-${runId}`,
      p_request_hash: "a".repeat(64),
    });
    expect(created.error).toBeNull();
    const projectId = (created.data as { projectId?: string } | null)?.projectId;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);

    cleanup = async () => {
      if (projectId) {
        await admin
          .from("projects")
          .update({ state: "deleted", deleted_at: new Date().toISOString() })
          .eq("id", projectId);
      }
      await Promise.all([
        owner.auth.signOut({ scope: "local" }),
        other.auth.signOut({ scope: "local" }),
      ]);
    };

    const ownerRead = await owner.from("projects").select("id").eq("id", projectId);
    const guessed = await other.from("projects").select("id").eq("id", projectId);
    const unknown = await other
      .from("projects")
      .select("id")
      .eq("id", crypto.randomUUID());
    expect(ownerRead).toMatchObject({ error: null, data: [{ id: projectId }] });
    expect(guessed).toMatchObject({ error: null, data: [] });
    expect(unknown).toMatchObject({ error: null, data: [] });

    const forged = await other
      .from("projects")
      .update({ title: "forged" })
      .eq("id", projectId);
    expect(forged.error).not.toBeNull();
  });
});
