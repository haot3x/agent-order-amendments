import {test, before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AbiCoder, id, keccak256, toUtf8Bytes, MaxUint256, ZeroHash} from 'ethers';
import {compile, root} from '../scripts/compile.mjs';
import {localEvm} from '../scripts/local-evm.mjs';
import {domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES} from '../src/profile.mjs';

let env, token, core, registry, buyer, provider, verifier, buyerKey, providerKey, snapshot, firstId, initialTerms;
const orderId = id('criteria-order');
const send = async promise => (await promise).wait();
const logsAt = (receipt, c) => receipt.logs.filter(l => l.address.toLowerCase() === c.target.toLowerCase()).map(l => c.interface.parseLog(l));
// This fixture uses ASCII strings, booleans, null and safe integers only. Sorted
// keys therefore produce JCS bytes for these documents; not a general JCS API.
function canonical(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { assert(Number.isSafeInteger(v)); return JSON.stringify(v); }
  if (typeof v === 'string') { assert(/^[\x20-\x7e]*$/.test(v)); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${canonical(k)}:${canonical(v[k])}`).join(',')}}`;
}
async function document(prior, expiry, model) {
  return {version:'1', taskRef:await core.taskRef(orderId), supersedes:prior === ZeroHash ? null : prior,
    decisionRule:'ALL_REQUIRED', obligations:[{index:0,type:'GENERATED_ARTIFACT',required:true,waivable:false,
      constraints:{modelBinding:model,mediaType:'text/markdown'}}], waiverAuthority:null,
    verifier:verifier.address, verifierConstraint:{allowed:[verifier.address]}, expiry:Number(expiry), terminalOnExpiry:'REVERIFY'};
}
const digest = doc => keccak256(toUtf8Bytes(canonical(doc)));
const registrationId = async hash => keccak256(AbiCoder.defaultAbiCoder().encode(
  ['uint256','address','address','bytes32','bytes32'], [31337,registry.target,core.target,hash,await core.taskRef(orderId)]));

before(async () => {
  const [pin, file] = readFileSync(`${root}/vendor/erc8412/SHA256SUMS`,'utf8').trim().split(/  /);
  assert.equal(createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex'), pin);
  env = await localEvm(compile(['contracts/test/CriteriaOrderFixture.sol','vendor/erc8412/PreregisteredCriteria.sol']));
  [buyer,provider,verifier] = env.signers; [buyerKey,providerKey] = env.wallets;
  token = await env.deploy('TestToken'); registry = await env.deploy('PreregisteredCriteria');
  core = await env.deploy('CriteriaOrderFixture',[token.target,registry.target,verifier.address]);
  const doc = await document(ZeroHash,2000010000n,'report-v1');
  initialTerms = {scopeHash:id('report'),acceptanceHash:digest(doc),totalPrice:100n,deadline:2000010000n};
  await send(token.mint(buyer.address,1000n)); await send(token.approve(core.target,MaxUint256));
  await send(core.offerOrder(orderId,provider.address,initialTerms));
  await send(core.connect(provider).activateOrder(orderId));
  await send(core.connect(verifier).registerInitial(orderId));
  firstId = await core.currentRegistration(orderId);
  assert.equal(firstId,await registrationId(initialTerms.acceptanceHash));
  const now = (await env.rpc.getBlock('latest')).timestamp;
  await env.rpc.send('evm_setNextBlockTimestamp',[now+60]); await env.rpc.send('evm_mine',[]);
  snapshot = await env.rpc.send('evm_snapshot',[]);
});
after(async () => { if (env) await env.close(); });
beforeEach(async () => { await env.rpc.send('evm_revert',[snapshot]); snapshot = await env.rpc.send('evm_snapshot',[]); });

async function propose() {
  const o = await core.getOrder(orderId);
  const doc = await document(await core.currentRegistration(orderId),2000020000n,'report-v2');
  const terms = {...initialTerms,acceptanceHash:digest(doc),totalPrice:180n,deadline:2000020000n};
  const payload = buildPayload({orderContract:core.target,orderId,baseRevision:o.revision,baseTermsHash:o.termsHash,
    amendmentNonce:o.amendmentNonce,newTermsHash:hashTerms(terms),newTerms:terms,validUntil:2000009000n},2000000000n);
  const intent = buildIntent({payload,expiry:2000008000n,nonce:await core.getAgentNonce(buyer.address)+1n,
    agentId:buyer.address,participants:[buyer.address,provider.address]});
  await send(core.proposeCoordination(intent,await buyerKey.signTypedData(domain(core.target),INTENT_TYPES,intent),payload));
  return {payload,intent,h:hashIntent(intent),terms,doc,next:await registrationId(terms.acceptanceHash)};
}
async function accept(p, signer, key) {
  const a = buildAcceptance(p.intent,signer.address);
  await send(core.connect(signer).acceptCoordination(p.h,{...a,signature:await key.signTypedData(domain(core.target),ACCEPTANCE_TYPES,a)}));
}
async function ready() { const p=await propose(); await accept(p,buyer,buyerKey); await accept(p,provider,providerKey); return p; }
async function execute(p) {
  const receipt=await send(core.executeCoordination(p.h,p.payload,'0x',{gasLimit:2500000}));
  const logs=logsAt(receipt,core); return {receipt,logs,outcome:logs.find(l=>l.name==='CoordinationExecuted')};
}
async function state() { return {order:(await core.getOrder(orderId)).toObject(true),prior:(await registry.getPreregistration(firstId)).toObject(true),
  current:await core.currentRegistration(orderId),buyer:await token.balanceOf(buyer.address),escrow:await token.balanceOf(core.target)}; }
async function failed(p, beforeState, reason) {
  const r=await execute(p); assert.equal(r.outcome.args.success,false);
  if(reason) assert.equal(registry.interface.parseError(r.outcome.args.result).name,reason);
  assert.deepEqual(await state(),beforeState);
  assert.equal((await registry.getPreregistration(p.next)).registeredAt,0n);
  assert.equal(logsAt(r.receipt,registry).length,0); assert.equal(logsAt(r.receipt,token).length,0);
  assert(!r.logs.some(l=>l.name==='OrderAmendmentApplied'));
  assert.equal((await core.getCoordinationStatus(p.h)).status,3n); return r;
}

test('8412: both parties bind a new criteria digest; supersession, top-up and revision are atomic',async()=>{
  const p=await ready(); const r=await execute(p); assert.equal(r.outcome.args.success,true);
  const next=await registry.getPreregistration(p.next); const prior=await registry.getPreregistration(firstId);
  assert.equal(prior.supersededBy,p.next); assert.equal(next.supersedes,firstId);
  assert.equal(next.author,core.target); assert.equal(next.verifier,verifier.address);
  assert.equal(next.criteriaDigest,digest(p.doc)); assert.equal(next.expiry,p.terms.deadline);
  assert.equal(next.taskRef,p.doc.taskRef); assert.equal(next.obligationFlags,'0x40'); assert.equal(next.obligationCount,1n);
  assert(next.registeredAt>prior.registeredAt); assert.equal(await core.currentRegistration(orderId),p.next);
  const o=await core.getOrder(orderId); assert.equal(o.revision,1n); assert.equal(o.amendmentNonce,1n);
  assert.equal(o.escrow,180n); assert.equal(o.terms.acceptanceHash,next.criteriaDigest);
  assert.equal(await token.balanceOf(core.target),180n); assert.equal(await token.balanceOf(buyer.address),820n);
  assert.equal(logsAt(r.receipt,registry).filter(l=>l.name==='CriteriaPreregistered').length,1);
});

test('8412: buyer alone cannot supersede or bypass the isolated application entry point',async()=>{
  const p=await propose(); await accept(p,buyer,buyerKey); const beforeState=await state();
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
  await assert.rejects(core.applyPayload.staticCall(p.h,p.payload,'0x'),/ONLY_SELF/);
  await assert.rejects(registry.preregister.staticCall(p.terms.acceptanceHash,p.doc.taskRef,1,'0x40',p.terms.deadline,verifier.address,firstId),/E12_DifferentAuthorOrTask/);
  await assert.rejects(core.registerInitial.staticCall(orderId),/ALREADY_REGISTERED/);
  assert.deepEqual(await state(),beforeState);
});

test('8412: transfer failure rolls back an already attempted registry supersession and needs fresh consent',async()=>{
  const p=await ready(); await send(token.setFailAfterTransfer(true)); await failed(p,await state());
  await send(token.setFailAfterTransfer(false));
  await assert.rejects(core.executeCoordination.staticCall(p.h,p.payload,'0x'),/NOT_READY/);
  const retry=await propose(); await accept(retry,buyer,buyerKey);
  await assert.rejects(core.executeCoordination.staticCall(retry.h,retry.payload,'0x'),/NOT_READY/);
  await accept(retry,provider,providerKey); assert.equal((await execute(retry)).outcome.args.success,true);
});

test('8412: a final prior verdict blocks supersession and preserves the order and funding',async()=>{
  const p=await ready(); await send(registry.connect(verifier).attestOutcome(firstId,id('bundle'),id('attestation'),1,'0x40'));
  await failed(p,await state(),'E12_PriorFinal');
});

test('8412: an Indeterminate prior verdict allows a mutually accepted successor, not an old-record rewrite',async()=>{
  const p=await ready(); await send(registry.connect(verifier).attestOutcome(firstId,id('bundle'),id('attestation'),3,'0x00'));
  assert.equal((await execute(p)).outcome.args.success,true);
  assert.equal((await registry.getAttestation(firstId)).verdict,3n);
  await assert.rejects(registry.connect(verifier).attestOutcome.staticCall(firstId,id('b2'),id('a2'),1,'0x40'),/E13_Superseded/);
});

test('8412: successor evidence must use its own registration and a new capture time (O1 subset)',async()=>{
  const p=await ready(); await execute(p);
  const old=await registry.getPreregistration(firstId), next=await registry.getPreregistration(p.next);
  // Local consumer policy only: this does not authenticate capture metadata,
  // evaluate evidence quality, or implement the remaining O1-O5 obligations.
  const eligible=item=>item.preregistrationId===p.next && BigInt(item.captureMetadata.timestamp)>=next.registeredAt;
  assert.equal(eligible({preregistrationId:firstId,captureMetadata:{timestamp:Number(next.registeredAt)}}),false);
  assert.equal(eligible({preregistrationId:p.next,captureMetadata:{timestamp:Number(old.registeredAt)}}),false);
  assert.equal(eligible({preregistrationId:p.next,captureMetadata:{timestamp:Number(next.registeredAt)}}),true);
});

test('8412: submission after consent prevents amendment and criteria supersession',async()=>{
  const p=await ready(), o=await core.getOrder(orderId);
  await send(core.connect(provider).submit(orderId,o.revision,o.termsHash,id('delivered')));
  await failed(p,await state());
});

test('8412: payment callback cannot execute a second supersession',async()=>{
  const p=await ready(); await send(token.setCallback(core.target,core.interface.encodeFunctionData('executeCoordination',[p.h,p.payload,'0x'])));
  const r=await execute(p); assert.equal(r.outcome.args.success,true); assert.equal(await token.callbackSucceeded(),false);
  assert.equal(logsAt(r.receipt,registry).length,1); assert.equal((await core.getOrder(orderId)).revision,1n);
});
