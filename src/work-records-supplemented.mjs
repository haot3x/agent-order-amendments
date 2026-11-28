// Experimental `supplemented` step for ERC-8505 Evaluated Work Records.
//
// ERC-8505 at the pinned revision requires exactly one `funded` step and a terminal step that settles the funded
// amount, so an order whose price or terms changed under ERC-8448 gets no entry. This module adds one optional step on
// top of the unmodified reference reader in vendor/erc8505 and leaves every other rule to it. It is a proposal under
// discussion, not part of ERC-8505.
//
// Rules added here:
// - A descriptor MAY declare `supplemented` events with `task` and `amount`, and optionally `brief`.
// - Every `supplemented` step comes after the task's `funded` step and before any `delivered` step.
// - The terminal step settles the funded amount plus every supplement.
// - A supplement above zero is a transfer of that amount from the funded step's client to the vault, in the same
//   transaction, backed by its own `Transfer` log. A supplement of zero moves no money and needs no log.
// - The brief in force at delivery is the last brief logged by a `funded` or `supplemented` step before delivery.
//
// Pure: no network access. Node.js 18 or later.

import { compileSource, decodeLog, judge, parseEvent, stepsOf, vaultOf, TRANSFER_TOPIC } from '../vendor/erc8505/work-records.mjs';

export const SUPPLEMENTED = 'supplemented';
const REQUIRED = ['task', 'amount'];
const OPTIONAL = ['brief'];
const isUint = (t) => /^uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)$/.test(t);
const FIELD_TYPE = { task: (t) => t === 'uint256', amount: isUint, brief: (t) => t === 'bytes32' || isUint(t) };
const lower = (s) => String(s).toLowerCase();

/** The descriptor a reader of the pinned ERC-8505 revision would hold: the same source without `supplemented` events. */
export const withoutSupplemented = (source) => ({ ...source, events: source.events.filter((e) => e.step !== SUPPLEMENTED) });

/** Checks a descriptor that may declare `supplemented` events and compiles it for the reference reader's decoder. */
export function compileSupplemented(source) {
  if (!Array.isArray(source?.events)) throw new Error("the source's events must be an array");
  const compiled = compileSource(withoutSupplemented(source));
  for (const entry of source.events.filter((e) => e.step === SUPPLEMENTED)) {
    for (const k of Object.keys(entry)) {
      if (!['step', 'event', 'fields'].includes(k)) throw new Error(`a supplemented event entry has a field this step does not define: ${k}`);
    }
    const event = parseEvent(entry.event);
    if (compiled.byTopic.has(event.topic)) throw new Error(`the topic of ${entry.event} is declared twice`);
    const fields = entry.fields ?? {};
    for (const k of REQUIRED) if (!Object.hasOwn(fields, k)) throw new Error(`fields of ${event.name} lacks the field ${k}`);
    for (const k of Object.keys(fields)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) throw new Error(`fields of ${event.name} has a field this step does not define: ${k}`);
    const firstIndexed = event.params.find((p) => p.indexed);
    if (!firstIndexed || fields.task !== firstIndexed.name || firstIndexed.type !== 'uint256') {
      throw new Error(`the task field of ${event.name} must name its first indexed parameter, a uint256`);
    }
    const map = {};
    for (const [field, target] of Object.entries(fields)) {
      const param = event.params.find((p) => p.name === target);
      if (!param) throw new Error(`${event.name} has no parameter named ${target}`);
      if (!FIELD_TYPE[field](param.type)) throw new Error(`${event.name}.${target} is a ${param.type}, which cannot hold ${field}`);
      map[field] = { param, type: param.type };
    }
    compiled.byTopic.set(event.topic, { step: SUPPLEMENTED, event, map, actor: false, feeIncluded: false });
  }
  return { ...compiled, source };
}

/** The brief the verdict is read against: the last one logged by a funded or supplemented step before delivery. */
export function briefInForce(steps) {
  const delivered = steps.findIndex((s) => s.step === 'delivered');
  const before = delivered < 0 ? steps : steps.slice(0, delivered);
  return before.filter((s) => (s.step === 'funded' || s.step === SUPPLEMENTED) && 'brief' in s).at(-1)?.brief;
}

/**
 * The reference reader's verdict on a task, with its supplements folded into the funded amount, and the rules of the
 * supplemented step added. Takes the result of the reference `stepsOf` over a `compileSupplemented` source.
 */
export function judgeSupplemented(found) {
  const { steps, entries } = found;
  const isSupplement = (s) => s.step === SUPPLEMENTED;
  const funded = steps.findIndex((s) => s.step === 'funded');
  const delivered = steps.findIndex((s) => s.step === 'delivered');
  const supplemented = steps.filter(isSupplement).reduce((sum, s) => sum + BigInt(s.amount), 0n);
  const view = steps.flatMap((s, i) => {
    if (isSupplement(s)) return [];
    return [{ step: i === funded ? { ...s, amount: (BigInt(s.amount) + supplemented).toString() } : s, entry: entries[i] }];
  });
  const judged = judge({ ...found, steps: view.map((x) => x.step), entries: view.map((x) => x.entry) });
  const problems = [...judged.problems];
  if (found.settled && judged.worker !== undefined) {
    steps.forEach((s, i) => {
      if (!isSupplement(s)) return;
      if (funded < 0 || i < funded) problems.push('a supplemented step comes before the funded step');
      if (delivered >= 0 && i > delivered) problems.push('a supplemented step comes after a delivery');
    });
  }
  return { ...judged, problems, supplements: steps.filter(isSupplement).length, supplemented: supplemented.toString(), brief: briefInForce(steps) };
}

/** Steps, outcome and broken rules of one task under a descriptor that may declare `supplemented` events. */
export function readTask(source, logs, task) {
  const found = stepsOf(compileSupplemented(source), logs, task);
  return { ...judgeSupplemented(found), steps: found.steps };
}

const MONEY = new Set(['funded', SUPPLEMENTED, 'paid', 'refunded']);
const moves = (l, t) => lower(l.address) === t.asset && lower(l.topics[0]) === TRANSFER_TOPIC && l.topics.length === 3
  && BigInt(l.topics[1]) === BigInt(t.from) && BigInt(l.topics[2]) === BigInt(t.to) && BigInt(l.data) === t.amount;

/**
 * The transfers of the declared steps in one transaction, of every task, that its receipt does not hold. As in the
 * reference reader, each Transfer log backs at most one step. `clients` maps a task id (a bigint) to the client of
 * its funded step, which a supplement's transfer comes from; `called` is as for the reference `vaultOf`.
 */
export function unbackedTransfers(compiled, receipt, clients = new Map(), called) {
  const asset = lower(compiled.source.asset.split(':').at(-1));
  const used = new Set();
  const missing = [];
  for (const log of receipt.logs) {
    let d;
    try {
      d = decodeLog(compiled, log);
    } catch {
      continue; // the task's own checks fail a log that does not decode
    }
    if (!d || !MONEY.has(d.entry.step)) continue;
    const f = d.fields;
    const vault = vaultOf(compiled, d.task, called);
    let t;
    if (d.entry.step === 'funded') t = { asset, from: f.client, to: vault, amount: BigInt(f.amount) };
    else if (d.entry.step === 'refunded') t = { asset, from: vault, to: f.to, amount: BigInt(f.amount) };
    else if (d.entry.step === 'paid') t = { asset, from: vault, to: f.to, amount: BigInt(f.amount) - (d.entry.feeIncluded ? BigInt(f.fee ?? 0) : 0n) };
    else {
      if (BigInt(f.amount) === 0n) continue; // an unchanged price moves no money
      const client = clients.get(d.task);
      if (!client) throw new Error(`the client of task ${d.task} is needed to check its supplement`);
      t = { asset, from: client, to: vault, amount: BigInt(f.amount) };
    }
    const i = receipt.logs.findIndex((l, k) => !used.has(k) && moves(l, t));
    if (i < 0) missing.push({ task: d.task, step: d.entry.step, ...t });
    else used.add(i);
  }
  return missing;
}

/**
 * Reads one task and checks its money. `receipts` maps a transaction hash to its receipt (an object with `logs`) for
 * every transaction that holds a money step of the task. Returns the task's reading plus `errors`: the consistency
 * rules it breaks and each transfer a receipt does not hold.
 */
export function checkTask(source, logs, receipts, task) {
  const compiled = compileSupplemented(source);
  const found = stepsOf(compiled, logs, task);
  const judged = judgeSupplemented(found);
  const errors = judged.problems.map((p) => `inconsistent: ${p}`);
  const client = found.steps.find((s) => s.step === 'funded')?.client;
  const clients = new Map(client ? [[BigInt(task), client]] : []);
  for (const tx of new Set(found.steps.filter((s) => MONEY.has(s.step)).map((s) => s.tx))) {
    const receipt = receipts[tx];
    if (!receipt) {
      errors.push(`the receipt of ${tx} is needed to check the task's money`);
      continue;
    }
    for (const m of unbackedTransfers(compiled, receipt, clients)) {
      if (m.task === BigInt(task)) errors.push(`no Transfer of ${m.amount} backs the ${m.step} step in ${tx}`);
    }
  }
  return { ...judged, steps: found.steps, errors };
}
