import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {id, MaxUint256, toQuantity} from 'ethers';
import {localEvm} from '../scripts/local-evm.mjs';
import {domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES} from '../src/profile.mjs';

// Bounded local state/fee experiments, not a network throughput benchmark.
let env, token, core, buyer, provider, executor, buyerKey, providerKey, snapshot;
const orderId = id('bursts-and-fees');
const initialTerms = {scopeHash:id('report-0'),acceptanceHash:id('criteria'),totalPrice:100n,deadline:2000100000n};
const initialBalance = 10000n;
const GWEI = 10n ** 9n;
const send = async promise => (await promise).wait();
const logsAt = (receipt, contract) => receipt.logs
  .filter(l => l.address.toLowerCase() === contract.target.toLowerCase())
  .map(l => contract.interface.parseLog(l));

before(async () => {
  env = await localEvm();
  [buyer, provider, executor] = env.signers; [buyerKey, providerKey] = env.wallets;
  token = await env.deploy('TestToken');
  core = await env.deploy('ExperimentalOrderAmendments', [token.target]);
  await send(token.mint(buyer.address, initialBalance));
  await send(token.approve(core.target, MaxUint256));
  await send(core.offerOrder(orderId, provider.address, initialTerms));
  await send(core.connect(provider).activateOrder(orderId));
  snapshot = await env.rpc.send('evm_snapshot', []);
});
after(async () => { if (env) await env.close(); });
beforeEach(async () => {
  await env.rpc.send('anvil_dropAllTransactions', []);
  await env.rpc.send('evm_setAutomine', [true]);
  assert.equal(await env.rpc.send('evm_revert', [snapshot]), true);
  snapshot = await env.rpc.send('evm_snapshot', []);
});

async function state() {
  return {
    order:(await core.getOrder(orderId)).toObject(true),
    view:(await core.getAmendmentState(orderId)).toObject(true),
    buyer:await token.balanceOf(buyer.address),
    held:await token.balanceOf(core.target),
    provider:await token.balanceOf(provider.address),
    allowance:await token.allowance(buyer.address, core.target),
  };
}

async function ready({price, scope, expiry = 2000090000n, validUntil = 2000095000n} = {}) {
  const o = await core.getOrder(orderId);
  const terms = {...initialTerms, totalPrice:price ?? o.terms.totalPrice + 5n,
    scopeHash:scope ?? id(`report-${o.revision + 1n}`)};
  const payload = buildPayload({orderContract:core.target,orderId,baseRevision:o.revision,
    baseTermsHash:o.termsHash,amendmentNonce:o.amendmentNonce,newTermsHash:hashTerms(terms),
    newTerms:terms,validUntil},2000000000n);
  const intent = buildIntent({payload,expiry,nonce:await core.getAgentNonce(buyer.address) + 1n,
    agentId:buyer.address,participants:[buyer.address,provider.address]});
  const unchanged = await state();
  const preparation = [await send(core.proposeCoordination(intent,
    await buyerKey.signTypedData(domain(core.target),INTENT_TYPES,intent),payload))];
  const h = hashIntent(intent);
  for (const [signer, key] of [[buyer,buyerKey],[provider,providerKey]]) {
    const acceptance = buildAcceptance(intent,signer.address);
    preparation.push(await send(core.connect(signer).acceptCoordination(h,{...acceptance,
      signature:await key.signTypedData(domain(core.target),ACCEPTANCE_TYPES,acceptance)})));
  }
  // Even full consent does not reserve/debit the supplement or activate terms.
  assert.deepEqual(await state(), unchanged);
  assert.equal((await core.getCoordinationStatus(h)).status, 2n);
  return {h,payload,terms,preparation};
}

function outcome(receipt, p, expectedSuccess, supplement) {
  assert.equal(Number(receipt.status), 1); // Outer success is not application success.
  const logs = logsAt(receipt,core);
  const executed = logs.filter(l => l.name === 'CoordinationExecuted');
  assert.equal(executed.length,1);
  assert.equal(executed[0].args.intentHash,p.h);
  assert.equal(executed[0].args.success,expectedSuccess);
  const applied = logs.filter(l => l.name === 'OrderAmendmentApplied');
  const transfers = logsAt(receipt,token).filter(l => l.name === 'Transfer');
  assert.equal(applied.length,expectedSuccess ? 1 : 0);
  assert.equal(transfers.length,expectedSuccess ? 1 : 0);
  if (expectedSuccess) {
    assert.equal(applied[0].args.supplement,supplement);
    assert.equal(transfers[0].args.from,buyer.address);
    assert.equal(transfers[0].args.to,core.target);
    assert.equal(transfers[0].args.value,supplement);
  }
  return executed[0];
}

async function execute(p) {
  return send(core.connect(executor).executeCoordination(p.h,p.payload,'0x',{gasLimit:2000000}));
}

async function assertApplied(p, revision) {
  const s = await state();
  assert.equal(s.order.revision,revision);
  assert.equal(s.order.amendmentNonce,revision);
  assert.equal(s.order.termsHash,hashTerms(p.terms));
  assert.equal(s.order.escrow,p.terms.totalPrice);
  assert.equal(s.held,p.terms.totalPrice);
  assert.equal(s.buyer,initialBalance - p.terms.totalPrice);
  assert.equal(s.provider,0n);
  assert.equal(s.view.revision,revision);
  assert.equal(s.view.termsHash,hashTerms(p.terms));
}

function range(values) {
  const numbers = values.map(Number);
  return {min:Math.min(...numbers),max:Math.max(...numbers)};
}

test('32 consecutive signed revisions conserve escrow and collect only each supplement',async t => {
  const samples = [];
  for (let i = 1; i <= 32; i++) {
    const p = await ready();
    const receipt = await execute(p);
    outcome(receipt,p,true,5n);
    await assertApplied(p,BigInt(i));
    samples.push({revision:i,propose:Number(p.preparation[0].gasUsed),
      acceptBuyer:Number(p.preparation[1].gasUsed),acceptProvider:Number(p.preparation[2].gasUsed),
      execute:Number(receipt.gasUsed),
      total:Number(receipt.gasUsed + p.preparation.reduce((sum,r) => sum + r.gasUsed,0n))});
  }
  assert.equal((await state()).held,260n);
  t.diagnostic(JSON.stringify({scenario:'32 consecutive revisions',first:samples[0],last:samples.at(-1),
    executeGas:range(samples.map(s => s.execute)),fourTransactionGas:range(samples.map(s => s.total))}));
});

test('eight Ready candidates mined in one block apply exactly one revision and one supplement',async t => {
  const candidates = [];
  for (let i = 0; i < 8; i++) candidates.push(await ready({price:110n + BigInt(i),scope:id(`candidate-${i}`)}));
  const unchanged = await state();
  await env.rpc.send('evm_setAutomine',[false]);
  const startNonce = BigInt(await env.rpc.send('eth_getTransactionCount',[executor.address,'latest']));
  const hashes = [];
  for (let i = 0; i < candidates.length; i++) {
    hashes.push(await queue(candidates[i],startNonce + BigInt(i),200n * GWEI));
  }
  assert.deepEqual(await state(),unchanged);
  await mineWithBaseFee(GWEI);
  const receipts = await Promise.all(hashes.map(receiptFor));
  assert.equal(new Set(receipts.map(r => r.blockHash)).size,1);
  for (let i = 0; i < receipts.length; i++) {
    assert.equal(Number(receipts[i].transactionIndex),i);
    const result = outcome(receipts[i],candidates[i],i === 0,10n);
    if (i > 0) assert(result.args.result.includes(Buffer.from('STALE_REVISION').toString('hex')));
    assert.equal((await core.getCoordinationStatus(candidates[i].h)).status,3n);
  }
  await assertApplied(candidates[0],1n);
  t.diagnostic(JSON.stringify({scenario:'eight competing candidates in one block',
    successGas:Number(BigInt(receipts[0].gasUsed)),staleAttemptGas:range(receipts.slice(1).map(r => BigInt(r.gasUsed)))}));
});

test('four interleaved funding failures and fresh-consent retries never advance a partial revision',async t => {
  const failedGas = [];
  for (let i = 1; i <= 4; i++) {
    const p = await ready();
    await send(token.setFailAfterTransfer(true));
    const unchanged = await state();
    const failure = await execute(p);
    outcome(failure,p,false);
    assert.deepEqual(await state(),unchanged);
    assert.equal((await core.getCoordinationStatus(p.h)).status,3n);
    await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
    failedGas.push(failure.gasUsed);
    await send(token.setFailAfterTransfer(false));
    const retry = await ready();
    assert.notEqual(retry.h,p.h);
    outcome(await execute(retry),retry,true,5n);
    await assertApplied(retry,BigInt(i));
  }
  t.diagnostic(JSON.stringify({scenario:'four failed transfers followed by fresh consent',failedAttemptGas:range(failedGas)}));
});

// Explicit EIP-1559 fee caps and manual mining make the queue/expiry boundaries
// deterministic. These RPC controls do not model a public mempool or inclusion SLA.
async function queue(p, nonce, maxFeePerGas, maxPriorityFeePerGas = GWEI) {
  return env.rpc.send('eth_sendTransaction',[{from:executor.address,to:core.target,
    data:core.interface.encodeFunctionData('executeCoordination',[p.h,p.payload,'0x']),
    nonce:toQuantity(nonce),gas:toQuantity(2000000),type:'0x2',
    maxFeePerGas:toQuantity(maxFeePerGas),maxPriorityFeePerGas:toQuantity(maxPriorityFeePerGas)}]);
}
async function mineWithBaseFee(baseFee, timestamp) {
  await env.rpc.send('anvil_setNextBlockBaseFeePerGas',[toQuantity(baseFee)]);
  if (timestamp !== undefined) await env.rpc.send('evm_setNextBlockTimestamp',[Number(timestamp)]);
  await env.rpc.send('evm_mine',[]);
  assert.equal((await env.rpc.getBlock('latest')).baseFeePerGas,baseFee);
}
async function receiptFor(hash) {
  const receipt = await env.rpc.send('eth_getTransactionReceipt',[hash]);
  assert(receipt,`Expected mined receipt for ${hash}`);
  return receipt;
}

test('1 versus 100 gwei base fee changes the executor cost, not gas units or the token supplement',async t => {
  const p = await ready({price:180n});
  await env.rpc.send('evm_setAutomine',[false]);
  const beforeExecution = await env.rpc.send('evm_snapshot',[]);
  const samples = [];
  for (const baseFee of [GWEI,100n * GWEI]) {
    const ethBefore = await env.rpc.getBalance(executor.address);
    const nonce = await env.rpc.send('eth_getTransactionCount',[executor.address,'latest']);
    const hash = await queue(p,BigInt(nonce),200n * GWEI);
    await mineWithBaseFee(baseFee);
    const receipt = await receiptFor(hash);
    outcome(receipt,p,true,80n);
    await assertApplied(p,1n);
    const gasUsed = BigInt(receipt.gasUsed), effectiveGasPrice = BigInt(receipt.effectiveGasPrice);
    assert.equal(effectiveGasPrice,baseFee + GWEI);
    const fee = gasUsed * effectiveGasPrice;
    assert.equal(ethBefore - await env.rpc.getBalance(executor.address),fee);
    samples.push({baseFee,gasUsed,effectiveGasPrice,fee});
    if (baseFee === GWEI) assert.equal(await env.rpc.send('evm_revert',[beforeExecution]),true);
  }
  assert.equal(samples[0].gasUsed,samples[1].gasUsed);
  assert(samples[1].fee > samples[0].fee);
  t.diagnostic(JSON.stringify({scenario:'same amendment at two base fees',samples},(_,v) => typeof v === 'bigint' ? v.toString() : v));
});

async function delayed(p) {
  await env.rpc.send('evm_setAutomine',[false]);
  await mineWithBaseFee(GWEI);
  const nonce = BigInt(await env.rpc.send('eth_getTransactionCount',[executor.address,'latest']));
  const unchanged = await state();
  const ethBefore = await env.rpc.getBalance(executor.address);
  const hash = await queue(p,nonce,2n * GWEI);
  const pending = await env.rpc.send('eth_getTransactionByHash',[hash]);
  assert(pending); assert.equal(pending.blockNumber,null);
  // The cap was adequate when queued, then the next block's base fee rises.
  await mineWithBaseFee(100n * GWEI);
  assert.equal(await env.rpc.send('eth_getTransactionReceipt',[hash]),null);
  // This pinned Anvil drops the underpriced transaction during mining. Public
  // clients may retain it; neither behavior reserves the on-chain supplement.
  assert.equal(BigInt(await env.rpc.send('eth_getTransactionCount',[executor.address,'latest'])),nonce);
  assert.deepEqual(await state(),unchanged);
  assert.equal((await core.getCoordinationStatus(p.h)).status,2n);
  assert.equal(await env.rpc.getBalance(executor.address),ethBefore);
  return {nonce,hash,unchanged,ethBefore};
}

test('fee-spike delay locks no supplement; a fee-bumped resubmission applies the same signed intent once',async () => {
  const p = await ready({price:180n});
  const pending = await delayed(p);
  const replacement = await queue(p,pending.nonce,200n * GWEI,2n * GWEI);
  assert.notEqual(replacement,pending.hash);
  await mineWithBaseFee(100n * GWEI);
  const receipt = await receiptFor(replacement);
  outcome(receipt,p,true,80n);
  assert.equal(await env.rpc.send('eth_getTransactionReceipt',[pending.hash]),null);
  await assertApplied(p,1n);
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
});

test('fee-delayed execution mined at signed expiry reverts without collecting a supplement',async t => {
  const now = BigInt((await env.rpc.getBlock('latest')).timestamp);
  const expiry = now + 120n;
  const p = await ready({price:180n,expiry});
  const pending = await delayed(p);
  const replacement = await queue(p,pending.nonce,200n * GWEI,2n * GWEI);
  await mineWithBaseFee(100n * GWEI,expiry);
  const receipt = await receiptFor(replacement);
  assert.equal(Number(receipt.status),0);
  assert.equal(receipt.logs.length,0);
  assert.deepEqual(await state(),pending.unchanged);
  assert.equal((await core.getCoordinationStatus(p.h)).status,5n);
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/EXPIRED/);
  const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  assert(fee > 0n);
  assert.equal(pending.ethBefore - await env.rpc.getBalance(executor.address),fee);
  t.diagnostic(JSON.stringify({scenario:'expired transaction still pays gas',gasUsed:Number(BigInt(receipt.gasUsed)),feeWei:fee.toString()}));
});
