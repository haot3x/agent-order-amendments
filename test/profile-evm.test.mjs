import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { id, MaxUint256, ZeroHash, Signature, TypedDataEncoder } from 'ethers';
import { localEvm } from '../scripts/local-evm.mjs';
import { domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES } from '../src/profile.mjs';

let env,token,core,buyer,provider,outsider,buyerKey,providerKey,orderId,baseTerms,snapshot;
const send=async promise=>{const tx=await promise;return tx.wait()};
before(async()=>{
  env=await localEvm();[buyer,provider,outsider]=env.signers;[buyerKey,providerKey]=env.wallets;
  token=await env.deploy('TestToken');core=await env.deploy('ExperimentalOrderAmendments',[token.target]);
  orderId=id('evm-order');baseTerms={scopeHash:id('three-projects'),acceptanceHash:id('report'),totalPrice:100n,deadline:2000010000n};
  await send(token.mint(buyer.address,500n));await send(token.approve(core.target,MaxUint256));
  await send(core.offerOrder(orderId,provider.address,baseTerms));await send(core.connect(provider).activateOrder(orderId));
  snapshot=await env.rpc.send('evm_snapshot',[]);
});
after(async()=>{if(env)await env.close()});
beforeEach(async()=>{await env.rpc.send('evm_revert',[snapshot]);snapshot=await env.rpc.send('evm_snapshot',[])});

async function proposal(options={}) {
  const oid=options.orderId??orderId;
  const o=await core.getOrder(oid);
  const terms=options.terms??{scopeHash:id('ten-projects'),acceptanceHash:o.terms.acceptanceHash,totalPrice:180n,deadline:2000020000n};
  const data={orderContract:core.target,orderId:oid,baseRevision:o.revision,baseTermsHash:o.termsHash,amendmentNonce:o.amendmentNonce,newTermsHash:hashTerms(terms),newTerms:terms,validUntil:2000009000n,...options.data};
  const payload=buildPayload(data,2000000000n);
  const intent=buildIntent({payload,expiry:options.expiry??2000008000n,nonce:await core.getAgentNonce(options.agentId??buyer.address)+1n,agentId:options.agentId??buyer.address,participants:options.participants??[o.buyer,o.provider]});
  const signature=await (options.initiatorKey??buyerKey).signTypedData(domain(core.target),INTENT_TYPES,intent);
  return {data,payload,intent,signature,h:hashIntent(intent)};
}
async function propose(p) {await send(core.proposeCoordination(p.intent,p.signature,p.payload));return p}
async function accept(p,participant,key,caller,expiry=p.intent.expiry) {
  const a=buildAcceptance(p.intent,participant,expiry);
  const signature=await key.signTypedData(domain(core.target),ACCEPTANCE_TYPES,a);
  await send(core.connect(caller).acceptCoordination(p.h,{...a,signature}));
}
async function ready(options={}) {
  const p=await propose(await proposal(options));
  await accept(p,buyer.address,buyerKey,buyer,options.acceptanceExpiry);
  await accept(p,provider.address,providerKey,provider,options.acceptanceExpiry);return p;
}
async function execute(p,extra='0x') {
  const r=await send(core.connect(outsider).executeCoordination(p.h,p.payload,extra,{gasLimit:2000000}));
  const logs=r.logs.filter(l=>l.address.toLowerCase()===core.target.toLowerCase()).map(l=>core.interface.parseLog(l));
  return {r,logs,event:logs.find(l=>l.name==='CoordinationExecuted')};
}
async function state(oid=orderId) {
  const o=await core.getOrder(oid);
  return {order:o.toObject(true),buyerBalance:await token.balanceOf(o.buyer),held:await token.balanceOf(core.target),allowance:await token.allowance(o.buyer,core.target)};
}
async function assertFailedApplication(p,beforeState,reason) {
  const r=await execute(p);assert.equal(r.event.args.success,false);
  assert.ok(r.event.args.result.includes(Buffer.from(reason).toString('hex')));
  assert.equal(r.logs.some(l=>l.name==='OrderAmendmentApplied'),false);
  assert.deepEqual(await state(),beforeState);
  assert.equal((await core.getCoordinationStatus(p.h)).status,3n);
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
}
async function mineAt(time) {await env.rpc.send('evm_setNextBlockTimestamp',[Number(time)]);await env.rpc.send('evm_mine',[])}

test('Solidity hashes agree with published vector and deployed EIP-712 domain',async()=>{
  const v=JSON.parse(await readFile(new URL('../vectors/order-amendment-v1.json',import.meta.url),'utf8'));
  assert.equal(await core.hashTerms(v.data.newTerms),v.expected.termsHash);
  assert.equal(await core.getPayloadHash(v.payload),v.expected.payloadHash);
  assert.equal(await core.getIntentHash(v.intent),v.expected.intentStructHash);
  for(const a of v.acceptances){
    assert.equal(await core.getAcceptanceHash({...a.message,signature:a.signature}),TypedDataEncoder.hashStruct('AcceptanceAttestation',ACCEPTANCE_TYPES,a.message));
  }
  const d=await core.eip712Domain();assert.equal(d.name,'ERC-8001');assert.equal(d.version,'1');assert.equal(d.chainId,31337n);assert.equal(d.verifyingContract,core.target);
  assert.equal(await core.getTypedDataDigest(v.expected.intentStructHash),TypedDataEncoder.hash(domain(core.target),INTENT_TYPES,v.intent));
});
test('100 -> 180 -> 220 funds only 80 then 40 using current revision and deadline',async()=>{
  const first=await ready();const r1=await execute(first);assert.equal(r1.event.args.success,true);
  assert.equal(r1.logs.find(l=>l.name==='OrderAmendmentApplied').args.supplement,80n);
  await mineAt(2000010001n); // Past original deadline, before amended deadline.
  const second=await ready({terms:{...first.data.newTerms,totalPrice:220n,deadline:2000030000n},expiry:2000018000n,data:{validUntil:2000019000n}});
  const r2=await execute(second);assert.equal(r2.event.args.success,true);
  assert.equal(r2.logs.find(l=>l.name==='OrderAmendmentApplied').args.supplement,40n);
  const s=await state();assert.equal(s.order.revision,2n);assert.equal(s.order.escrow,220n);assert.equal(s.buyerBalance,280n);assert.equal(s.held,220n);
});
for(const role of ['buyer','provider'])test(`${role} invalidates a Ready amendment without cancelling underlying order`,async()=>{
  const p=await ready();await send(core.connect(role==='buyer'?buyer:provider).invalidateAmendments(orderId));
  assert.equal((await core.getCoordinationStatus(p.h)).status,2n);
  await assertFailedApplication(p,await state(),'STALE_AMENDMENT_NONCE');
});
test('provider cannot use proposer-only Core cancellation; explicit order invalidation remains available',async()=>{
  const p=await ready();await assert.rejects(core.connect(provider).cancelCoordination.staticCall(p.h,'withdraw'),/NOT_PROPOSER/);
  await send(core.cancelCoordination(p.h,'withdraw'));assert.equal((await core.getCoordinationStatus(p.h)).status,4n);
  assert.equal((await core.getOrder(orderId)).status,2n);
});
test('two Ready candidates on same base revision: only one can apply',async()=>{
  const a=await ready();const b=await ready({terms:{...a.data.newTerms,totalPrice:200n}});
  assert.equal((await execute(a)).event.args.success,true);
  await assertFailedApplication(b,await state(),'STALE_REVISION');
});
test('funding failure rolls back order and token state; fresh signed intent can retry',async()=>{
  const p=await ready();await send(token.approve(core.target,0n));const before=await state();
  const result=await execute(p);assert.equal(result.event.args.success,false);
  assert.deepEqual(await state(),before);assert.equal((await core.getCoordinationStatus(p.h)).status,3n);
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
  await send(token.approve(core.target,MaxUint256));const retry=await ready();assert.notEqual(retry.h,p.h);
  assert.equal((await execute(retry)).event.args.success,true);
});
test('token transfer followed by failure is reverted, including intermediate ERC-20 movement',async()=>{
  const p=await ready();await send(token.setFailAfterTransfer(true));const before=await state();
  const result=await execute(p);assert.equal(result.event.args.success,false);assert.deepEqual(await state(),before);
  assert.equal(result.r.logs.some(l=>l.address.toLowerCase()===token.target.toLowerCase()),false);
});
test('insufficient balance cannot activate a larger revision',async()=>{
  const p=await ready({terms:{...baseTerms,totalPrice:600n,deadline:2000020000n}});const before=await state();
  assert.equal((await execute(p)).event.args.success,false);assert.deepEqual(await state(),before);
});
test('unsigned executionData and substituted payload are rejected without consuming Ready intent',async()=>{
  const p=await ready(),before=await state();
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x1234'),/UNSIGNED_EXECUTION_DATA/);
  const changed=buildPayload({...p.data,newTerms:{...p.data.newTerms,totalPrice:999n}},2000000000n);
  await assert.rejects(core.executeCoordination.staticCall(p.h,changed,'0x'),/PAYLOAD_HASH/);
  assert.equal((await core.getCoordinationStatus(p.h)).status,2n);assert.deepEqual(await state(),before);
  assert.equal((await execute(p)).event.args.success,true);
});
test('submission binds revision and freezes a previously Ready amendment',async()=>{
  const p=await ready();await assert.rejects(core.connect(provider).submit.staticCall(orderId,1,hashTerms(baseTerms),id('result')),/SUBMISSION_BINDING/);
  await send(core.connect(provider).submit(orderId,0,hashTerms(baseTerms),id('result')));
  await assertFailedApplication(p,await state(),'ORDER_INACTIVE');
});
for(const which of ['intent','acceptance','amendment','order'])test(`expiry equality: ${which} is not executable at its deadline`,async()=>{
  const at=2000005000n;
  const opts=which==='intent'?{expiry:at}:which==='acceptance'?{acceptanceExpiry:at}:which==='amendment'?{data:{validUntil:at}}:{expiry:2000030000n,data:{validUntil:2000030000n}};
  const p=await ready(opts);await mineAt(which==='order'?baseTerms.deadline:at);const before=await state();
  if(which==='intent'||which==='acceptance'){
    await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/EXPIRED/);
    assert.equal((await core.getCoordinationStatus(p.h)).status,5n);assert.deepEqual(await state(),before);
  } else await assertFailedApplication(p,before,which==='order'?'ORDER_INACTIVE':'AMENDMENT_EXPIRED');
});
test('acceptance is required from both parties, initiator included; duplicates and nonparticipants fail',async()=>{
  const p=await propose(await proposal());await accept(p,provider.address,providerKey,provider);
  await assert.rejects(accept(p,provider.address,providerKey,provider),/DUPLICATE_ACCEPTANCE/);
  assert.equal((await core.getCoordinationStatus(p.h)).status,1n);
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
  const a=buildAcceptance(p.intent,buyer.address);const signature=await buyerKey.signTypedData(domain(core.target),ACCEPTANCE_TYPES,a);
  await assert.rejects(core.connect(outsider).acceptCoordination.staticCall(p.h,{...a,signature}),/CALLER_NOT_PARTICIPANT/);
  await accept(p,buyer.address,buyerKey,buyer);assert.equal((await core.getCoordinationStatus(p.h)).acceptedBy.length,2);
});
test('wrong domain, wrong signer, noncanonical parties and replayed proposal are rejected',async()=>{
  const p=await proposal();
  const wrong=await buyerKey.signTypedData({...domain(core.target),name:'ERC-8001-Core'},INTENT_TYPES,p.intent);
  await assert.rejects(core.proposeCoordination.staticCall(p.intent,wrong,p.payload),/INTENT_SIGNATURE/);
  const wrongSigner=await providerKey.signTypedData(domain(core.target),INTENT_TYPES,p.intent);
  await assert.rejects(core.proposeCoordination.staticCall(p.intent,wrongSigner,p.payload),/INTENT_SIGNATURE/);
  await assert.rejects(core.proposeCoordination.staticCall({...p.intent,participants:[...p.intent.participants].reverse()},p.signature,p.payload),/PARTICIPANTS/);
  await propose(p);await assert.rejects(core.proposeCoordination.staticCall(p.intent,p.signature,p.payload),/INTENT_NONCE/);
});
test('compact EIP-2098 initiator and acceptance signatures are accepted',async()=>{
  const p=await proposal();p.signature=Signature.from(p.signature).compactSerialized;await propose(p);
  for(const [signer,key] of [[buyer,buyerKey],[provider,providerKey]]){
    const a=buildAcceptance(p.intent,signer.address);
    const signature=Signature.from(await key.signTypedData(domain(core.target),ACCEPTANCE_TYPES,a)).compactSerialized;
    await send(core.connect(signer).acceptCoordination(p.h,{...a,signature}));
  }
  assert.equal((await execute(p)).event.args.success,true);
});
test('ERC-1271 provider can accept and invalidate; invalid contract signature fails',async()=>{
  const wallet=await env.deploy('Test1271Wallet',[provider.address]);const oid=id('wallet-order');
  await send(core.offerOrder(oid,wallet.target,baseTerms));
  await send(wallet.connect(provider).execute(core.target,core.interface.encodeFunctionData('activateOrder',[oid])));
  const p=await propose(await proposal({orderId:oid}));await accept(p,buyer.address,buyerKey,buyer);
  const a=buildAcceptance(p.intent,wallet.target);const signature=await providerKey.signTypedData(domain(core.target),ACCEPTANCE_TYPES,a);
  await send(wallet.connect(provider).setReject(true));
  await assert.rejects(core.acceptCoordination.staticCall(p.h,{...a,signature}),/ACCEPTANCE_SIGNATURE/);
  await send(wallet.connect(provider).setReject(false));await send(core.acceptCoordination(p.h,{...a,signature}));
  assert.equal((await execute(p)).event.args.success,true);
  await send(wallet.connect(provider).execute(core.target,core.interface.encodeFunctionData('invalidateAmendments',[oid])));
  assert.equal((await core.getOrder(oid)).amendmentNonce,2n);
});

test('token callback cannot reenter the same Ready amendment during funding',async()=>{
  const p=await ready();await send(token.setCallback(core.target,core.interface.encodeFunctionData('executeCoordination',[p.h,p.payload,'0x'])));
  assert.equal((await execute(p)).event.args.success,true);assert.equal(await token.callbackSucceeded(),false);
  const o=await core.getOrder(orderId);assert.equal(o.revision,1n);assert.equal(o.escrow,180n);assert.equal(await token.balanceOf(core.target),180n);
});
test('unrelated parties, wrong executor, noncanonical bytes and unsupported conditions cannot authorize an order',async()=>{
  const p=await proposal({participants:[buyer.address,outsider.address]});
  await assert.rejects(core.proposeCoordination.staticCall(p.intent,p.signature,p.payload),/ORDER_PARTIES/);
  for(const [change,reason] of [[{orderContract:outsider.address},'ORDER_CONTRACT']]){
    const p=await proposal({data:change});await assert.rejects(core.proposeCoordination.staticCall(p.intent,p.signature,p.payload),new RegExp(reason));
  }
  const original=await proposal();
  for(const [payload,reason] of [[{...original.payload,conditionsHash:id('not-enforced')},'UNSUPPORTED_CONDITIONS'],[{...original.payload,coordinationData:original.payload.coordinationData+'00'.repeat(32)},'NON_CANONICAL_DATA']]){
    const intent=buildIntent({payload,expiry:original.intent.expiry,nonce:1n,agentId:buyer.address,participants:[buyer.address,provider.address]});
    const signature=await buyerKey.signTypedData(domain(core.target),INTENT_TYPES,intent);
    await assert.rejects(core.proposeCoordination.staticCall(intent,signature,payload),new RegExp(reason));
  }
  await assert.rejects(core.connect(outsider).invalidateAmendments.staticCall(orderId),/PARTY/);
});
test('price decreases and deadline shortening do not release previously reserved funds',async()=>{
  for(const terms of [{...baseTerms,totalPrice:90n},{...baseTerms,deadline:2000009500n}]){
    const p=await ready({terms});await assertFailedApplication(p,await state(),'OUT_OF_PROFILE');
  }
});
test('acceptances are intent-bound and the signature itself cannot authorize another intent',async()=>{
  const a=await propose(await proposal());const b=await propose(await proposal({terms:{...baseTerms,totalPrice:200n}}));
  const message=buildAcceptance(a.intent,buyer.address);
  const signature=await buyerKey.signTypedData(domain(core.target),ACCEPTANCE_TYPES,message);
  await assert.rejects(core.acceptCoordination.staticCall(b.h,{...message,signature}),/ACCEPTANCE_BINDING/);
  await assert.rejects(core.acceptCoordination.staticCall(b.h,{...message,intentHash:b.h,signature}),/ACCEPTANCE_SIGNATURE/);
});
test('proposal and acceptance reject their expiry equality; expired intent cleanup is permissionless',async()=>{
  const p=await proposal({expiry:2000005000n});await mineAt(p.intent.expiry);
  await assert.rejects(core.proposeCoordination.staticCall(p.intent,p.signature,p.payload),/INTENT_EXPIRED/);
  const q=await propose(await proposal({expiry:2000008000n}));
  const a=buildAcceptance(q.intent,buyer.address,2000006000n);const signature=await buyerKey.signTypedData(domain(core.target),ACCEPTANCE_TYPES,a);
  await mineAt(a.expiry);await assert.rejects(core.acceptCoordination.staticCall(q.h,{...a,signature}),/ACCEPTANCE_BINDING/);
  await mineAt(q.intent.expiry);await send(core.connect(outsider).cancelCoordination(q.h,'expired'));
  assert.equal((await core.getCoordinationStatus(q.h)).status,4n);
});
