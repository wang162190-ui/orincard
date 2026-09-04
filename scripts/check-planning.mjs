#!/usr/bin/env node
// Documentation validation only; never contacts a cloud service or runs product tests.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectTasks(markdown, spec) {
  const errors = [];
  const sections = markdown.split(/(?=^- \[[ x]\] T\d{3}\b)/m).filter(section => /^- \[[ x]\] T\d{3}\b/.test(section));
  const tasks = sections.map(section => {
    const line = section.split('\n')[0];
    return {
      id: line.match(/T\d{3}/)?.[0],
      files: [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]),
      acs: [...line.matchAll(/AC-\d{3}/g)].map(m => m[0]),
      batch: section.match(/^  - Batch: (B\d{2})$/m)?.[1],
      parallel: /\[P\]/.test(line),
      parallelGroup: section.match(/^  - Parallel: ([A-Z0-9-]+)\/([A-C])$/m)?.[1],
      parallelLane: section.match(/^  - Parallel: ([A-Z0-9-]+)\/([A-C])$/m)?.[2],
      deps: section.match(/^  - Depends: (.+)$/m)?.[1].match(/T\d{3}/g) ?? [],
      check: section.match(/^  - Check: `([^`]+)`$/m)?.[1],
      expect: section.match(/^  - Expect: (.+)$/m)?.[1],
      line,
    };
  });
  if (!tasks.length) errors.push('No tasks found');
  const seen = new Set();
  let previousBatch = 0;
  for (const task of tasks) {
    const fail = message => errors.push(`${task.id}: ${message}`);
    if (seen.has(task.id)) fail('duplicate task ID');
    if (!task.batch) fail('missing batch');
    const batchNumber = Number(task.batch?.slice(1));
    if (batchNumber < previousBatch) fail('batch order regresses');
    previousBatch = batchNumber;
    if (!task.files.length || task.files.length > 5) fail('files must contain 1–5 exact source paths');
    if (new Set(task.files).size !== task.files.length) fail('duplicate file in task');
    for (const path of task.files) {
      if (isAbsolute(path) || path.split('/').includes('..') || /[*<>]/.test(path) || (path !== '.node-version' && !/\.[a-z0-9]+$/i.test(path))) fail(`unsafe or imprecise path: ${path}`);
    }
    if (!task.acs.length) fail('missing AC mapping');
    if (!task.check || /\|\|\s*true|--passWithNoTests|--if-present/.test(task.check)) fail('missing or bypassable check');
    if (!task.expect) fail('missing observable expectation');
    if (task.parallel && (!task.parallelGroup || !task.parallelLane)) fail('parallel task requires Parallel group/lane metadata');
    if (!task.parallel && (task.parallelGroup || task.parallelLane)) fail('non-parallel task must not declare Parallel metadata');
    seen.add(task.id);
  }
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    for (const dep of task.deps) {
      const dependency = taskById.get(dep);
      if (!dependency) errors.push(`${task.id}: dependency not defined: ${dep}`);
      else if (Number(dependency.batch?.slice(1)) > Number(task.batch?.slice(1))) errors.push(`${task.id}: dependency ${dep} is in a later batch`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = task => {
    if (visiting.has(task.id)) {
      errors.push(`${task.id}: dependency cycle detected`);
      return;
    }
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const dep of task.deps) {
      const dependency = taskById.get(dep);
      if (dependency) visit(dependency);
    }
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of tasks) visit(task);
  const parallelGroups = new Map();
  for (const task of tasks.filter(task => task.parallelGroup)) {
    const group = parallelGroups.get(task.parallelGroup) ?? [];
    group.push(task);
    parallelGroups.set(task.parallelGroup, group);
  }
  for (const [groupName, groupTasks] of parallelGroups) {
    const lanes = new Set(groupTasks.map(task => task.parallelLane));
    if (lanes.size < 2) errors.push(`${groupName}: parallel group must use at least two lanes`);
    if (lanes.size > 3) errors.push(`${groupName}: parallel group exceeds three lanes`);
    const fileOwners = new Map();
    for (const task of groupTasks) {
      for (const file of task.files) {
        const owner = fileOwners.get(file);
        if (owner && owner !== task.parallelLane) errors.push(`${groupName}: file overlaps lanes ${owner}/${task.parallelLane}: ${file}`);
        fileOwners.set(file, task.parallelLane);
      }
      for (const dep of task.deps) {
        const dependency = taskById.get(dep);
        if (dependency?.parallelGroup === groupName && dependency.parallelLane !== task.parallelLane) {
          errors.push(`${task.id}: dependency ${dep} is in another lane of ${groupName}`);
        }
      }
    }
  }
  const required = new Set(spec.match(/AC-\d{3}/g) ?? []);
  const covered = new Set(tasks.flatMap(task => task.acs));
  for (const ac of required) if (!covered.has(ac)) errors.push(`Uncovered ${ac}`);
  for (const ac of covered) if (!required.has(ac)) errors.push(`Unknown ${ac}`);
  if (/\b(?:TBD|TODO)\b|待完善|待补|加适当/.test(markdown)) errors.push('Task placeholder found');
  const batches = [...new Set(tasks.map(task => task.batch).filter(Boolean))];
  for (const batch of batches) {
    const last = tasks.filter(task => task.batch === batch).at(-1);
    if (!/集成|冒烟|smoke/.test(last.line)) errors.push(`${batch}: missing closing integration task`);
  }
  return { errors, tasks, batches, covered, parallelGroups };
}

export function inspectManifest(root, manifest) {
  const errors = [];
  const paths = new Set();
  for (const entry of manifest.files ?? []) {
    const path = resolve(root, entry.path);
    if (isAbsolute(entry.path) || entry.path.split('/').includes('..') || relative(root, path).startsWith('..')) {
      errors.push('Unsafe manifest path');
      continue;
    }
    if (paths.has(entry.path)) errors.push(`Duplicate manifest path: ${entry.path}`);
    paths.add(entry.path);
    if (!existsSync(path)) { errors.push(`Missing design file: ${entry.path}`); continue; }
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) errors.push(`Changed design reference: ${entry.path}`);
  }
  for (const file of ['index.html', 'generator.html', 'editor.html', 'projects.html', 'brand-kits.html']) {
    if (!paths.has(file)) errors.push(`Missing required reference page: ${file}`);
    if (!existsSync(resolve(root, file))) continue;
    const html = readFileSync(resolve(root, file), 'utf8');
    for (const match of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const ref = match[1].split(/[?#]/)[0];
      if (!ref || /^(?:[a-z]+:|\/|\$|\{)/i.test(ref) || ref.includes("'+") || ref.includes("' +")) continue;
      const target = resolve(root, ref);
      if (relative(root, target).startsWith('..') || !existsSync(target)) errors.push(`Broken design reference: ${file} -> ${ref}`);
    }
  }
  return errors;
}

export function inspectEndpointCoverage(api, tasks) {
  const normalize = path => path.replace(/\[[^\]]+\]|:[A-Za-z][A-Za-z0-9_]*/g, '[param]');
  const files = new Set(tasks.flatMap(task => task.files).map(normalize));
  const errors = [];
  const endpoints = new Set();
  for (const match of api.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))?\s+(\/[A-Za-z0-9_/:.-]+)/g)) {
    const path = match[1];
    endpoints.add(path);
    if (!files.has(normalize(`src/app/api/v1${path}/route.ts`))) errors.push(`API has no implementation task: ${path}`);
  }
  if (!endpoints.size) errors.push('No API endpoints found');
  return { errors, endpoints };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const docRoot = resolve(root, 'docs/sdd/orincard');
  const read = name => readFileSync(resolve(docRoot, name), 'utf8');
  const result = inspectTasks(read('tasks.md'), read('spec.md'));
  const errors = [...result.errors];
  const api = inspectEndpointCoverage(read('contracts/api.md'), result.tasks);
  errors.push(...api.errors);
  const docs = ['plan.md', 'data-model.md', 'contracts/api.md', 'contracts/document.md', 'contracts/processing.md', 'operations.md', 'research.md', 'review.md'];
  for (const file of docs) {
    const body = read(file);
    if (!body.includes('> source: docs/sdd/orincard/spec.md')) errors.push(`Missing source declaration: ${file}`);
    for (const m of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z]+:|^\//i.test(target)) continue;
      if (!existsSync(resolve(docRoot, dirname(file), target))) errors.push(`Broken documentation link: ${file} -> ${target}`);
    }
  }
  const plan = read('plan.md');
  for (const batch of result.batches) if (!plan.includes(batch)) errors.push(`Plan omits ${batch}`);
  if (!plan.includes('关键路径') || !plan.includes('三线并行')) errors.push('Plan omits critical path or parallel execution');
  const designRoot = resolve(root, 'docs/design/reference');
  const manifest = JSON.parse(readFileSync(resolve(designRoot, 'manifest.json'), 'utf8'));
  errors.push(...inspectManifest(designRoot, manifest));
  const env = readFileSync(resolve(root, '.env.example'), 'utf8');
  for (const line of env.split('\n')) {
    if (/^(?:.*(?:API_KEY|SECRET_KEY|WEBHOOK_SECRET)|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)=.+/.test(line)) errors.push('Credential example contains a value');
  }
  if (errors.length) {
    for (const error of errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: ${result.tasks.length} planned tasks / ${result.batches.length} batches / ${result.parallelGroups.size} parallel groups (max 3 lanes) / ${result.covered.size} ACs / ${api.endpoints.size} API paths assigned / ${manifest.files.length} unchanged design files.`);
  console.log('Documentation structure and reference integrity only. Product, cloud integration and visual acceptance have NOT been executed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
