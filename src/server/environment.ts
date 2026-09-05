export type AppEnvironment = "development" | "preview" | "production";

type Environment = Readonly<Record<string, string | undefined>>;

export interface BrowserEnvironment {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
}

export interface ServerEnvironment extends BrowserEnvironment {
  readonly appEnvironment: AppEnvironment;
  readonly appUrl: string;
  readonly supabaseSecretKey: string;
  readonly supabaseProjectRef: string;
}

export class EnvironmentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentConfigurationError";
  }
}

function requireVariable(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new EnvironmentConfigurationError(
      `Missing required environment variable: ${name}`,
    );
  }
  return value;
}

function readUrl(value: string, name: string, allowLocalHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentConfigurationError(`${name} must be a valid URL`);
  }

  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(allowLocalHttp && localHost)) {
    throw new EnvironmentConfigurationError(
      `${name} must use HTTPS outside local development`,
    );
  }
  return url;
}

function readAppEnvironment(value: string): AppEnvironment {
  if (value !== "development" && value !== "preview" && value !== "production") {
    throw new EnvironmentConfigurationError(
      "APP_ENV must be development, preview, or production",
    );
  }
  return value;
}

function assertPublishableKey(value: string): void {
  if (!value.startsWith("sb_publishable_") || value.length <= "sb_publishable_".length) {
    throw new EnvironmentConfigurationError(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key",
    );
  }
}

function assertSecretKey(value: string): void {
  if (!value.startsWith("sb_secret_") || value.length <= "sb_secret_".length) {
    throw new EnvironmentConfigurationError(
      "SUPABASE_SECRET_KEY must be a server-only Supabase secret key",
    );
  }
}

export function readBrowserEnvironment(environment: Environment): BrowserEnvironment {
  const leakedServerVariable = Object.keys(environment).find(
    (name) =>
      name.startsWith("NEXT_PUBLIC_") &&
      (name.includes("SECRET") || name.includes("SERVICE_ROLE")) &&
      environment[name]?.trim(),
  );
  if (leakedServerVariable) {
    throw new EnvironmentConfigurationError(
      `Browser environment contains a server credential variable: ${leakedServerVariable}`,
    );
  }

  const supabaseUrl = requireVariable(environment, "NEXT_PUBLIC_SUPABASE_URL");
  const supabasePublishableKey = requireVariable(
    environment,
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  );
  readUrl(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL", true);
  assertPublishableKey(supabasePublishableKey);

  return { supabaseUrl, supabasePublishableKey };
}

export function readServerEnvironment(environment: Environment): ServerEnvironment {
  const appEnvironment = readAppEnvironment(
    requireVariable(environment, "APP_ENV"),
  );
  const browser = readBrowserEnvironment(environment);
  const appUrl = requireVariable(environment, "NEXT_PUBLIC_APP_URL");
  const supabaseSecretKey = requireVariable(environment, "SUPABASE_SECRET_KEY");
  const supabaseProjectRef = requireVariable(environment, "SUPABASE_PROJECT_REF");
  const productionProjectRef = requireVariable(
    environment,
    "SUPABASE_PRODUCTION_PROJECT_REF",
  );

  readUrl(appUrl, "NEXT_PUBLIC_APP_URL", appEnvironment === "development");
  const supabaseUrl = readUrl(
    browser.supabaseUrl,
    "NEXT_PUBLIC_SUPABASE_URL",
    appEnvironment === "development",
  );
  assertSecretKey(supabaseSecretKey);

  const urlProjectRef = supabaseUrl.hostname.endsWith(".supabase.co")
    ? supabaseUrl.hostname.slice(0, -".supabase.co".length)
    : null;
  if (urlProjectRef && urlProjectRef !== supabaseProjectRef) {
    throw new EnvironmentConfigurationError(
      "SUPABASE_PROJECT_REF must match NEXT_PUBLIC_SUPABASE_URL",
    );
  }
  if (appEnvironment !== "production" && supabaseProjectRef === productionProjectRef) {
    throw new EnvironmentConfigurationError(
      "Development and Preview cannot use the production Supabase project",
    );
  }
  if (appEnvironment === "production" && supabaseProjectRef !== productionProjectRef) {
    throw new EnvironmentConfigurationError(
      "Production must use the production Supabase project",
    );
  }

  return {
    appEnvironment,
    appUrl,
    ...browser,
    supabaseSecretKey,
    supabaseProjectRef,
  };
}
