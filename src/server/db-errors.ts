/**
 * Optimistic-concurrency conflicts raised by the database RPCs.
 *
 * These conditions are deterministic: a revision mismatch or a stale worker lease will
 * fail again no matter how many times the same statement runs. They used to be raised as
 * SQLSTATE 40001 (serialization_failure), which PostgREST classifies as transient and
 * retries — so the request never returned at all. They now raise PT409, PostgREST's
 * "answer with this HTTP status" form. 40001 stays recognised here because a genuine
 * serialization failure surfacing from Postgres itself means the same thing to a caller:
 * re-read and try again, do not treat it as a service outage.
 */
export function isRevisionConflictCode(code: string | undefined): boolean {
  return code === "PT409" || code === "40001";
}
