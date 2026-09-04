import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTasks, inspectEndpointCoverage } from './check-planning.mjs';

const good = `- [ ] T001 \`tests/smoke.test.ts\` — 集成冒烟 → AC-001
  - Batch: B01
  - Depends: none
  - Check: \`pnpm exec vitest run tests/smoke.test.ts\`
  - Expect: 合法和非法输入都有断言。
`;
test('accepts a complete serial task', () => assert.deepEqual(inspectTasks(good, 'AC-001').errors, []));
test('accepts a document heading before tasks', () => assert.equal(inspectTasks('# Tasks\n\n' + good, 'AC-001').tasks.length, 1));
test('accepts the exact Node version dotfile', () => assert.deepEqual(inspectTasks(good.replace('tests/smoke.test.ts', '.node-version'), 'AC-001').errors, []));
test('rejects a missing dependency', () => assert.match(inspectTasks(good.replace('Depends: none', 'Depends: T002'), 'AC-001').errors.join(), /dependency/));
test('accepts an acyclic dependency declared later in the same batch', () => {
  const first = good.replace('Depends: none', 'Depends: T002');
  const second = good.replaceAll('T001', 'T002').replace('tests/smoke.test.ts', 'tests/other.test.ts');
  assert.deepEqual(inspectTasks(first + second, 'AC-001').errors, []);
});
test('rejects a dependency cycle', () => {
  const first = good.replace('Depends: none', 'Depends: T002');
  const second = good.replaceAll('T001', 'T002').replace('tests/smoke.test.ts', 'tests/other.test.ts').replace('Depends: none', 'Depends: T001');
  assert.match(inspectTasks(first + second, 'AC-001').errors.join(), /cycle/);
});
test('rejects uncovered acceptance criterion', () => assert.match(inspectTasks(good, 'AC-001 AC-002').errors.join(), /Uncovered AC-002/));
test('rejects missing check and expectation', () => {
  const result = inspectTasks(good.replace(/^  - Check:.*\n/m, '').replace(/^  - Expect:.*\n/m, ''), 'AC-001');
  assert.equal(result.errors.length, 2);
});
test('rejects duplicate IDs', () => {
  assert.match(inspectTasks(good + good, 'AC-001').errors.join(), /duplicate/);
});
test('accepts disjoint tasks in a parallel group', () => {
  const parallel = good
    .replace('T001 ', 'T001 [P] ')
    .replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/A')
    + good
      .replaceAll('T001', 'T002')
      .replace('T002 ', 'T002 [P] ')
      .replace('tests/smoke.test.ts', 'tests/other.test.ts')
      .replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/B');
  assert.deepEqual(inspectTasks(parallel, 'AC-001').errors, []);
});
test('rejects missing or stray parallel metadata', () => {
  assert.match(inspectTasks(good.replace('T001 ', 'T001 [P] '), 'AC-001').errors.join(), /requires Parallel/);
  assert.match(inspectTasks(good.replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/A'), 'AC-001').errors.join(), /non-parallel/);
});
test('rejects a one-lane parallel group', () => {
  const parallel = good.replace('T001 ', 'T001 [P] ').replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/A');
  assert.match(inspectTasks(parallel, 'AC-001').errors.join(), /at least two lanes/);
});
test('rejects file overlap across parallel lanes', () => {
  const a = good.replace('T001 ', 'T001 [P] ').replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/A');
  const b = good.replaceAll('T001', 'T002').replace('T002 ', 'T002 [P] ').replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/B');
  assert.match(inspectTasks(a + b, 'AC-001').errors.join(), /overlaps lanes/);
});
test('rejects dependencies across lanes in the same parallel group', () => {
  const a = good.replace('T001 ', 'T001 [P] ').replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/A');
  const b = good
    .replaceAll('T001', 'T002')
    .replace('T002 ', 'T002 [P] ')
    .replace('tests/smoke.test.ts', 'tests/other.test.ts')
    .replace('Batch: B01', 'Batch: B01\n  - Parallel: WS-B01-1/B')
    .replace('Depends: none', 'Depends: T001');
  assert.match(inspectTasks(a + b, 'AC-001').errors.join(), /another lane/);
});
test('rejects unsafe paths and success bypasses', () => {
  const result = inspectTasks(good.replace('`tests/smoke.test.ts`', '`../secret.ts`').replace('pnpm exec vitest run tests/smoke.test.ts', 'pnpm test || true'), 'AC-001');
  assert.match(result.errors.join(), /unsafe/);
  assert.match(result.errors.join(), /bypassable/);
});
test('rejects a task larger than five source files', () => {
  const result = inspectTasks(good.replace('`tests/smoke.test.ts`', Array.from({length: 6}, (_, i) => '`src/a' + i + '.ts`').join(', ')), 'AC-001');
  assert.match(result.errors.join(), /1–5/);
});
test('maps dynamic endpoint parameters to exact Next routes', () => {
  const tasks = [{ files: ['src/app/api/v1/projects/[id]/restore/route.ts'] }];
  assert.deepEqual(inspectEndpointCoverage('POST /projects/:projectId/restore', tasks).errors, []);
});
test('rejects an API path without an implementation task', () => {
  assert.match(inspectEndpointCoverage('GET/POST /assets', []).errors.join(), /no implementation task/);
});
test('requires at least one endpoint in the API contract', () => {
  assert.match(inspectEndpointCoverage('No routes', []).errors.join(), /No API endpoints/);
});
