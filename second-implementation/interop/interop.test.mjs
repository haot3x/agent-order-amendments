// The same spec-level client drives two independently written ERC-8448 implementations. Each scenario is checked
// against the specification on both, and then the two sets of observations are compared with each other.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { observe, replayVector } from './scenarios.mjs';

const NAMES = ['reference', 'second'];
const seen = {};
before(async () => {
  for (const name of NAMES) {
    seen[name] = (await observe(name)).scenarios;
    seen[name]['published vector on a live chain'] = await replayVector(name);
  }
});
const both = (title, check) => test(title, () => { for (const name of NAMES) check(seen[name], name); });
const failed = (e, name) => { assert.equal(e.outer, 'mined', name); assert.equal(e.success, false, name); assert.equal(e.appliedLogs, 0, name); assert.equal(e.tokenTransfers, 0, name); assert.equal(e.status, 'Executed', name); };
const applied = (e, revision, supplement, name) => {
  assert.equal(e.outer, 'mined', name); assert.equal(e.success, true, name); assert.equal(e.appliedLogs, 1, name); assert.equal(e.status, 'Executed', name);
  assert.equal(e.applied.revision, revision, name); assert.equal(e.applied.supplement, supplement, name); assert.equal(e.applied.intentHash, true, name);
  assert.deepEqual({ ...e.result, bytes: undefined }, { orderId: e.applied.orderId, revision, newTermsHash: e.applied.newTermsHash, supplement, bytes: undefined }, name);
  assert.equal(e.result.bytes, 128, name);
  assert.equal(e.tokenTransfers, supplement === '0' ? 0 : 1, name);
};

both('unknown order and the zero id revert with UnknownOrder(orderId)', (s, name) => {
  const o = s['unknown order'];
  assert.equal(o.unknown, o.expected, name); assert.equal(o.zero, o.expectedZero, name);
});

both('an offered order is readable with eligible=false', (s, name) => {
  const o = s['offered order is readable and ineligible'];
  assert.equal(o.eligible, false, name); assert.equal(o.revision, '0', name); assert.equal(o.terms.totalPrice, '100', name);
});

both('100 to 180 needs 80, then 180 to 220 needs 40, built from the common view alone', (s, name) => {
  const o = s['100 to 180 through the common view, then 180 to 220'];
  assert.equal(o.before.state.eligible, true, name);
  assert.equal(o.hashes.intentStructHashMatchesClient, true, name);
  assert.deepEqual([o.consent1.propose, ...o.consent1.accepts, o.consent1.status], [true, true, true, 'Ready'], name);
  assert.equal(o.consentChangedNothing, true, name);
  applied(o.exec1, '1', '80', name);
  assert.equal(o.exec1.applied.previousTermsHash, o.before.state.termsHash, name);
  assert.equal(o.mid.state.termsHash, o.exec1.applied.newTermsHash, name);
  assert.deepEqual([o.mid.state.revision, o.mid.state.amendmentNonce, o.mid.state.terms.totalPrice], ['1', '1', '180'], name);
  assert.equal(BigInt(o.mid.balances.held) - BigInt(o.before.balances.held), 80n, name);
  assert.equal(BigInt(o.before.balances.buyer) - BigInt(o.mid.balances.buyer), 80n, name);
  applied(o.exec2, '2', '40', name);
  assert.deepEqual([o.after.state.revision, o.after.state.amendmentNonce, o.after.state.terms.totalPrice], ['2', '2', '220'], name);
  assert.equal(BigInt(o.after.balances.held) - BigInt(o.before.balances.held), 120n, name);
  assert.equal(o.replay.outer, 'revert', name); // an executed intent is terminal
});

both('at most one of two amendments on one base revision applies', (s, name) => {
  const o = s['two amendments on one base revision'];
  applied(o.first, '1', '50', name); failed(o.second, name);
  assert.equal(o.unchangedBySecond, true, name); assert.equal(o.state.terms.totalPrice, '150', name);
});

both('either party can invalidate; the agreement and funds stay intact', (s, name) => {
  const o = s['provider invalidates a fully accepted amendment'];
  assert.deepEqual(o.event, { orderId: true, participant: true, amendmentNonce: '1' }, name);
  assert.deepEqual([o.afterInvalidation.revision, o.afterInvalidation.amendmentNonce], ['0', '1'], name);
  assert.equal(o.fundsAndTermsIntact, true, name); failed(o.exec, name); assert.equal(o.strangerCanInvalidate, false, name);
});

both('failed funding rolls back, consumes the intent, and a retry needs a fresh intent and acceptances', (s, name) => {
  const o = s['funding fails, then a fresh intent succeeds'];
  assert.equal(o.eligibleWithoutAllowance, true, name); // eligibility is not a funding guarantee
  failed(o.failed, name); assert.equal(o.unchanged, true, name);
  assert.equal(o.retryOld.outer, 'revert', name); assert.equal(o.reacceptOld, false, name);
  assert.equal(o.sameBaseState, true, name); assert.equal(o.differentIntent, true, name);
  applied(o.freshExec, '1', '80', name);
});

both('a token that moves funds and returns false is rolled back', (s, name) => {
  const o = s['token moves funds and then returns false'];
  failed(o.exec, name); assert.equal(o.unchanged, true, name);
});

both('nonempty execution data reverts without consuming the coordination', (s, name) => {
  const o = s['nonempty execution data'];
  assert.deepEqual(o.withData, { outer: 'revert', status: 'Ready' }, name); applied(o.thenWithout, '1', '80', name);
});

both('submitted work freezes amendments and invalidation', (s, name) => {
  const o = s['work submitted before execution'];
  assert.equal(o.view.eligible, false, name); failed(o.exec, name);
  assert.equal(o.invalidateAfterSubmission, false, name); assert.equal(o.unchanged, true, name);
});

both('a price decrease, a shorter deadline and unchanged terms fail even with both acceptances', (s, name) => {
  const o = s['price decrease and deadline shortening'];
  assert.equal(o.lowerConsent.status, 'Ready', name); failed(o.lowerExec, name);
  assert.equal(o.shorterConsent.status, 'Ready', name); failed(o.shorterExec, name);
  assert.equal(o.state.revision, '0', name);
  failed(s['unchanged terms'].exec, name); assert.equal(s['unchanged terms'].state.revision, '0', name);
});

both('a same-price amendment applies with a zero supplement', (s, name) => {
  const o = s['same price, new criteria'];
  applied(o.exec, '1', '0', name); assert.equal(o.state.terms.totalPrice, '100', name);
});

both('equality with validUntil or the order deadline is expired', (s, name) => {
  failed(s['time equals the amendment validity limit'].exec, name);
  const o = s['time equals the order deadline'];
  failed(o.exec, name); assert.equal(o.eligibleAtDeadline, false, name); assert.equal(o.invalidateAtDeadline, false, name); assert.equal(o.readable, true, name);
});

both('after an extension the view and later amendments use the new deadline', (s, name) => {
  const o = s['deadline extension is used by the view and by later amendments'];
  applied(o.exec, '1', '80', name); assert.equal(o.eligiblePastOriginalDeadline, true, name); applied(o.laterExec, '2', '40', name);
});

both('compact ERC-2098 signatures work; one participant may submit the other attestation; outsiders may not', (s, name) => {
  const o = s['signature forms and submission by the other participant'];
  assert.equal(o.compactBytes, 64, name); assert.deepEqual(o.consented.accepts, [true, true], name); applied(o.exec, '1', '80', name);
  assert.deepEqual(o.forgedProviderAcceptance, [true, false], name); assert.equal(o.outsiderSubmits, false, name);
});

both('profile rules on the intent, payload and acceptance are enforced', (s, name) => {
  for (const [rule, accepted] of Object.entries(s['proposal rules'])) assert.equal(accepted, false, `${name}: ${rule}`);
});

both('cancellation: proposer only before expiry, anyone after; cancelled and expired intents do not execute', (s, name) => {
  const o = s['cancellation'];
  assert.equal(o.byOtherBeforeExpiry, false, name); assert.equal(o.proposerCancel.status, 'Cancelled', name);
  assert.equal(o.execAfterCancel.outer, 'revert', name); assert.equal(o.execAtExpiry.outer, 'revert', name);
  assert.equal(o.anyoneAfterExpiry, true, name); assert.equal(o.statusAfter, 'Cancelled', name); assert.equal(o.orderUntouched, true, name);
});

both('a payload outside the canonical profile encoding is never applied', (s, name) => {
  const o = s['payload that is not the canonical profile payload'];
  for (const k of ['trailingBytes', 'termsHashMismatch', 'otherOrderContract', 'wrongPayloadVersion', 'zeroScopeHash']) assert.equal(o[k].applied, false, `${name}: ${k}`);
});

both('an expired acceptance blocks execution without consuming the intent', (s, name) => {
  const o = s['an acceptance expires before the intent'];
  assert.equal(o.consented, 'Ready', name); assert.equal(o.exec.outer, 'revert', name); assert.equal(o.orderUntouched, true, name);
});

both('an ERC-1271 buyer is validated at acceptance and not revalidated at execution', (s, name) => {
  const o = s['contract buyer signs through ERC-1271'];
  assert.equal(o.buyerIsContract, true, name); assert.deepEqual(o.consented.accepts, [true, true], name);
  applied(o.exec, '1', '80', name); // the wallet started rejecting signatures after it accepted
  assert.deepEqual(o.acceptsWhileWalletRejects, [false, true], name); assert.equal(o.walletBalance, '820', name);
});

both('the published vector applies through the real entry points on a live chain', (s, name) => {
  const o = s['published vector on a live chain'];
  assert.equal(o.baseMatchesVector, true, name); assert.equal(o.ready, 'Ready', name); assert.equal(o.success, true, name);
  assert.deepEqual(o.applied, { intentHash: true, revision: '1', previousTermsHash: true, newTermsHash: true, supplement: '80' }, name);
  assert.deepEqual([o.after.revision, o.after.amendmentNonce, o.after.terms.totalPrice, o.after.terms.deadline], ['1', '1', '180', '2000020000'], name);
});

// What differs between the two, as paths into the observations.
function differences(a, b, path = '') {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differences(a[k], b[k], `${path}/${k}`));
  }
  return a === b ? [] : [path];
}

test('the two implementations agree on everything observed except the bytes of a failed result', () => {
  const diff = differences(seen.reference, seen.second);
  assert.ok(diff.length > 0, 'the failed result bytes are expected to differ');
  for (const path of diff) assert.match(path, /\/failureResultBytes$/, path);
  assert.equal(Object.keys(seen.reference).length, 22);
});
