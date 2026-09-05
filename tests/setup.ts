import { afterEach } from "vitest";

type TestEnvironment = Readonly<Record<string, string | undefined>>;

afterEach(() => {
  delete process.env.RUN_CLOUD_PROBES;
});

export function missingCloudKeys(
  keys: readonly string[],
  environment: TestEnvironment = process.env,
): string[] {
  return keys.filter((key) => !environment[key]?.trim());
}

export function requireCloudProbe(
  keys: readonly string[],
  environment: TestEnvironment = process.env,
): void {
  if (environment.RUN_CLOUD_PROBES !== "1") {
    throw new Error("Cloud probes are disabled. Set RUN_CLOUD_PROBES=1 only for an isolated development environment.");
  }

  const missing = missingCloudKeys(keys, environment);
  if (missing.length > 0) {
    throw new Error(`Cloud probe is missing required keys: ${missing.join(", ")}`);
  }
}
