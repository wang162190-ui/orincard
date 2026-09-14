import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const API_ROOT = `${ROOT}src/app/api/v1`;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `[id]`, `:id` and `:jobId` all denote the same contract path segment. */
function normalize(path: string): string {
  return path.replace(/\[[^\]]+\]|:[A-Za-z][A-Za-z0-9_]*/g, "[param]");
}

/** Every `route.ts` under src/app/api/v1, with the HTTP verbs it actually exports. */
function implemented(): Map<string, ReadonlySet<string>> {
  const routes = new Map<string, ReadonlySet<string>>();
  for (const entry of readdirSync(API_ROOT, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith("route.ts")) continue;
    const source = readFileSync(`${API_ROOT}/${entry}`, "utf8");
    const methods = new Set(
      HTTP_METHODS.filter((method) => new RegExp(`^export (?:async )?function ${method}\\b`, "m").test(source)),
    );
    routes.set(normalize(`/${entry.replace(/\/?route\.ts$/, "")}`), methods);
  }
  return routes;
}

/**
 * Every `METHOD /path` (or `GET/POST /path`) declared in the API contract. The contract mixes
 * three layouts — two table shapes and a bullet list — so this reads verbs and paths rather
 * than columns.
 */
function declared(): Map<string, ReadonlySet<string>> {
  const contract = readFileSync(`${ROOT}docs/sdd/orincard/contracts/api.md`, "utf8");
  const routes = new Map<string, Set<string>>();
  for (const match of contract.matchAll(/\b((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*)\s+(\/[A-Za-z0-9_/:.-]+)/g)) {
    const path = normalize(match[2]);
    const existing = routes.get(path) ?? new Set<string>();
    for (const method of match[1].split("/")) existing.add(method);
    routes.set(path, existing);
  }
  return routes;
}

function flatten(routes: Map<string, ReadonlySet<string>>): readonly string[] {
  return [...routes].flatMap(([path, methods]) => [...methods].map((method) => `${method} ${path}`)).sort();
}

describe("T095 API contract coverage", () => {
  it("declares and implements the same 48 paths", () => {
    const code = implemented();
    const contract = declared();
    expect(code.size).toBe(48);
    expect([...contract.keys()].sort()).toEqual([...code.keys()].sort());
  });

  // 逐方法逐路径：路径对上不代表方法对上。修复前 contracts/api.md 声明了 PUT /brand-kits/:id
  // 而路由从未导出过它（Brand Kit 建完就再也改不了），同时 GET /settings、GET /tools/:tool、
  // GET /brand-kits/:id 三个真实入口从未出现在契约里。只比路径的检查两种情况都看不见。
  it("declares and implements the same method on every path", () => {
    expect(flatten(declared())).toEqual(flatten(implemented()));
  });

  it("exports at least one HTTP method from every route file", () => {
    const empty = [...implemented()].filter(([, methods]) => methods.size === 0).map(([path]) => path);
    expect(empty).toEqual([]);
  });

  // check-planning.mjs 只从契约走到任务清单，从不从文件系统走回去，因此一个既没有契约条目、
  // 也没有任务认领的路由可以一直存在而不被任何检查发现。
  it("claims every implemented route in the task plan", () => {
    const tasks = readFileSync(`${ROOT}docs/sdd/orincard/tasks.md`, "utf8");
    const planned = new Set(
      [...tasks.matchAll(/`(src\/app\/api\/v1\/[A-Za-z0-9_[\]/.-]*route\.ts)`/g)].map((match) => normalize(match[1])),
    );
    const unclaimed = [...implemented().keys()].filter((path) => !planned.has(normalize(`src/app/api/v1${path}/route.ts`)));
    expect(unclaimed).toEqual([]);
  });
});
