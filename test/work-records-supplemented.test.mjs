import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {root} from '../scripts/compile.mjs';
import {buildVectors} from '../scripts/generate-work-record-vectors.mjs';
import {checkTask, compileSupplemented, readTask, withoutSupplemented} from '../src/work-records-supplemented.mjs';
import {compileSource, judge, stepsOf} from '../vendor/erc8505/work-records.mjs';

// ERC-8448 orders read as ERC-8505 work records with an optional supplemented step.
// The committed vectors are checked offline; one live local run confirms they are current.
const vectors = JSON.parse(readFileSync(`${root}/vectors/erc8505-supplemented.json`,'utf8'));
const {source, logs, receipts} = vectors;
const byName = Object.fromEntries(vectors.tasks.map(t => [t.name, t]));
const read = name => checkTask(source, logs, receipts, byName[name].task);
const kinds = r => r.steps.map(s => s.step);
const same = (l, p) => l.transactionHash === p.transactionHash && l.logIndex === p.logIndex;
function patched(patch) {
  let l = structuredClone(logs); const r = structuredClone(receipts);
  for (const p of patch) {
    if (p.op === 'dropLog') l = l.filter(x => !same(x, p));
    else if (p.op === 'dropReceiptLog') r[p.transactionHash].logs = r[p.transactionHash].logs.filter(x => x.logIndex !== p.logIndex);
    else if (p.op === 'setLog') for (const x of [...l, ...r[p.transactionHash]?.logs ?? []]) { if (same(x, p)) Object.assign(x, p.set); }
    else throw new Error(`unknown patch ${p.op}`);
  }
  return {logs:l, receipts:r};
}

let live;
before(async () => { live = await buildVectors(); });

test('the pinned ERC-8505 reader is unmodified', () => {
  const [pin, file] = readFileSync(`${root}/vendor/erc8505/SHA256SUMS`,'utf8').trim().split(/  /);
  assert.equal(createHash('sha256').update(readFileSync(`${root}/vendor/erc8505/${file}`)).digest('hex'), pin);
  assert.equal(vectors.reference.workRecordsSha256, pin);
});

test('a fresh local run reproduces the committed vectors', () => {
  assert.deepEqual(live, vectors);
});

test('the descriptor is valid for the pinned reader once the supplemented events are removed', () => {
  assert.doesNotThrow(() => compileSource(withoutSupplemented(source)));
  assert.throws(() => compileSource(source), /supplemented is not a step this profile defines/);
  assert.equal(source.events.filter(e => e.step === 'supplemented').length, 1);
});

test('a price increase is one supplement, backed by its own transfer, and the payment settles the sum', () => {
  const r = read('price-increase');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(kinds(r), ['funded','assigned','supplemented','delivered','verdict','paid']);
  assert.equal(r.outcome, 'accepted');
  assert.equal(r.steps[0].amount, '100'); assert.equal(r.steps[2].amount, '80'); assert.equal(r.steps.at(-1).amount, '180');
  assert.equal(r.supplemented, '80');
  assert.equal(r.steps[0].client, vectors.parties.client);
});

test('the pinned rules give the same paid order no entry', () => {
  const before = judge(stepsOf(compileSource(withoutSupplemented(source)), logs, byName['price-increase'].task));
  assert.equal(before.outcome, 'accepted');
  assert.deepEqual(before.problems, ['the terminal step settles 180 of 100 funded']);
});

test('a same-price amendment is a zero supplement with no transfer, and it changes the brief in force', () => {
  const t = byName['same-price'];
  const r = read('same-price');
  assert.deepEqual(r.errors, []);
  const supplement = r.steps.find(s => s.step === 'supplemented');
  assert.equal(supplement.amount, '0');
  const asset = source.asset.split(':').at(-1).toLowerCase();
  assert.equal(receipts[supplement.tx].logs.filter(l => l.address.toLowerCase() === asset).length, 0);
  assert.equal(r.brief, supplement.brief);
  assert.notEqual(r.brief, r.steps[0].brief);
  // Without the step the task still passes, but the only brief in the record is the superseded one.
  assert.deepEqual(t.expected.withoutSupplementedStep, {outcome:'accepted', problems:[]});
  assert.equal(t.expected.fundedBrief, r.steps[0].brief);
  // The buyer accepted against the amended terms, which is what the verdict's ref carries in this source.
  assert.equal(r.steps.find(s => s.step === 'verdict').ref, r.brief);
});

test('two amendments add up and the last brief before delivery is in force', () => {
  const r = read('two-amendments');
  assert.deepEqual(r.errors, []);
  assert.equal(r.supplements, 2); assert.equal(r.supplemented, '120');
  assert.equal(r.steps.at(-1).amount, '220');
  assert.equal(r.brief, r.steps.filter(s => s.step === 'supplemented').at(-1).brief);
});

test('a failed top-up leaves no supplemented log and the order settles on its original terms', () => {
  const r = read('failed-top-up');
  assert.deepEqual(r.errors, []);
  assert.equal(r.supplements, 0);
  assert.equal(r.steps.at(-1).amount, '100');
  assert.equal(r.brief, r.steps[0].brief);
});

test('an order that was never amended reads the same with and without the step', () => {
  const t = byName['never-amended'];
  const r = read('never-amended');
  assert.deepEqual(r.errors, []);
  const before = stepsOf(compileSource(withoutSupplemented(source)), logs, t.task);
  assert.deepEqual(r.steps, before.steps);
  assert.deepEqual(judge(before).problems, []);
});

test('an amended order that is never delivered refunds the sum and lapses after assignment', () => {
  const r = read('amended-then-lapsed');
  assert.deepEqual(r.errors, []);
  assert.equal(r.outcome, 'lapsed'); assert.equal(r.lapsedAfter, 'assigned');
  assert.equal(r.steps.at(-1).step, 'refunded'); assert.equal(r.steps.at(-1).amount, '180');
  assert.equal(r.steps.at(-1).to, vectors.parties.client);
});

test('every expected reading in the vectors is what the reader returns', () => {
  for (const t of vectors.tasks) {
    const r = checkTask(source, logs, receipts, t.task);
    assert.deepEqual(r.errors, [], t.name);
    assert.equal(r.outcome, t.expected.outcome, t.name);
    assert.equal(r.worker, t.expected.worker, t.name);
    assert.equal(r.brief, t.expected.briefInForce, t.name);
    assert.deepEqual(r.steps, t.expected.steps, t.name);
  }
});

test('a reader fails every tampered case', () => {
  assert.equal(vectors.mustFail.length, 5);
  for (const c of vectors.mustFail) {
    const p = patched(c.patch);
    const r = checkTask(source, p.logs, p.receipts, c.task);
    assert.ok(r.errors.some(e => e.includes(c.error)), `${c.name}: ${JSON.stringify(r.errors)}`);
  }
});

test('a missing receipt is an error, not a pass', () => {
  const t = byName['price-increase'];
  const tx = t.expected.steps.find(s => s.step === 'supplemented').tx;
  const r = checkTask(source, logs, {...receipts, [tx]:undefined}, t.task);
  assert.ok(r.errors.some(e => e.includes('receipt') && e.includes(tx)));
});

test('one transfer cannot back a supplement twice', () => {
  const t = byName['price-increase'];
  const s = t.expected.steps.find(x => x.step === 'supplemented');
  const r = structuredClone(receipts);
  const log = r[s.tx].logs.find(l => l.logIndex === s.log);
  r[s.tx].logs.push({...log, logIndex: 99});
  const errors = checkTask(source, logs, r, t.task).errors;
  assert.ok(errors.some(e => e.includes('no Transfer of 80 backs the supplemented step')), JSON.stringify(errors));
});

test('descriptor rules for the supplemented step', () => {
  const event = source.events.find(e => e.step === 'supplemented');
  const withEvent = e => ({...source, events:[...source.events.filter(x => x.step !== 'supplemented'), e]});
  assert.doesNotThrow(() => compileSupplemented(withEvent({...event, fields:{task:'task', amount:'amount'}})));
  assert.throws(() => compileSupplemented(withEvent({...event, fields:{task:'task'}})), /lacks the field amount/);
  assert.throws(() => compileSupplemented(withEvent({...event, fields:{...event.fields, client:'task'}})), /does not define: client/);
  assert.throws(() => compileSupplemented(withEvent({...event, actor:'worker'})), /does not define: actor/);
  assert.throws(() => compileSupplemented(withEvent({...event, event:'TaskSupplemented(bytes32 indexed task, uint256 amount, bytes32 brief)'})), /first indexed parameter, a uint256/);
  assert.throws(() => compileSupplemented(withEvent({...event, event:'TaskSupplemented(uint256 indexed task, bytes32 amount, bytes32 brief)'})), /cannot hold amount/);
  assert.throws(() => compileSupplemented(withEvent({...event, event:source.events[0].event})), /declared twice/);
});

test('a supplement before the funded step is inconsistent', () => {
  const t = byName['price-increase'];
  const s = t.expected.steps.find(x => x.step === 'supplemented');
  const p = patched([{op:'setLog', transactionHash:s.tx, logIndex:s.log, set:{blockNumber:0}}]);
  assert.ok(readTask(source, p.logs, t.task).problems.includes('a supplemented step comes before the funded step'));
});
