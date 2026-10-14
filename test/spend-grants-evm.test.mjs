import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {getCreateAddress, id, MaxUint256} from 'ethers';
import {compile} from '../scripts/compile.mjs';
import {compileSpendGrants} from '../scripts/compile-spend-grants.mjs';
import {localEvm} from '../scripts/local-evm.mjs';
import {
  domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance,
  INTENT_TYPES, ACCEPTANCE_TYPES,
} from '../src/profile.mjs';

let env, token, core, registry, executor, buyer, provider, outsider, buyerKey, providerKey;
let grantId, grantTerms, snapshot;
const orderId = id('grant-funded-order');
const otherOrderId = id('earlier-grant-funded-order');
const baseTerms = {scopeHash: id('three-projects'), acceptanceHash: id('report'), totalPrice: 100n, deadline: 2000010000n};
const send = async promise => (await promise).wait();
const logsAt = (receipt, contract) => receipt.logs
  .filter(log => log.address.toLowerCase() === contract.target.toLowerCase())
  .map(log => contract.interface.parseLog(log));

before(async () => {
  env = await localEvm({
    ...compile(['contracts/test/SpendGrantOrderFixture.sol']),
    ...compileSpendGrants(),
  });
  [buyer, provider, outsider] = env.signers;
  [buyerKey, providerKey] = env.wallets;
  token = await env.deploy('SpendGrantTestToken');
  const nonce = await env.rpc.getTransactionCount(buyer.address);
  const predictedExecutor = getCreateAddress({from: buyer.address, nonce: nonce + 1});
  registry = await env.deploy('SpendGrantRegistry', [predictedExecutor]);
  executor = await env.deploy('SpendGrantExecutor', [registry.target]);
  assert.equal(executor.target, predictedExecutor);
  core = await env.deploy('SpendGrantOrderFixture', [token.target, buyer.address, registry.target]);

  grantTerms = {
    principal: buyer.address, delegate: core.target, recipientMode: 0, recipient: core.target,
    assetCombine: 0, windowSeconds: 60n,
    assets: [{asset: token.target, maxPerCall: 1000n, maxPerWindow: 1000n, maxTotal: 1000n}],
    validAfter: 2000000000n, validUntil: 2000100000n, salt: 1n,
  };
  grantId = await registry.hashGrant(grantTerms);
  await send(registry.register(grantTerms));
  await send(core.bindFundingGrant(grantId));
  await send(token.mint(buyer.address, 2000n));
  // Only the pinned grant executor has a token allowance. The order contract
  // cannot fall back to pulling tokens directly from the buyer.
  await send(token.approve(executor.target, MaxUint256));
  assert.equal(await token.allowance(buyer.address, core.target), 0n);
  for (const [oid, totalPrice] of [[otherOrderId, 600n], [orderId, 100n]]) {
    await send(core.offerOrder(oid, provider.address, {...baseTerms, totalPrice}));
    await send(core.connect(provider).activateOrder(oid));
  }
  assert.equal((await registry.usage(grantId, token.target)).spent, 700n);
  // Let the setup debits leave the rolling window so the tightened lifetime
  // cap, rather than a window cap, is the reason the 80 supplement fails.
  const now = (await env.rpc.getBlock('latest')).timestamp;
  await env.rpc.send('evm_setNextBlockTimestamp', [now + 61]);
  await env.rpc.send('evm_mine', []);
  snapshot = await env.rpc.send('evm_snapshot', []);
});
after(async () => { if (env) await env.close(); });
beforeEach(async () => {
  await env.rpc.send('evm_revert', [snapshot]);
  snapshot = await env.rpc.send('evm_snapshot', []);
});

async function updateCap(maxTotal) {
  const current = await registry.getGrant(grantId);
  await send(registry.update(grantId, current.version, {
    ...grantTerms, assets: [{...grantTerms.assets[0], maxPerCall: maxTotal, maxPerWindow: maxTotal, maxTotal}],
  }));
}
async function propose(oid = orderId, totalPrice) {
  const order = await core.getOrder(oid);
  const terms = {...baseTerms, scopeHash: id('expanded-scope'), totalPrice: totalPrice ?? order.terms.totalPrice + 80n, deadline: 2000020000n};
  const payload = buildPayload({
    orderContract: core.target, orderId: oid, baseRevision: order.revision,
    baseTermsHash: order.termsHash, amendmentNonce: order.amendmentNonce,
    newTermsHash: hashTerms(terms), newTerms: terms, validUntil: 2000009000n,
  }, 2000000000n);
  const intent = buildIntent({
    payload, expiry: 2000008000n, nonce: await core.getAgentNonce(buyer.address) + 1n,
    agentId: buyer.address, participants: [buyer.address, provider.address],
  });
  const signature = await buyerKey.signTypedData(domain(core.target), INTENT_TYPES, intent);
  await send(core.proposeCoordination(intent, signature, payload));
  return {oid, payload, intent, h: hashIntent(intent)};
}
async function acceptance(p, signer, key) {
  const message = buildAcceptance(p.intent, signer.address);
  return {...message, signature: await key.signTypedData(domain(core.target), ACCEPTANCE_TYPES, message)};
}
async function acceptBoth(p) {
  for (const [signer, key] of [[buyer, buyerKey], [provider, providerKey]]) {
    await send(core.connect(signer).acceptCoordination(p.h, await acceptance(p, signer, key)));
  }
  return p;
}
async function ready(oid = orderId, totalPrice) { return acceptBoth(await propose(oid, totalPrice)); }
async function execute(p) {
  const receipt = await send(core.connect(outsider).executeCoordination(p.h, p.payload, '0x', {gasLimit: 3000000}));
  const logs = logsAt(receipt, core);
  return {receipt, logs, outcome: logs.find(log => log.name === 'CoordinationExecuted')};
}
async function state() {
  return {
    target: (await core.getOrder(orderId)).toObject(true),
    other: (await core.getOrder(otherOrderId)).toObject(true),
    usage: (await registry.usage(grantId, token.target)).toObject(true),
    rolling: (await registry.rollingUsage(grantId, token.target)).toObject(true),
    buyerBalance: await token.balanceOf(buyer.address),
    held: await token.balanceOf(core.target),
    providerBalance: await token.balanceOf(provider.address),
    allowance: await token.allowance(buyer.address, executor.target),
  };
}
async function assertFailed(p, expectedState, reason) {
  const result = await execute(p);
  assert.equal(result.outcome.args.success, false);
  if (reason !== undefined) {
    const error = registry.interface.parseError(result.outcome.args.result);
    assert.equal(error.name, 'SpendGrantError');
    assert.equal(error.args[0], BigInt(reason));
  }
  assert.deepEqual(await state(), expectedState);
  assert.equal(result.logs.some(log => log.name === 'OrderAmendmentApplied'), false);
  assert.equal(logsAt(result.receipt, registry).length, 0);
  assert.equal(logsAt(result.receipt, token).length, 0);
  assert.equal((await core.getCoordinationStatus(p.h)).status, 3n);
  return result;
}

test('8427: cap 1000 -> 800 retains usage 700 and atomically funds the 80 supplement', async () => {
  const p = await ready();
  await updateCap(800n);
  assert.equal((await registry.getGrant(grantId)).version, 2n);
  assert.equal((await registry.usage(grantId, token.target)).spent, 700n);
  const beforeState = await state();
  const result = await execute(p);
  assert.equal(result.outcome.args.success, true);
  const debit = logsAt(result.receipt, registry).find(log => log.name === 'GrantConsumed');
  assert.equal(debit.args.grantId, grantId);
  assert.equal(debit.args.amount, 80n);
  assert.equal(debit.args.recipient, core.target);
  const applied = result.logs.find(log => log.name === 'OrderAmendmentApplied');
  assert.equal(applied.args.supplement, 80n);
  const afterState = await state();
  assert.equal(afterState.usage.spent, 780n);
  assert.equal(afterState.target.revision, 1n);
  assert.equal(afterState.target.amendmentNonce, 1n);
  assert.equal(afterState.target.escrow, 180n);
  assert.equal(afterState.buyerBalance, beforeState.buyerBalance - 80n);
  assert.equal(afterState.held, beforeState.held + 80n);
  assert.deepEqual(afterState.other, beforeState.other);
});

test('8427: successful preflight does not reserve funds against a cap cut after consent', async () => {
  const p = await ready();
  assert.equal((await registry.check(grantId, core.target, token.target, 80n, core.target)).ok, true);
  await updateCap(750n);
  const check = await registry.check(grantId, core.target, token.target, 80n, core.target);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 10n);
  await assertFailed(p, await state(), 10);
  // The earlier, separate cap-update transaction is not undone by application failure.
  assert.equal((await registry.getGrant(grantId)).version, 2n);
});

test('8427: restoring capacity needs a fresh intent and fresh acceptance from both parties', async () => {
  const p = await ready();
  const oldProviderAcceptance = await acceptance(p, provider, providerKey);
  await updateCap(750n);
  await assertFailed(p, await state(), 10);
  await updateCap(800n);
  await assert.rejects(core.executeCoordination.staticCall(p.h, p.payload, '0x'), /NOT_READY/);
  const retry = await propose();
  assert.notEqual(retry.h, p.h);
  await send(core.acceptCoordination(retry.h, await acceptance(retry, buyer, buyerKey)));
  await assert.rejects(core.executeCoordination.staticCall(retry.h, retry.payload, '0x'), /NOT_READY/);
  await assert.rejects(core.connect(provider).acceptCoordination.staticCall(retry.h, oldProviderAcceptance), /ACCEPTANCE_BINDING/);
  await send(core.connect(provider).acceptCoordination(retry.h, await acceptance(retry, provider, providerKey)));
  assert.equal((await execute(retry)).outcome.args.success, true);
  assert.equal((await registry.usage(grantId, token.target)).spent, 780n);
  assert.equal((await core.getOrder(orderId)).revision, 1n);
});

test('8427: revocation after consent prevents the top-up and leaves the order intact', async () => {
  const p = await ready();
  await send(registry.revoke(grantId));
  await assertFailed(p, await state(), 5);
  assert.equal(await registry.revoked(grantId), true);
});

test('8427: token movement followed by false rolls back the upstream debit and token logs', async () => {
  const p = await ready();
  await send(token.setFailAfterTransfer(true));
  const result = await assertFailed(p, await state());
  assert.equal(executor.interface.parseError(result.outcome.args.result).name, 'TransferFailed');
});

test('8427: order balance check rolls back an already successful upstream spend on short delivery', async () => {
  const p = await ready();
  await send(token.setShortDelivery(true));
  const result = await assertFailed(p, await state());
  assert.equal(core.interface.parseError(result.outcome.args.result).args[0], 'RECEIVED_AMOUNT');
});

test('8427: two accepted orders share current grant usage rather than separate snapshots', async () => {
  const first = await ready();
  const second = await ready(otherOrderId);
  await updateCap(800n);
  assert.equal((await execute(first)).outcome.args.success, true);
  await assertFailed(second, await state(), 10);
  assert.equal((await registry.usage(grantId, token.target)).spent, 780n);
  assert.equal((await core.getOrder(otherOrderId)).revision, 0n);
});

test('8427: knowing the grant ID cannot bypass the delegate or charge another buyer', async () => {
  const beforeState = await state();
  await assert.rejects(executor.connect(outsider).spend.staticCall(grantId, token.target, 80n, core.target), /SpendGrantError/);
  await assert.rejects(core.connect(outsider).offerOrder.staticCall(id('attacker-order'), provider.address, baseTerms), /FUNDING_PRINCIPAL/);
  await assert.rejects(core.connect(outsider).bindFundingGrant.staticCall(grantId), /FUNDING_PRINCIPAL/);
  await assert.rejects(core.bindFundingGrant.staticCall(grantId), /GRANT_ALREADY_BOUND/);
  assert.deepEqual(await state(), beforeState);
});

test('8427: token callback cannot fund the accepted amendment twice', async () => {
  const p = await ready();
  await send(token.setCallback(core.target, core.interface.encodeFunctionData('executeCoordination', [p.h, p.payload, '0x'])));
  assert.equal((await execute(p)).outcome.args.success, true);
  assert.equal(await token.callbackSucceeded(), false);
  assert.equal((await registry.usage(grantId, token.target)).spent, 780n);
  assert.equal((await core.getOrder(orderId)).revision, 1n);
});

test('8427: revoking funding authority does not revoke a consented change with no extra payment', async () => {
  const p = await ready(orderId, 100n);
  await send(registry.revoke(grantId));
  const result = await execute(p);
  assert.equal(result.outcome.args.success, true);
  assert.equal(logsAt(result.receipt, registry).length, 0);
  assert.equal((await registry.usage(grantId, token.target)).spent, 700n);
  assert.equal((await core.getOrder(orderId)).revision, 1n);
  assert.equal((await core.getOrder(orderId)).escrow, 100n);
});
