import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, parseAbiParameters, keccak256, stringToHex, hashTypedData, recoverTypedDataAddress } from 'viem';
import { TypedDataEncoder, verifyTypedData } from 'ethers';
import { buildPayload, hashPayload, hashIntent, hashTerms, INTENT_TYPES, ACCEPTANCE_TYPES } from '../src/profile.mjs';

const v = JSON.parse(await readFile(new URL('../vectors/order-amendment-v1.json',import.meta.url),'utf8'));

test('fixed vector: ethers encoder and independent viem ABI/type declarations agree', async()=>{
  assert.equal(hashTerms(v.data.newTerms),v.expected.termsHash);
  assert.deepEqual(buildPayload(v.data,v.payload.timestamp),v.payload);
  assert.equal(hashPayload(v.payload),v.expected.payloadHash);
  assert.equal(hashIntent(v.intent),v.expected.intentStructHash);
  assert.equal(TypedDataEncoder.hash(v.domain,INTENT_TYPES,v.intent),v.expected.intentDigest);
  // Separate declarations: a mistake in src/profile.mjs must not rewrite this oracle.
  const intentTypes={AgentIntent:[{name:'payloadHash',type:'bytes32'},{name:'expiry',type:'uint64'},{name:'nonce',type:'uint64'},{name:'agentId',type:'address'},{name:'coordinationType',type:'bytes32'},{name:'coordinationValue',type:'uint256'},{name:'participants',type:'address[]'}]};
  const acceptanceTypes={AcceptanceAttestation:[{name:'intentHash',type:'bytes32'},{name:'participant',type:'address'},{name:'nonce',type:'uint64'},{name:'expiry',type:'uint64'},{name:'conditionsHash',type:'bytes32'}]};
  const data=v.data,t=data.newTerms,p=v.payload;
  assert.equal(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, uint64'),
    [keccak256(stringToHex('Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)')),t.scopeHash,t.acceptanceHash,BigInt(t.totalPrice),BigInt(t.deadline)])),v.expected.termsHash);
  const wire=encodeAbiParameters(parseAbiParameters('(address orderContract, bytes32 orderId, uint64 baseRevision, bytes32 baseTermsHash, uint256 amendmentNonce, bytes32 newTermsHash, (bytes32 scopeHash, bytes32 acceptanceHash, uint256 totalPrice, uint64 deadline) newTerms, uint64 validUntil)'),
    [{...data,baseRevision:BigInt(data.baseRevision),amendmentNonce:BigInt(data.amendmentNonce),validUntil:BigInt(data.validUntil),newTerms:{...t,totalPrice:BigInt(t.totalPrice),deadline:BigInt(t.deadline)}}]);
  assert.equal(wire,p.coordinationData);
  assert.equal(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes, bytes32, uint256, bytes'),[p.version,p.coordinationType,wire,p.conditionsHash,BigInt(p.timestamp),p.metadata])),v.expected.payloadHash);
  const vd={...v.domain,chainId:Number(v.domain.chainId)};
  const input={domain:vd,types:intentTypes,primaryType:'AgentIntent',message:v.intent};
  assert.equal(hashTypedData(input),v.expected.intentDigest);
  assert.equal((await recoverTypedDataAddress({...input,signature:v.intentSignature})).toLowerCase(),v.buyer.toLowerCase());
  assert.equal(verifyTypedData(v.domain,INTENT_TYPES,v.intent,v.intentSignature),v.buyer);
  for(const a of v.acceptances){
    const input={domain:vd,types:acceptanceTypes,primaryType:'AcceptanceAttestation',message:a.message};
    assert.equal(hashTypedData(input),a.digest);
    assert.equal((await recoverTypedDataAddress({...input,signature:a.signature})).toLowerCase(),a.message.participant.toLowerCase());
    assert.equal(TypedDataEncoder.hash(v.domain,ACCEPTANCE_TYPES,a.message),a.digest);
  }
  assert.notEqual(hashTypedData({...input,domain:{...vd,chainId:1}}),v.expected.intentDigest);
});
