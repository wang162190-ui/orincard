import { describe, expect, it } from "vitest";
import { readBrowserEnvironment } from "../../src/features/auth/client";
import { readServerEnvironment } from "../../src/server/environment";

const publishableKey = ["sb", "publishable", "test-client-key"].join("_");
const secretKey = ["sb", "secret", "test-server-key"].join("_");

function validServerEnvironment(
  overrides: Record<string, string | undefined> = {},
) {
  return {
    APP_ENV: "development",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "https://development-ref.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
    SUPABASE_PROJECT_REF: "development-ref",
    SUPABASE_PRODUCTION_PROJECT_REF: "production-ref",
    ...overrides,
  };
}

describe("environment validation", () => {
  it("returns a validated server configuration without logging credential values", () => {
    expect(readServerEnvironment(validServerEnvironment())).toEqual({
      appEnvironment: "development",
      appUrl: "http://localhost:3000",
      supabaseUrl: "https://development-ref.supabase.co",
      supabasePublishableKey: publishableKey,
      supabaseSecretKey: secretKey,
      supabaseProjectRef: "development-ref",
    });
  });

  it("allows development before a production project has been created", () => {
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({ SUPABASE_PRODUCTION_PROJECT_REF: undefined }),
      ),
    ).not.toThrow();
  });

  it("requires the production reference in preview and production", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() =>
        readServerEnvironment(
          validServerEnvironment({
            APP_ENV,
            NEXT_PUBLIC_APP_URL: `https://${APP_ENV}.orincard.example`,
            SUPABASE_PRODUCTION_PROJECT_REF: undefined,
          }),
        ),
      ).toThrow("SUPABASE_PRODUCTION_PROJECT_REF");
    }
  });

  it("rejects missing credentials by variable name only", () => {
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({ SUPABASE_SECRET_KEY: undefined }),
      ),
    ).toThrow("SUPABASE_SECRET_KEY");

    try {
      readServerEnvironment(
        validServerEnvironment({ SUPABASE_SECRET_KEY: undefined }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(secretKey);
    }
  });

  it("rejects a preview environment that points at the production project", () => {
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({
          APP_ENV: "preview",
          NEXT_PUBLIC_APP_URL: "https://preview.orincard.example",
          NEXT_PUBLIC_SUPABASE_URL: "https://production-ref.supabase.co",
          SUPABASE_PROJECT_REF: "production-ref",
        }),
      ),
    ).toThrow("cannot use the production Supabase project");
  });

  it("rejects a development environment that points at the production project", () => {
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({
          NEXT_PUBLIC_SUPABASE_URL: "https://production-ref.supabase.co",
          SUPABASE_PROJECT_REF: "production-ref",
        }),
      ),
    ).toThrow("cannot use the production Supabase project");
  });

  it("rejects a project reference that does not match the Supabase URL", () => {
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({ SUPABASE_PROJECT_REF: "another-ref" }),
      ),
    ).toThrow("SUPABASE_PROJECT_REF");
  });

  it("requires a production deployment to use the declared production project", () => {
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({
          APP_ENV: "production",
          NEXT_PUBLIC_APP_URL: "https://orincard.example",
        }),
      ),
    ).toThrow("Production must use the production Supabase project");
  });

  it("rejects server key material from the browser configuration", () => {
    expect(() =>
      readBrowserEnvironment({
        NEXT_PUBLIC_SUPABASE_URL: "https://development-ref.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secretKey,
      }),
    ).toThrow("publishable key");

    expect(() =>
      readServerEnvironment(
        validServerEnvironment({ NEXT_PUBLIC_SUPABASE_SECRET_KEY: secretKey }),
      ),
    ).toThrow("server credential");
  });

  it("rejects key prefixes without key material", () => {
    expect(() =>
      readBrowserEnvironment({
        NEXT_PUBLIC_SUPABASE_URL: "https://development-ref.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ["sb", "publishable", ""].join(
          "_",
        ),
      }),
    ).toThrow("publishable key");
    expect(() =>
      readServerEnvironment(
        validServerEnvironment({
          SUPABASE_SECRET_KEY: ["sb", "secret", ""].join("_"),
        }),
      ),
    ).toThrow("secret key");
  });
});
