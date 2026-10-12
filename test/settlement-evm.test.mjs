import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { id, MaxUint256 } from 'ethers';
import { localEvm } from '../scripts/local-evm.mjs';
import { domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES } from '../src/profile.mjs';

let env, token, core, buyer, provider, outsider, snapshot;
const orderId = id('settlement-order');
const resultHash = id('exact delivered report bytes');
const terms = { scopeHash: id('3 projects'), acceptanceHash: id('3 cited entries'), totalPrice: 100n, deadline: 2000010000n };
const send = async promise => (await promise).wait();
const logs = receipt => receipt.logs.filter(l => l.address.toLowerCase() === core.target.toLowerCase()).map(l => core.interface.parseLog(l));
const mineAt = async time => {
  await env.rpc.send('evm_setNextBlockTimestamp', [Number(time)]);
  await env.rpc.send('evm_mine', []);
};
before(async () => {
  env = await localEvm();
  [buyer, provider, outsider] = env.signers;
  token = await env.deploy('TestToken');
  core = await env.deploy('ExperimentalOrderAmendments', [token.target]);
  await send(token.mint(buyer.address, 1000n));
  await send(token.approve(core.target, MaxUint256));
  await send(core.offerOrder(orderId, provider.address, terms));
  snapshot = await env.rpc.send('evm_snapshot', []);
});
after(async () => { if (env) await env.close(); });
beforeEach(async () => {
  await env.rpc.send('evm_revert', [snapshot]);
  snapshot = await env.rpc.send('evm_snapshot', []);
});

const activate = () => send(core.connect(provider).activateOrder(orderId));
async function submit() {
  const o = await core.getOrder(orderId);
  await send(core.connect(provider).submit(orderId, o.revision, o.termsHash, resultHash));
  return [orderId, o.revision, o.termsHash, resultHash];
}
async function ready(newTerms = { ...terms, totalPrice: 180n, deadline: 2000020000n }) {
  const o = await core.getOrder(orderId);
  const payload = buildPayload({ orderContract: core.target, orderId, baseRevision: o.revision,
    baseTermsHash: o.termsHash, amendmentNonce: o.amendmentNonce, newTermsHash: hashTerms(newTerms), newTerms,
    validUntil: 2000040000n }, 2000000000n);
  const intent = buildIntent({ payload, expiry: 2000040000n, nonce: (await core.getAgentNonce(buyer.address)) + 1n,
    agentId: buyer.address, participants: [buyer.address, provider.address] });
  const h = hashIntent(intent);
  await send(core.proposeCoordination(intent, await env.wallets[0].signTypedData(domain(core.target), INTENT_TYPES, intent), payload));
  for (const [i, party] of [buyer, provider].entries()) {
    const a = buildAcceptance(intent, party.address);
    await send(core.connect(party).acceptCoordination(h, { ...a, signature: await env.wallets[i].signTypedData(domain(core.target), ACCEPTANCE_TYPES, a) }));
  }
  return { h, payload };
}
async function apply(p) {
  const receipt = await send(core.connect(outsider).executeCoordination(p.h, p.payload, '0x', { gasLimit: 2000000 }));
  return logs(receipt).find(l => l.name === 'CoordinationExecuted').args.success;
}
async function state() {
  return { order: (await core.getOrder(orderId)).toObject(true),
    balances: await Promise.all([buyer.address, provider.address, outsider.address, core.target].map(a => token.balanceOf(a))) };
}
async function assertFailedTransfer(operation) {
  await send(token.setFailAfterTransfer(true));
  const before = await state();
  // Send an actual transaction: verify EVM rollback, not only a simulated call.
  await assert.rejects(send(operation({ gasLimit: 1000000 })), /revert/i);
  assert.deepEqual(await state(), before);
  await send(token.setFailAfterTransfer(false));
  return send(operation({ gasLimit: 1000000 }));
}

test('full order: 100 -> 180 -> current delivery -> buyer acceptance pays exactly once', async () => {
  await activate();
  assert.equal(await apply(await ready()), true);
  const delivery = await submit();
  const before = await state();
  assert.equal(before.order.status, 3n);
  assert.deepEqual(before.balances, [820n, 0n, 0n, 180n]);
  const receipt = await send(core.acceptDelivery(...delivery));
  const events = logs(receipt);
  const accepted = events.find(l => l.name === 'OrderAccepted');
  assert.equal(accepted.args.revision, 1n);
  assert.equal(accepted.args.termsHash, delivery[2]);
  assert.equal(accepted.args.resultHash, resultHash);
  assert.equal(events.find(l => l.name === 'OrderPaid').args.amount, 180n);
  const after = await state();
  assert.equal(after.order.status, 4n);
  assert.equal(after.order.escrow, 0n);
  assert.deepEqual(after.balances, [820n, 180n, 0n, 0n]);
  await assert.rejects(core.acceptDelivery.staticCall(...delivery), /NOT_SUBMITTED/);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_REFUNDABLE/);
  await assert.rejects(core.cancelOfferedOrder.staticCall(orderId), /NOT_OFFERED/);
});

test('only the buyer may accept; acceptance binds revision, terms and exact submitted result', async () => {
  await activate();
  assert.equal(await apply(await ready()), true);
  const delivery = await submit();
  const before = await state();
  for (const caller of [provider, outsider]) {
    await assert.rejects(core.connect(caller).acceptDelivery.staticCall(...delivery), /BUYER/);
  }
  for (const [index, value] of [[1, 0n], [2, hashTerms(terms)], [3, id('different bytes')]]) {
    const wrong = [...delivery]; wrong[index] = value;
    await assert.rejects(core.acceptDelivery.staticCall(...wrong), /ACCEPTANCE_BINDING/);
  }
  assert.deepEqual(await state(), before);
});

test('buyer cannot pay an offered or active order before delivery', async () => {
  const args = [orderId, 0n, hashTerms(terms), resultHash];
  await assert.rejects(core.acceptDelivery.staticCall(...args), /NOT_SUBMITTED/);
  await activate();
  await assert.rejects(core.acceptDelivery.staticCall(...args), /NOT_SUBMITTED/);
});

test('buyer cancels an unactivated offer; refund is terminal and cannot reuse its ID', async () => {
  for (const caller of [provider, outsider]) {
    await assert.rejects(core.connect(caller).cancelOfferedOrder.staticCall(orderId), /BUYER/);
  }
  const receipt = await send(core.cancelOfferedOrder(orderId));
  const refund = logs(receipt).find(l => l.name === 'OrderRefunded');
  assert.equal(refund.args.buyer, buyer.address);
  assert.equal(refund.args.amount, 100n);
  assert.equal(refund.args.finalStatus, 5n);
  assert.equal((await core.getOrder(orderId)).escrow, 0n);
  assert.equal(await token.balanceOf(buyer.address), 1000n);
  await assert.rejects(core.connect(provider).activateOrder.staticCall(orderId), /ACTIVATION/);
  await assert.rejects(core.cancelOfferedOrder.staticCall(orderId), /NOT_OFFERED/);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_REFUNDABLE/);
  await assert.rejects(core.offerOrder.staticCall(orderId, provider.address, terms), /ORDER_EXISTS/);
});

test('activation prevents a unilateral early cancellation', async () => {
  await activate();
  await assert.rejects(core.cancelOfferedOrder.staticCall(orderId), /NOT_OFFERED/);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_EXPIRED/);
  assert.equal((await core.getOrder(orderId)).escrow, 100n);
});

test('an expired unactivated offer can be refunded by anyone, only to the buyer', async () => {
  await mineAt(terms.deadline - 1n);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_EXPIRED/);
  await mineAt(terms.deadline);
  await assert.rejects(core.connect(provider).activateOrder.staticCall(orderId), /ORDER_DEADLINE/);
  await send(core.connect(outsider).refundExpiredOrder(orderId));
  const s = await state();
  assert.equal(s.order.status, 6n);
  assert.deepEqual(s.balances, [1000n, 0n, 0n, 0n]);
});

test('refund uses the amended deadline and returns all 180, including the supplement', async () => {
  await activate();
  assert.equal(await apply(await ready()), true);
  await mineAt(terms.deadline);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_EXPIRED/);
  const o = await core.getOrder(orderId);
  await mineAt(o.terms.deadline - 1n);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_EXPIRED/);
  await mineAt(o.terms.deadline);
  await assert.rejects(core.connect(provider).submit.staticCall(orderId, o.revision, o.termsHash, resultHash), /ORDER_DEADLINE/);
  const receipt = await send(core.connect(outsider).refundExpiredOrder(orderId));
  const refund = logs(receipt).find(l => l.name === 'OrderRefunded');
  assert.equal(refund.args.amount, 180n);
  assert.equal(refund.args.finalStatus, 6n);
  assert.equal(await token.balanceOf(buyer.address), 1000n);
  assert.equal(await token.balanceOf(outsider.address), 0n);
  await assert.rejects(core.refundExpiredOrder.staticCall(orderId), /NOT_REFUNDABLE/);
});

test('on-time delivery prevents timeout refunds; buyer can accept after the delivery deadline', async () => {
  await activate();
  const delivery = await submit();
  await mineAt(terms.deadline);
  await assert.rejects(core.connect(buyer).refundExpiredOrder.staticCall(orderId), /NOT_REFUNDABLE/);
  await assert.rejects(core.connect(outsider).refundExpiredOrder.staticCall(orderId), /NOT_REFUNDABLE/);
  await assert.rejects(core.cancelOfferedOrder.staticCall(orderId), /NOT_OFFERED/);
  await send(core.acceptDelivery(...delivery));
  assert.equal(await token.balanceOf(provider.address), 100n);
});

for (const terminal of ['accepted', 'refunded']) test(`pending amendment cannot resurrect a ${terminal} order`, async () => {
  await activate();
  const pending = await ready();
  if (terminal === 'accepted') await send(core.acceptDelivery(...await submit()));
  else { await mineAt(terms.deadline); await send(core.refundExpiredOrder(orderId)); }
  const before = await state();
  assert.equal(await apply(pending), false);
  assert.deepEqual(await state(), before);
});

test('a failed payout rolls back acceptance, escrow and token movements; buyer can retry', async () => {
  await activate();
  const delivery = await submit();
  const receipt = await assertFailedTransfer(options => core.acceptDelivery(...delivery, options));
  assert.equal(logs(receipt).find(l => l.name === 'OrderPaid').args.amount, 100n);
  assert.equal(await token.balanceOf(provider.address), 100n);
});

for (const path of ['cancel', 'expire']) test(`${path} refund rolls back on token failure and permits retry`, async () => {
  if (path === 'expire') { await activate(); await mineAt(terms.deadline); }
  const operation = path === 'cancel'
    ? options => core.cancelOfferedOrder(orderId, options)
    : options => core.connect(outsider).refundExpiredOrder(orderId, options);
  await assertFailedTransfer(operation);
  assert.equal(await token.balanceOf(buyer.address), 1000n);
  assert.equal((await core.getOrder(orderId)).escrow, 0n);
});

test('token callback cannot reenter a permissionless refund on a second order', async () => {
  const second = id('second-expired-order');
  await send(core.offerOrder(second, provider.address, terms));
  await mineAt(terms.deadline);
  await send(token.setCallback(core.target, core.interface.encodeFunctionData('refundExpiredOrder', [second])));
  await send(core.connect(outsider).refundExpiredOrder(orderId));
  assert.equal(await token.callbackSucceeded(), false);
  assert.equal((await core.getOrder(second)).status, 1n);
  assert.equal((await core.getOrder(second)).escrow, 100n);
  assert.equal(await token.balanceOf(core.target), 100n);
});

test('payout preserves another order escrow, which can be separately refunded', async () => {
  const second = id('second-offer');
  await send(core.offerOrder(second, provider.address, { ...terms, totalPrice: 70n }));
  await activate();
  assert.equal(await apply(await ready()), true);
  await send(core.acceptDelivery(...await submit()));
  assert.equal(await token.balanceOf(core.target), 70n);
  assert.equal((await core.getOrder(second)).escrow, 70n);
  await send(core.cancelOfferedOrder(second));
  assert.deepEqual((await state()).balances, [820n, 180n, 0n, 0n]);
});

test('unknown orders have no refundable balance and cannot be accepted or cancelled', async () => {
  const unknown = id('unknown-order');
  await assert.rejects(core.refundExpiredOrder.staticCall(unknown), /NOT_REFUNDABLE/);
  await assert.rejects(core.cancelOfferedOrder.staticCall(unknown), /BUYER/);
  await assert.rejects(core.acceptDelivery.staticCall(unknown, 0n, hashTerms(terms), resultHash), /BUYER/);
});
