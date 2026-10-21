// MIT. Declared from the ERC text; no imports from the implementation's encoder
// or compiler-generated ABI. This is a second client in the same project, not
// an independent adopter or a second complete contract implementation.
import { encodeAbiParameters, getAddress, hashTypedData, keccak256, parseAbi, parseAbiParameters, stringToHex } from 'viem';

export const STATE_ABI = parseAbi([
  'error UnknownOrder(bytes32 orderId)',
  'function getAmendmentState(bytes32 orderId) view returns (address buyer, address provider, address paymentAsset, uint64 revision, bytes32 termsHash, uint256 amendmentNonce, (bytes32 scopeHash, bytes32 acceptanceHash, uint256 totalPrice, uint64 deadline) terms, bool eligible)',
]);
const ZERO = `0x${'00'.repeat(32)}`;
const hashText = value => keccak256(stringToHex(value));
const TERMS_TYPE = 'Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)';
const DATA = parseAbiParameters('(address orderContract, bytes32 orderId, uint64 baseRevision, bytes32 baseTermsHash, uint256 amendmentNonce, bytes32 newTermsHash, (bytes32 scopeHash, bytes32 acceptanceHash, uint256 totalPrice, uint64 deadline) newTerms, uint64 validUntil)');
export const INTENT_TYPES = { AgentIntent: [
  {name:'payloadHash',type:'bytes32'}, {name:'expiry',type:'uint64'},
  {name:'nonce',type:'uint64'}, {name:'agentId',type:'address'},
  {name:'coordinationType',type:'bytes32'}, {name:'coordinationValue',type:'uint256'},
  {name:'participants',type:'address[]'},
] };
export const ACCEPTANCE_TYPES = { AcceptanceAttestation: [
  {name:'intentHash',type:'bytes32'}, {name:'participant',type:'address'},
  {name:'nonce',type:'uint64'}, {name:'expiry',type:'uint64'}, {name:'conditionsHash',type:'bytes32'},
] };
export function termsHash(terms) {
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, uint64'),
    [hashText(TERMS_TYPE), terms.scopeHash, terms.acceptanceHash, terms.totalPrice, terms.deadline]));
}
export async function readAmendmentState(client, address, orderId, blockNumber) {
  const [buyer,provider,paymentAsset,revision,currentHash,amendmentNonce,terms,eligible] = await client.readContract({
    address, abi: STATE_ABI, functionName:'getAmendmentState', args:[orderId], blockNumber,
  });
  if (termsHash(terms) !== currentHash) throw new Error('INCONSISTENT_TERMS_HASH');
  return {buyer,provider,paymentAsset,revision,termsHash:currentHash,amendmentNonce,terms,eligible};
}
export function constructAmendment({address,chainId,orderId,state,newTerms,agentId,intentNonce,expiry,validUntil,timestamp}) {
  if (!state.eligible) throw new Error('ORDER_INELIGIBLE');
  if (![state.buyer,state.provider].some(p=>getAddress(p)===getAddress(agentId))) throw new Error('NOT_ORDER_PARTY');
  if (newTerms.totalPrice < state.terms.totalPrice || newTerms.deadline < state.terms.deadline) throw new Error('OUT_OF_PROFILE');
  const newHash = termsHash(newTerms);
  if (newHash === state.termsHash || newTerms.scopeHash === ZERO || newTerms.acceptanceHash === ZERO) throw new Error('INVALID_TERMS');
  const data = {orderContract:address,orderId,baseRevision:state.revision,baseTermsHash:state.termsHash,
    amendmentNonce:state.amendmentNonce,newTermsHash:newHash,newTerms,validUntil};
  const payload = {version:hashText('ORDER_AMENDMENT_PAYLOAD_V1'),coordinationType:hashText('ORDER_AMENDMENT_V1'),
    coordinationData:encodeAbiParameters(DATA,[data]),conditionsHash:ZERO,timestamp,metadata:'0x'};
  const payloadHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes, bytes32, uint256, bytes'),
    [payload.version,payload.coordinationType,payload.coordinationData,payload.conditionsHash,payload.timestamp,payload.metadata]));
  const intent = {payloadHash,expiry,nonce:intentNonce,agentId,coordinationType:payload.coordinationType,coordinationValue:0n,
    participants:[state.buyer,state.provider].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)};
  const domain = {name:'ERC-8001',version:'1',chainId,verifyingContract:address};
  // hashTypedData with an empty domain is NOT the struct hash: explicitly hash
  // the canonical EIP-712 fields, including the packed address-array hash.
  const intentHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint64, uint64, address, bytes32, uint256, bytes32'), [
    hashText('AgentIntent(bytes32 payloadHash,uint64 expiry,uint64 nonce,address agentId,bytes32 coordinationType,uint256 coordinationValue,address[] participants)'),
    intent.payloadHash,intent.expiry,intent.nonce,intent.agentId,intent.coordinationType,intent.coordinationValue,
    keccak256(encodeAbiParameters(parseAbiParameters('address, address'),intent.participants)),
  ]));
  return {data,payload,intent,intentHash,domain,
    digest:hashTypedData({domain,types:INTENT_TYPES,primaryType:'AgentIntent',message:intent}),
    acceptance:(participant,acceptanceExpiry=expiry)=>({intentHash,participant,nonce:0n,expiry:acceptanceExpiry,conditionsHash:ZERO})};
}
