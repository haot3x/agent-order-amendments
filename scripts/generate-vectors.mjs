import { Wallet, id, TypedDataEncoder } from 'ethers';
import { mkdir, writeFile } from 'node:fs/promises';
import { domain, hashTerms, buildPayload, hashPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES } from '../src/profile.mjs';

// PUBLIC TEST KEYS 1 and 2. Never funded outside a disposable local chain.
const buyer = new Wallet('0x'+'1'.padStart(64,'0'));
const provider = new Wallet('0x'+'2'.padStart(64,'0'));
const orderContract = '0x1000000000000000000000000000000000000001';
const d = domain(orderContract);
const originalTerms = {scopeHash:id('scope:three-projects'),acceptanceHash:id('acceptance:report-v1'),totalPrice:100n,deadline:2000010000n};
const newTerms = {...originalTerms,scopeHash:id('scope:ten-projects-and-sheet'),totalPrice:180n,deadline:2000020000n};
const data = {orderContract,orderId:id('public-order-vector-1'),baseRevision:0n,baseTermsHash:hashTerms(originalTerms),amendmentNonce:0n,newTermsHash:hashTerms(newTerms),newTerms,validUntil:2000009000n};
const payload = buildPayload(data,2000000000n);
const intent = buildIntent({payload,expiry:2000008000n,nonce:1n,agentId:buyer.address,participants:[buyer.address,provider.address]});
const acceptances = await Promise.all([buyer,provider].map(async wallet=>{
  const message = buildAcceptance(intent,wallet.address,2000007000n);
  return {message,signature:await wallet.signTypedData(d,ACCEPTANCE_TYPES,message),digest:TypedDataEncoder.hash(d,ACCEPTANCE_TYPES,message)};
}));
const vector = {description:'Disposable test vector, public integer keys 1 and 2; no production funds',domain:d,buyer:buyer.address,provider:provider.address,originalTerms,data,payload,intent,
  expected:{termsHash:data.newTermsHash,payloadHash:hashPayload(payload),intentStructHash:hashIntent(intent),intentDigest:TypedDataEncoder.hash(d,INTENT_TYPES,intent)},
  intentSignature:await buyer.signTypedData(d,INTENT_TYPES,intent),acceptances};
await mkdir(new URL('../vectors/',import.meta.url),{recursive:true});
await writeFile(new URL('../vectors/order-amendment-v1.json',import.meta.url),JSON.stringify(vector,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log('Wrote deterministic ORDER_AMENDMENT_V1 vector');
