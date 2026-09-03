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
test('rejects forward and missing dependency', () => assert.match(inspectTasks(good.replace('Depends: none', 'Depends: T002'), 'AC-001').errors.join(), /dependency/));
test('rejects uncovered acceptance criterion', () => assert.match(inspectTasks(good, 'AC-001 AC-002').errors.join(), /Uncovered AC-002/));
test('rejects missing check and expectation', () => {
  const result = inspectTasks(good.replace(/^  - Check:.*\n/m, '').replace(/^  - Expect:.*\n/m, ''), 'AC-001');
  assert.equal(result.errors.length, 2);
});
test('rejects duplicate IDs and parallel claims', () => {
  assert.match(inspectTasks(good + good, 'AC-001').errors.join(), /duplicate/);
  assert.match(inspectTasks(good.replace('T001 ', 'T001 [P] '), 'AC-001').errors.join(), /parallel/);
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
