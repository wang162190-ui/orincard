import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  return result;
}

function sameSecret(left, right) {
  const a = Buffer.from(left ?? ""); const b = Buffer.from(right ?? "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function reviewAffiliateApplication({ argv, environment, fetchImpl = fetch }) {
  const args = parseArgs(argv);
  const target = args.environment;
  if (!target || target !== environment.APP_ENV || args.confirm !== `REVIEW:${target}`) throw new Error("Environment confirmation does not match APP_ENV.");
  if (!sameSecret(args.authorization, environment.AFFILIATE_REVIEW_TOKEN)) throw new Error("Affiliate review authorization failed.");
  if (!args.application || !["approved", "rejected"].includes(args.decision)) throw new Error("Application and approved/rejected decision are required.");
  if (!environment.NEXT_PUBLIC_SUPABASE_URL || !environment.SUPABASE_SECRET_KEY || !environment.AFFILIATE_REVIEW_ACTOR) throw new Error("Review backend and audit actor must be configured.");
  const response = await fetchImpl(`${environment.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/review_affiliate_application`, {
    method: "POST",
    headers: { apikey: environment.SUPABASE_SECRET_KEY, authorization: `Bearer ${environment.SUPABASE_SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ p_application_id: args.application, p_decision: args.decision, p_reason: args.reason ?? null, p_actor: environment.AFFILIATE_REVIEW_ACTOR, p_environment: target }),
  });
  if (!response.ok) throw new Error(`Affiliate review failed (${response.status}).`);
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reviewAffiliateApplication({ argv: process.argv.slice(2), environment: process.env }).then((result) => console.log(`Review recorded: ${result.id ?? "ok"}`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
