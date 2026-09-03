import { describe, expect, it } from "vitest";
import { missingCloudKeys, requireCloudProbe } from "./setup";

describe("test safety harness", () => {
  it("reports only missing key names", () => {
    expect(missingCloudKeys(["A", "B"], { A: "present" })).toEqual(["B"]);
  });

  it("rejects cloud execution unless explicitly enabled", () => {
    expect(() =>
      requireCloudProbe(["TRIGGER_SECRET_KEY"], {
        TRIGGER_SECRET_KEY: "not-logged",
      }),
    ).toThrow("Cloud probes are disabled");
  });

  it("rejects a missing credential without printing a value", () => {
    expect(() =>
      requireCloudProbe(["TRIGGER_SECRET_KEY"], {
        RUN_CLOUD_PROBES: "1",
      }),
    ).toThrow("TRIGGER_SECRET_KEY");
  });
});
