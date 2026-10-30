import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAdapter } from '../src/storage/adapter.js';
import { runSavePlan } from '../src/editor/save-runner.js';

registerAdapter({ id: 'one', label: 'One', save: async (file) => ({ adapter: 'one', ok: true, name: file.name }) });
registerAdapter({ id: 'two', label: 'Two', save: async (file) => ({ adapter: 'two', ok: true, name: file.name }) });

test('a step that throws is recorded and the rest of the plan still runs', async () => {
  const factory = { get: async (f) => { if (f === 'pdf') throw new Error('no PDF'); return [{ name: `x.${f}` }]; } };
  const steps = [];
  const results = await runSavePlan({
    plan: [{ id: 'one', formats: ['png', 'pdf'] }, { id: 'two', formats: ['png'] }],
    factory, ctx: () => ({}), onStep: (id, s) => { if (s.state) steps.push(`${id}:${s.state}`); },
  });
  assert.deepEqual(results.map((r) => [r.adapter, r.name, r.ok]), [['one', 'x.png', true], ['one', 'pdf', false], ['two', 'x.png', true]]);
  assert.equal(results[1].error, 'no PDF');
  assert.deepEqual(steps, ['one:active', 'one:failed', 'two:active', 'two:done']);
});
