import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("T065 tool output database permissions", () => {
  it("tests owner, job, expiry and service-only registration", async () => {
    const tests = await readFile(new URL("../../supabase/tests/tool-outputs.sql", import.meta.url), "utf8");
    expect(tests).toContain("another owner cannot bind the job");
    expect(tests).toContain("another owner cannot read the output");
    expect(tests).toContain("expired output is no longer readable");
    expect(tests).toContain("authenticated cannot call output registration");
    expect(tests).toContain("select * from finish(true)");
  });
});
