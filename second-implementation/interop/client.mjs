// A client that knows only what ERC-8448 and ERC-8001 standardize. The ABI below is transcribed from the two
// specifications, not taken from either implementation's build output.
import { AbiCoder, Interface, TypedDataEncoder, ZeroHash, id, keccak256, Signature } from 'ethers';

const TERMS = 'tuple(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)';
const INTENT = 'tuple(bytes32 payloadHash,uint64 expiry,uint64 nonce,address agentId,bytes32 coordinationType,uint256 coordinationValue,address[] participants)';
const PAYLOAD = 'tuple(bytes32 version,bytes32 coordinationType,bytes coordinationData,bytes32 conditionsHash,uint256 timestamp,bytes metadata)';
const ATTESTATION = 'tuple(bytes32 intentHash,address participant,uint64 nonce,uint64 expiry,bytes32 conditionsHash,bytes signature)';
export const COMMON_ABI = [
  'error UnknownOrder(bytes32 orderId)',
  `function getAmendmentState(bytes32 orderId) view returns (address buyer,address provider,address paymentAsset,uint64 revision,bytes32 termsHash,uint256 amendmentNonce,${TERMS} terms,bool eligible)`,
  'function invalidateAmendments(bytes32 orderId)',
  `function proposeCoordination(${INTENT} intent,bytes signature,${PAYLOAD} payload) returns (bytes32 intentHash)`,
  `function acceptCoordination(bytes32 intentHash,${ATTESTATION} attestation) returns (bool allAccepted)`,
  `function executeCoordination(bytes32 intentHash,${PAYLOAD} payload,bytes executionData) returns (bool success,bytes result)`,
  'function cancelCoordination(bytes32 intentHash,string reason)',
  'function getCoordinationStatus(bytes32 intentHash) view returns (uint8 status,address proposer,address[] participants,address[] acceptedBy,uint256 expiry)',
  'function getRequiredAcceptances(bytes32 intentHash) view returns (uint256)',
  'function getAgentNonce(address agent) view returns (uint64)',
  'event AmendmentsInvalidated(bytes32 indexed orderId,address indexed participant,uint256 amendmentNonce)',
  'event OrderAmendmentApplied(bytes32 indexed intentHash,bytes32 indexed orderId,uint64 revision,bytes32 previousTermsHash,bytes32 newTermsHash,uint256 supplement)',
  'event CoordinationProposed(bytes32 indexed intentHash,address indexed proposer,bytes32 coordinationType,uint256 participantCount,uint256 coordinationValue)',
  'event CoordinationAccepted(bytes32 indexed intentHash,address indexed participant,bytes32 acceptanceHash,uint256 acceptedCount,uint256 requiredCount)',
  'event CoordinationExecuted(bytes32 indexed intentHash,address indexed executor,bool success,uint256 gasUsed,bytes result)',
  'event CoordinationCancelled(bytes32 indexed intentHash,address indexed canceller,string reason,uint8 finalStatus)',
];
export const common = new Interface(COMMON_ABI);
export const STATUS = ['None', 'Proposed', 'Ready', 'Executed', 'Cancelled', 'Expired'];

const coder = AbiCoder.defaultAbiCoder();
export const COORDINATION_TYPE = id('ORDER_AMENDMENT_V1');
export const PAYLOAD_VERSION = id('ORDER_AMENDMENT_PAYLOAD_V1');
const TERM_TYPES = { Terms: [
  { name: 'scopeHash', type: 'bytes32' }, { name: 'acceptanceHash', type: 'bytes32' },
  { name: 'totalPrice', type: 'uint256' }, { name: 'deadline', type: 'uint64' } ] };
export const INTENT_TYPES = { AgentIntent: [
  { name: 'payloadHash', type: 'bytes32' }, { name: 'expiry', type: 'uint64' }, { name: 'nonce', type: 'uint64' },
  { name: 'agentId', type: 'address' }, { name: 'coordinationType', type: 'bytes32' },
  { name: 'coordinationValue', type: 'uint256' }, { name: 'participants', type: 'address[]' } ] };
export const ACCEPTANCE_TYPES = { AcceptanceAttestation: [
  { name: 'intentHash', type: 'bytes32' }, { name: 'participant', type: 'address' }, { name: 'nonce', type: 'uint64' },
  { name: 'expiry', type: 'uint64' }, { name: 'conditionsHash', type: 'bytes32' } ] };

export const domainOf = (verifyingContract, chainId) => ({ name: 'ERC-8001', version: '1', chainId, verifyingContract });
export const hashTerms = (terms) => TypedDataEncoder.hashStruct('Terms', TERM_TYPES, terms);
export const hashIntent = (intent) => TypedDataEncoder.hashStruct('AgentIntent', INTENT_TYPES, intent);
export const hashPayload = (p) => keccak256(coder.encode(['bytes32', 'bytes32', 'bytes', 'bytes32', 'uint256', 'bytes'],
  [p.version, p.coordinationType, p.coordinationData, p.conditionsHash, p.timestamp, p.metadata]));
export const encodeAmendment = (d) => coder.encode(
  [`tuple(address orderContract,bytes32 orderId,uint64 baseRevision,bytes32 baseTermsHash,uint256 amendmentNonce,bytes32 newTermsHash,${TERMS} newTerms,uint64 validUntil)`], [d]);
export const compact = (signature) => Signature.from(signature).compactSerialized;
const plainTerms = (t) => ({ scopeHash: t.scopeHash, acceptanceHash: t.acceptanceHash, totalPrice: t.totalPrice, deadline: t.deadline });

/**
 * Builds a fully signed amendment from the common state view alone. `change(currentTerms)` returns the complete
 * replacement terms. `initiator` is { address, key }, as is each entry of `signers`; `key` signs typed data.
 */
export async function prepareAmendment(contract, chainId, orderId, change, { initiator, signers, expiry, validUntil, timestamp, tweak = {} }) {
  const state = await contract.getAmendmentState(orderId);
  const newTerms = change(plainTerms(state.terms));
  const data = { orderContract: contract.target, orderId, baseRevision: state.revision, baseTermsHash: state.termsHash,
    amendmentNonce: state.amendmentNonce, newTermsHash: hashTerms(newTerms), newTerms, validUntil, ...tweak.data };
  const payload = { version: PAYLOAD_VERSION, coordinationType: COORDINATION_TYPE, coordinationData: encodeAmendment(data),
    conditionsHash: ZeroHash, timestamp, metadata: '0x', ...tweak.payload };
  const participants = [state.buyer, state.provider].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const intent = { payloadHash: hashPayload(payload), expiry, nonce: (await contract.getAgentNonce(initiator.address)) + 1n,
    agentId: initiator.address, coordinationType: COORDINATION_TYPE, coordinationValue: 0n, participants, ...tweak.intent };
  const domain = domainOf(contract.target, chainId);
  const intentHash = hashIntent(intent);
  const intentSignature = await initiator.key.signTypedData(domain, INTENT_TYPES, intent);
  const acceptances = [];
  for (const s of signers) {
    const a = { intentHash, participant: s.address, nonce: 0n, expiry: s.expiry ?? expiry, conditionsHash: ZeroHash };
    const signature = await s.key.signTypedData(domain, ACCEPTANCE_TYPES, a);
    acceptances.push({ ...a, signature: s.compact ? compact(signature) : signature });
  }
  return { state, newTerms, data, payload, intent, intentHash, intentSignature, acceptances };
}
