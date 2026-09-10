export type OperationalEvent = Readonly<{
  code: "budget.warning" | "budget.circuit_open" | "retention.completed" | "reconciler.verified" | "reconciler.unhealthy";
  resource?: "provider_cost" | "source" | "export" | "jobs";
  recordId?: string;
  count?: number;
  ratio?: number;
}>;

export interface OperationalLogger { emit(event: OperationalEvent): void | Promise<void>; }

export class BudgetCircuitOpenError extends Error {
  readonly code = "BUDGET_CIRCUIT_OPEN";
  constructor() { super("Provider work is paused because the configured budget is exhausted."); }
}

export async function assertProviderBudget(input: { readonly spent: number; readonly reserved: number; readonly limit: number }, logger: OperationalLogger) {
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    await logger.emit({ code: "budget.circuit_open", resource: "provider_cost", ratio: 1 });
    throw new BudgetCircuitOpenError();
  }
  const ratio = (input.spent + input.reserved) / input.limit;
  if (ratio >= 1) {
    await logger.emit({ code: "budget.circuit_open", resource: "provider_cost", ratio });
    throw new BudgetCircuitOpenError();
  }
  if (ratio >= 0.8) await logger.emit({ code: "budget.warning", resource: "provider_cost", ratio });
  return { ratio, state: ratio >= 0.8 ? "warning" as const : "open" as const };
}

export async function verifyReconciler(input: { readonly run: () => Promise<unknown>; readonly inspect: () => Promise<{ readonly staleJobs: number; readonly unsettledReservations: number }> }, logger: OperationalLogger) {
  await input.run();
  const health = await input.inspect();
  const unhealthy = health.staleJobs + health.unsettledReservations;
  await logger.emit({ code: unhealthy ? "reconciler.unhealthy" : "reconciler.verified", resource: "jobs", count: unhealthy });
  if (unhealthy) throw new Error("RECONCILER_UNHEALTHY");
  return health;
}

export const consoleOperationalLogger: OperationalLogger = {
  emit(event) { console.info(JSON.stringify(event)); },
};
