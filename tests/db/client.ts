import { readServerEnvironment } from "../../src/server/environment";

export function requireDatabaseTestEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.RUN_DB_TESTS !== "1") {
    throw new Error(
      "Database tests are disabled. Set RUN_DB_TESTS=1 only for an isolated development database.",
    );
  }

  const config = readServerEnvironment(environment);
  if (config.appEnvironment !== "development") {
    throw new Error("Database tests require APP_ENV=development");
  }
  return config;
}
