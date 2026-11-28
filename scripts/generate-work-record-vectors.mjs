// Writes vectors/erc8505-supplemented.json from a fresh local run. The run is deterministic, so CI regenerates the file
// and fails on any difference.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './compile.mjs';
import { runScenarios } from './work-record-scenarios.mjs';
import { checkTask, withoutSupplemented } from '../src/work-records-supplemented.mjs';
import { compileSource, judge, stepsOf } from '../vendor/erc8505/work-records.mjs';

export const VECTORS = resolve(root, 'vectors/erc8505-supplemented.json');
const TASK_SUPPLEMENTED = 'TaskSupplemented(uint256 indexed task, uint256 amount, bytes32 brief)';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

export async function buildVectors() {
  const run = await runScenarios();
  const pinned = compileSource(withoutSupplemented(run.source));
  const tasks = run.tasks.map(({ name, task, briefs }) => {
    const r = checkTask(run.source, run.logs, run.receipts, task);
    if (r.errors.length) throw new Error(`${name}: ${r.errors.join('; ')}`);
    if (r.brief !== briefs.at(-1)) throw new Error(`${name}: the brief in force is not the order's last applied terms hash`);
    const before = judge(stepsOf(pinned, run.logs, task));
    return { name, task, expected: {
      outcome: r.outcome, ...(r.lapsedAfter ? { lapsedAfter: r.lapsedAfter } : {}), worker: r.worker,
      supplements: r.supplements, supplemented: r.supplemented, fundedBrief: briefs[0], briefInForce: r.brief, steps: r.steps,
      withoutSupplementedStep: { outcome: before.outcome, problems: before.problems },
    } };
  });

  const stepsOfTask = (name) => tasks.find((t) => t.name === name);
  const at = (t, step, n = 0) => t.expected.steps.filter((s) => s.step === step)[n];
  const key = (s) => ({ transactionHash: s.tx, logIndex: s.log });
  const increase = stepsOfTask('price-increase');
  const same = stepsOfTask('same-price');
  const supplement = at(increase, 'supplemented');
  const delivered = at(increase, 'delivered');
  const paid = at(increase, 'paid');
  const transfer = run.receipts[supplement.tx].logs.find((l) => l.address.toLowerCase() === run.source.asset.split(':').at(-1).toLowerCase());
  const paidLog = run.logs.find((l) => l.transactionHash === paid.tx && l.logIndex === paid.log);
  const sameSupplement = at(same, 'supplemented');
  const sameLog = run.logs.find((l) => l.transactionHash === sameSupplement.tx && l.logIndex === sameSupplement.log);
  const mustFail = [
    { name: 'supplement-without-transfer', task: increase.task,
      why: 'the Transfer log behind an 80-unit supplement is missing from its receipt',
      patch: [{ op: 'dropReceiptLog', transactionHash: supplement.tx, logIndex: transfer.logIndex }],
      error: 'no Transfer of 80 backs the supplemented step' },
    { name: 'supplement-claimed-at-unchanged-price', task: same.task,
      why: 'a same-price amendment is rewritten to claim an 80-unit supplement that never moved',
      patch: [{ op: 'setLog', ...key(sameSupplement), set: { data: '0x' + word(80) + sameLog.data.slice(66) } }],
      error: 'the terminal step settles 100 of 180 funded' },
    { name: 'supplement-dropped', task: increase.task,
      why: 'the supplemented log is left out, so the payment exceeds what the record says was funded',
      patch: [{ op: 'dropLog', ...key(supplement) }],
      error: 'the terminal step settles 180 of 100 funded' },
    { name: 'supplement-after-delivery', task: increase.task,
      why: 'the supplemented log is moved behind the delivery, which ERC-8448 does not allow',
      patch: [{ op: 'setLog', ...key(supplement), set: { blockNumber: delivered.block, logIndex: delivered.log + 1 } }],
      error: 'a supplemented step comes after a delivery' },
    { name: 'short-payment', task: increase.task,
      why: 'the payment is one unit short of the funded amount plus the supplement',
      patch: [{ op: 'setLog', ...key(paid), set: { data: '0x' + word(179) + paidLog.data.slice(66) } }],
      error: 'the terminal step settles 179 of 180 funded' },
  ];
  const sums = readFileSync(resolve(root, 'vendor/erc8505/SHA256SUMS'), 'utf8').trim().split(/\s+/)[0];
  return {
    description: 'ERC-8448 order lifecycles read as ERC-8505 work records with an optional supplemented step. Captured from a local Anvil chain; not re-readable from a public network.',
    proposal: { step: 'supplemented', required: ['task', 'amount'], optional: ['brief'], event: TASK_SUPPLEMENTED },
    reference: { erc8505: 'https://github.com/kurokawasato/ERCs/tree/9f49fb912aad69c94e1103c327e6300b436c408c/assets/erc-8505', workRecordsSha256: sums },
    source: run.source, parties: run.parties, tasks, mustFail, logs: run.logs, receipts: run.receipts,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const vectors = await buildVectors();
  writeFileSync(VECTORS, JSON.stringify(vectors, null, 2) + '\n');
  console.log(`Wrote ${vectors.tasks.length} tasks and ${vectors.mustFail.length} must-fail cases to vectors/erc8505-supplemented.json`);
}
