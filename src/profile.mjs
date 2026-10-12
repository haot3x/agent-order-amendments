import { AbiCoder, id, keccak256, TypedDataEncoder, ZeroHash } from 'ethers';

export const COORDINATION_TYPE = id('ORDER_AMENDMENT_V1');
export const PAYLOAD_VERSION = id('ORDER_AMENDMENT_PAYLOAD_V1');
export const TERMS_ABI = 'tuple(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)';
export const DATA_ABI = `tuple(address orderContract,bytes32 orderId,uint64 baseRevision,bytes32 baseTermsHash,uint256 amendmentNonce,bytes32 newTermsHash,${TERMS_ABI} newTerms,uint64 validUntil)`;
export const TERM_TYPES = { Terms: [
  {name:'scopeHash',type:'bytes32'}, {name:'acceptanceHash',type:'bytes32'},
  {name:'totalPrice',type:'uint256'}, {name:'deadline',type:'uint64'},
] };
export const INTENT_TYPES = { AgentIntent: [
  {name:'payloadHash',type:'bytes32'}, {name:'expiry',type:'uint64'},
  {name:'nonce',type:'uint64'}, {name:'agentId',type:'address'},
  {name:'coordinationType',type:'bytes32'}, {name:'coordinationValue',type:'uint256'},
  {name:'participants',type:'address[]'},
] };
export const ACCEPTANCE_TYPES = { AcceptanceAttestation: [
  {name:'intentHash',type:'bytes32'}, {name:'participant',type:'address'},
  {name:'nonce',type:'uint64'}, {name:'expiry',type:'uint64'},
  {name:'conditionsHash',type:'bytes32'},
] };
export const domain = (verifyingContract, chainId = 31337n) => ({name:'ERC-8001',version:'1',chainId,verifyingContract});
export const hashTerms = (terms) => TypedDataEncoder.hashStruct('Terms',TERM_TYPES,terms);
export const hashIntent = (intent) => TypedDataEncoder.hashStruct('AgentIntent',INTENT_TYPES,intent);
export const abi = AbiCoder.defaultAbiCoder();
export function buildPayload(data, timestamp) {
  return {version:PAYLOAD_VERSION, coordinationType:COORDINATION_TYPE,
    coordinationData:abi.encode([DATA_ABI],[data]), conditionsHash:ZeroHash,
    timestamp, metadata:'0x'};
}
export function hashPayload(p) {
  return keccak256(abi.encode(['bytes32','bytes32','bytes','bytes32','uint256','bytes'],
    [p.version,p.coordinationType,p.coordinationData,p.conditionsHash,p.timestamp,p.metadata]));
}
export function buildIntent({payload,expiry,nonce,agentId,participants}) {
  if (participants.length !== 2 || participants[0].toLowerCase() === participants[1].toLowerCase()) throw new Error('TWO_DISTINCT_PARTIES');
  return {payloadHash:hashPayload(payload),expiry,nonce,agentId,coordinationType:COORDINATION_TYPE,
    coordinationValue:0n,participants:[...participants].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)};
}
export function buildAcceptance(intent, participant, expiry = intent.expiry) {
  return {intentHash:hashIntent(intent),participant,nonce:0n,expiry,conditionsHash:ZeroHash};
}
