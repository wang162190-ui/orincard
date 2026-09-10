import { describe, expect, it, vi } from "vitest";
import { assertProviderBudget, BudgetCircuitOpenError, verifyReconciler, type OperationalEvent } from "../../src/server/observability";
import { runRetentionMaintenance, type RetentionStore } from "../../src/trigger/retention";

function logger(events: OperationalEvent[]) { return { emit: vi.fn(async (event: OperationalEvent) => { events.push(event); }) }; }

describe("provider budget observability", () => {
  it("warns at 80 percent without opening the circuit", async () => {
    const events: OperationalEvent[] = [];
    await expect(assertProviderBudget({ spent: 75, reserved: 5, limit: 100 }, logger(events))).resolves.toMatchObject({ state: "warning", ratio: 0.8 });
    expect(events).toEqual([{ code: "budget.warning", resource: "provider_cost", ratio: 0.8 }]);
  });

  it("fails closed at 100 percent", async () => {
    const events: OperationalEvent[] = [];
    await expect(assertProviderBudget({ spent: 90, reserved: 10, limit: 100 }, logger(events))).rejects.toBeInstanceOf(BudgetCircuitOpenError);
    expect(events[0]?.code).toBe("budget.circuit_open");
  });
});

it("removes expired source and export objects and re-verifies the reconciler", async () => {
  const events: OperationalEvent[] = [];
  const expire = vi.fn(async () => undefined); const removeObject = vi.fn(async () => undefined); const reconcile = vi.fn(async () => ({ checked: 2 }));
  const store: RetentionStore = {
    listExpired: vi.fn(async (kind) => [{ id: `${kind}-1`, kind, assetId: `${kind}-asset`, bucket: kind === "source" ? "uploads" : "exports", objectKey: `owner/${kind}-1/file` }]),
    expire, removeObject,
    reconciliationHealth: vi.fn(async () => ({ staleJobs: 0, unsettledReservations: 0 })),
  };
  const result = await runRetentionMaintenance({ store, reconcile, logger: logger(events), now: () => new Date("2026-09-10T00:00:00Z") });
  expect(result.removed).toEqual({ source: 1, export: 1 });
  expect(removeObject).toHaveBeenCalledTimes(2); expect(expire).toHaveBeenCalledTimes(2); expect(reconcile).toHaveBeenCalledOnce();
  expect(events.at(-1)).toEqual({ code: "reconciler.verified", resource: "jobs", count: 0 });
  expect(JSON.stringify(events)).not.toMatch(/body|prompt|transcript|content/i);
});

it("fails a reconciler verification while logging counts only", async () => {
  const events: OperationalEvent[] = [];
  await expect(verifyReconciler({ run: async () => undefined, inspect: async () => ({ staleJobs: 1, unsettledReservations: 2 }) }, logger(events))).rejects.toThrow("RECONCILER_UNHEALTHY");
  expect(events).toEqual([{ code: "reconciler.unhealthy", resource: "jobs", count: 3 }]);
});
