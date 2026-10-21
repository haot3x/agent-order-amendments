import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, MaxUint256, ZeroHash, id } from 'ethers';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';
import { localEvm } from '../scripts/local-evm.mjs';
import { STATE_ABI, INTENT_TYPES, ACCEPTANCE_TYPES, readAmendmentState, constructAmendment, termsHash } from '../examples/independent-client.mjs';

let env, client, token, core, buyer, provider, outsider, accounts, orderId, initial, snapshot;
const send = async promise => (await promise).wait();
const read = (oid=orderId,address=core.target,blockNumber) => readAmendmentState(client,address,oid,blockNumber);
const mineAt = async time => {
  await env.rpc.send('evm_setNextBlockTimestamp',[Number(time)]);
  await env.rpc.send('evm_mine',[]);
};
before(async()=>{
  env=await localEvm(compile(['contracts/test/IndependentStateFixture.sol']));
  client=createPublicClient({transport:http(env.url)});
  [buyer,provider,outsider]=env.signers;
  accounts=env.wallets.slice(0,2).map(w=>privateKeyToAccount(w.privateKey));
  token=await env.deploy('TestToken');
  core=await env.deploy('ExperimentalOrderAmendments',[token.target]);
  orderId=id('common-state-order');
  initial={scopeHash:id('initial-scope'),acceptanceHash:id('initial-criteria'),totalPrice:100n,deadline:2000010000n};
  await send(token.mint(buyer.address,1000n));
  await send(token.approve(core.target,MaxUint256));
  await send(core.offerOrder(orderId,provider.address,initial));
  await send(core.connect(provider).activateOrder(orderId));
  snapshot=await env.rpc.send('evm_snapshot',[]);
});
after(async()=>{if(env)await env.close()});
beforeEach(async()=>{
  await env.rpc.send('evm_revert',[snapshot]);
  snapshot=await env.rpc.send('evm_snapshot',[]);
});

async function candidate(state=undefined) {
  state ??= await read();
  const now=BigInt((await env.rpc.getBlock('latest')).timestamp);
  return constructAmendment({address:core.target,chainId:31337,orderId,state,
    newTerms:{...state.terms,scopeHash:id('expanded-scope'),totalPrice:state.terms.totalPrice+80n,deadline:state.terms.deadline+10000n},
    agentId:buyer.address,intentNonce:(await core.getAgentNonce(buyer.address))+1n,
    expiry:now+5000n,validUntil:now+5000n,timestamp:now});
}
async function consent(p) {
  const signature=await accounts[0].signTypedData({domain:p.domain,types:INTENT_TYPES,primaryType:'AgentIntent',message:p.intent});
  assert.equal(await core.getIntentHash(p.intent),p.intentHash);
  assert.equal(await core.getTypedDataDigest(p.intentHash),p.digest);
  await send(core.proposeCoordination(p.intent,signature,p.payload));
  for(let i=0;i<2;i++){
    const acceptance=p.acceptance(accounts[i].address);
    const signature=await accounts[i].signTypedData({domain:p.domain,types:ACCEPTANCE_TYPES,primaryType:'AcceptanceAttestation',message:acceptance});
    await send(core.connect(env.signers[i]).acceptCoordination(p.intentHash,{...acceptance,signature}));
  }
}
async function execute(p) {
  const receipt=await send(core.connect(outsider).executeCoordination(p.intentHash,p.payload,'0x',{gasLimit:2000000}));
  const events=receipt.logs.filter(l=>l.address.toLowerCase()===core.target.toLowerCase()).map(l=>core.interface.parseLog(l));
  return {events,outcome:events.find(e=>e.name==='CoordinationExecuted')};
}

test('public getter ABI agrees with the separately declared client ABI',async()=>{
  const declared=new Interface(STATE_ABI).getFunction('getAmendmentState');
  const implemented=core.interface.getFunction('getAmendmentState');
  assert.equal(implemented.selector,declared.selector);
  assert.deepEqual(implemented.outputs.map(p=>p.format('full')),declared.outputs.map(p=>p.format('full')));
  const state=await read();
  assert.equal(state.buyer,buyer.address);
  assert.equal(state.provider,provider.address);
  assert.equal(state.paymentAsset,token.target);
  assert.equal(state.revision,0n);
  assert.equal(state.amendmentNonce,0n);
  assert.deepEqual(state.terms,initial);
  assert.equal(state.termsHash,termsHash(initial));
  assert.equal(state.eligible,true);
});

test('unknown and zero order IDs revert with the common UnknownOrder error',async()=>{
  for(const oid of [id('unknown-order'),ZeroHash]){
    await assert.rejects(read(oid),error=>{
      const reverted=error.walk?.(cause=>cause.name==='ContractFunctionRevertedError');
      assert.equal(reverted?.data?.errorName,'UnknownOrder');
      assert.deepEqual(reverted.data.args,[oid]);
      return true;
    });
  }
});

test('deadline equality is ineligible while complete current state stays readable',async()=>{
  await mineAt(initial.deadline-1n);
  assert.equal((await read()).eligible,true);
  await mineAt(initial.deadline);
  const state=await read();
  assert.equal(state.eligible,false);
  assert.deepEqual(state.terms,initial);
  assert.equal(state.termsHash,termsHash(initial));
  assert.throws(()=>constructAmendment({state}),/ORDER_INELIGIBLE/);
});

test('offered, cancelled, submitted, accepted and refunded orders remain readable but ineligible',async()=>{
  const offered=id('unactivated');
  await send(core.offerOrder(offered,provider.address,initial));
  assert.equal((await read(offered)).eligible,false);
  await send(core.cancelOfferedOrder(offered));
  assert.equal((await read(offered)).eligible,false);
  const delivered=id('delivered-bytes');
  await send(core.connect(provider).submit(orderId,0,termsHash(initial),delivered));
  assert.equal((await read()).eligible,false);
  await send(core.acceptDelivery(orderId,0,termsHash(initial),delivered));
  assert.equal((await read()).eligible,false);
  const timedOut=id('timed-out');
  await send(core.offerOrder(timedOut,provider.address,initial));
  await send(core.connect(provider).activateOrder(timedOut));
  await mineAt(initial.deadline);
  await send(core.refundExpiredOrder(timedOut));
  const state=await read(timedOut);
  assert.equal(state.eligible,false);
  assert.equal(state.buyer,buyer.address);
  assert.deepEqual(state.terms,initial);
});

test('a block-pinned read and a current read distinguish explicit invalidation',async()=>{
  const before=await read();
  const blockNumber=await client.getBlockNumber({cacheTime:0});
  await send(core.connect(provider).invalidateAmendments(orderId));
  const current=await read();
  assert.equal(current.revision,before.revision);
  assert.equal(current.amendmentNonce,before.amendmentNonce+1n);
  assert.equal(current.termsHash,before.termsHash);
  assert.equal(current.eligible,true);
  assert.deepEqual(await read(orderId,core.target,blockNumber),before);
});

test('independent viem client reads, constructs, signs and applies an amendment through the common view',async()=>{
  const before=await read();
  const p=await candidate(before);
  await consent(p);
  const {events,outcome}=await execute(p);
  assert.equal(outcome.args.success,true);
  const applied=events.find(e=>e.name==='OrderAmendmentApplied');
  const state=await read();
  assert.equal(applied.args.revision,state.revision);
  assert.equal(applied.args.newTermsHash,state.termsHash);
  assert.equal(applied.args.supplement,80n);
  assert.equal(state.revision,before.revision+1n);
  assert.equal(state.amendmentNonce,before.amendmentNonce+1n);
  assert.deepEqual(state.terms,p.data.newTerms);
  assert.equal(await token.balanceOf(core.target),180n);
  await mineAt(initial.deadline+1n);
  assert.equal((await read()).eligible,true); // the amended deadline is authoritative
});

test('a successful read does not reserve its nonce against later invalidation',async()=>{
  const p=await candidate();
  await send(core.connect(provider).invalidateAmendments(orderId));
  await consent(p);
  const before=await read();
  const {events,outcome}=await execute(p);
  assert.equal(outcome.args.success,false);
  assert.equal(events.some(e=>e.name==='OrderAmendmentApplied'),false);
  assert.deepEqual(await read(),before);
  assert.equal(await token.balanceOf(core.target),100n);
});

test('eligible=true does not promise funding and a failed supplement leaves the view unchanged',async()=>{
  await send(token.approve(core.target,0));
  const before=await read();
  assert.equal(before.eligible,true);
  const p=await candidate(before);
  await consent(p);
  assert.equal((await execute(p)).outcome.args.success,false);
  assert.deepEqual(await read(),before);
  assert.equal(await token.balanceOf(core.target),100n);
});

test('the same client reads a separately implemented storage fixture with no getOrder or hash helpers',async()=>{
  const oid=id('alternate-layout');
  const otherTerms={...initial,totalPrice:321n,scopeHash:id('different-storage')};
  const other=await env.deploy('IndependentStateFixture',[oid,provider.address,buyer.address,token.target,otherTerms]);
  const state=await read(oid,other.target);
  assert.equal(state.buyer,provider.address);
  assert.equal(state.provider,buyer.address);
  assert.equal(state.revision,7n);
  assert.equal(state.amendmentNonce,11n);
  assert.deepEqual(state.terms,otherTerms);
  const p=constructAmendment({address:other.target,chainId:31337,orderId:oid,state,
    newTerms:{...otherTerms,totalPrice:400n},agentId:provider.address,intentNonce:1n,
    expiry:2000005000n,validUntil:2000005000n,timestamp:2000000000n});
  assert.equal(p.data.baseRevision,7n);
  assert.equal(p.data.amendmentNonce,11n);
  assert.equal(p.data.baseTermsHash,state.termsHash);
});
