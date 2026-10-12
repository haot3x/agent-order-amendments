import { getAddress, isHexString, TypedDataEncoder, verifyTypedData, ZeroAddress, ZeroHash } from 'ethers';

// Experimental wire format. Integer values serialize as decimal strings in JSON.
export const TYPES = Object.freeze({
  Terms: [
    { name: 'scopeHash', type: 'bytes32' },
    { name: 'acceptanceHash', type: 'bytes32' },
    { name: 'totalPrice', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Amendment: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'baseRevision', type: 'uint64' },
    { name: 'baseTermsHash', type: 'bytes32' },
    { name: 'newTermsHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Invalidation: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Submission: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'revision', type: 'uint64' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'resultHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
  Acceptance: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'revision', type: 'uint64' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'resultHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
});
for (const fields of Object.values(TYPES)) {
  for (const field of fields) Object.freeze(field);
  Object.freeze(fields);
}
export const typed = (name) => ({ [name]: TYPES[name] });
const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const uint = (v, bits = 256) => {
  check(typeof v === 'bigint' || (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)), 'INTEGER_FORMAT');
  const n = BigInt(v);
  check(n >= 0n && n < (1n << BigInt(bits)), 'INTEGER_RANGE');
  return n;
};
const hash = (v) => {
  check(isHexString(v, 32) && v.toLowerCase() !== ZeroHash, 'HASH_FORMAT');
  return v.toLowerCase();
};
export function normalizeTerms(t) {
  check(Object.keys(t).sort().join(',') === 'acceptanceHash,deadline,scopeHash,totalPrice', 'TERMS_FIELDS');
  return { scopeHash: hash(t.scopeHash), acceptanceHash: hash(t.acceptanceHash), totalPrice: uint(t.totalPrice), deadline: uint(t.deadline, 64) };
}
export const termsHash = (t) => TypedDataEncoder.hashStruct('Terms', typed('Terms'), normalizeTerms(t));
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);

/**
 * Single-process executable model, with mock balances. No RPC, private-key storage,
 * token custody, database, ERC-1271, delegated signer policy or production API.
 * Constructor is a trusted fixture for an already-authorized and funded order.
 */
export class OrderModel {
  #domain; #state; #clock;
  constructor({ domain, orderId, buyer, provider, asset, terms, buyerBalance, now }) {
    check(domain.name === 'AgentServiceOrderAmendments' && domain.version === '0.1', 'DOMAIN_VERSION');
    const chainId = uint(domain.chainId);
    check(chainId > 0n, 'CHAIN_ID');
    const verifyingContract = getAddress(domain.verifyingContract);
    check(verifyingContract !== ZeroAddress, 'VERIFYING_CONTRACT');
    this.#domain = { name: domain.name, version: domain.version, chainId, verifyingContract };
    check(typeof now === 'function', 'CLOCK_REQUIRED');
    this.#clock = now;
    const t = normalizeTerms(terms);
    const balance = uint(buyerBalance);
    check(t.deadline > this.#now(), 'DEADLINE');
    check(balance >= t.totalPrice, 'INSUFFICIENT_FUNDS');
    const b = getAddress(buyer), p = getAddress(provider), a = getAddress(asset);
    check(b !== ZeroAddress && p !== ZeroAddress && a !== ZeroAddress && b !== p, 'PARTIES_OR_ASSET');
    this.#state = {
      orderId: hash(orderId), buyer: b, provider: p, asset: a,
      status: 'ACTIVE', revision: 0n, nonce: 0n, terms: t, termsHash: termsHash(t),
      buyerAvailable: balance - t.totalPrice, escrow: t.totalPrice, providerPaid: 0n,
      history: [{ revision: 0n, terms: structuredClone(t), termsHash: termsHash(t) }],
      events: [], submission: null,
    };
  }
  get domain() { return structuredClone(this.#domain); }
  snapshot() { return structuredClone(this.#state); }
  #now() { return uint(this.#clock(), 64); }
  #live(message) {
    check(hash(message.orderId) === this.#state.orderId, 'WRONG_ORDER');
    check(this.#now() < uint(message.validUntil, 64), 'EXPIRED');
  }
  #signer(kind, message, signature) {
    try { return getAddress(verifyTypedData(this.#domain, typed(kind), message, signature)); }
    catch { throw new Error('INVALID_SIGNATURE'); }
  }
  #active() {
    check(this.#state.status === 'ACTIVE', 'NOT_ACTIVE');
    check(this.#now() < this.#state.terms.deadline, 'ORDER_DEADLINE');
  }
  amendment(newTerms, validUntil) {
    const s = this.#state;
    return { orderId: s.orderId, baseRevision: s.revision, baseTermsHash: s.termsHash,
      newTermsHash: termsHash(newTerms), nonce: s.nonce, validUntil: uint(validUntil, 64) };
  }
  applyAmendment(message, newTerms, buyerSignature, providerSignature) {
    const s = this.#state;
    this.#active(); this.#live(message);
    check(uint(message.baseRevision, 64) === s.revision && hash(message.baseTermsHash) === s.termsHash, 'STALE_REVISION');
    check(uint(message.nonce) === s.nonce, 'STALE_NONCE');
    const t = normalizeTerms(newTerms), nextHash = termsHash(t);
    check(hash(message.newTermsHash) === nextHash && nextHash !== s.termsHash, 'TERMS_MISMATCH');
    check(t.totalPrice >= s.terms.totalPrice, 'PRICE_DECREASE_OUT_OF_PROFILE');
    check(t.deadline >= s.terms.deadline, 'DEADLINE_SHORTENING_OUT_OF_PROFILE');
    check(this.#signer('Amendment', message, buyerSignature) === s.buyer, 'BUYER_SIGNATURE');
    check(this.#signer('Amendment', message, providerSignature) === s.provider, 'PROVIDER_SIGNATURE');
    const delta = t.totalPrice - s.terms.totalPrice;
    check(s.buyerAvailable >= delta, 'INSUFFICIENT_FUNDS');
    const revision = uint(s.revision + 1n, 64), nonce = uint(s.nonce + 1n);
    // All validation precedes writes. Synchronous in this process; a real adapter
    // needs an EVM transaction, or database CAS + durable outbox + reconciliation.
    s.buyerAvailable -= delta; s.escrow += delta;
    s.revision = revision; s.nonce = nonce; s.terms = t; s.termsHash = nextHash;
    s.history.push({ revision, terms: structuredClone(t), termsHash: nextHash });
    s.events.push({ type: 'AmendmentApplied', revision, nonce, previousTermsHash: message.baseTermsHash, termsHash: nextHash, delta });
    return this.snapshot();
  }
  invalidate(message, signature) {
    this.#active(); this.#live(message);
    const s = this.#state;
    check(uint(message.nonce) === s.nonce, 'STALE_NONCE');
    const signer = this.#signer('Invalidation', message, signature);
    check(signer === s.buyer || signer === s.provider, 'PARTY_SIGNATURE');
    s.nonce = uint(s.nonce + 1n);
    s.events.push({ type: 'ProposalsInvalidated', signer, nonce: s.nonce });
    return this.snapshot();
  }
  submit(message, signature) {
    this.#active(); this.#live(message);
    const s = this.#state;
    check(uint(message.revision, 64) === s.revision && hash(message.termsHash) === s.termsHash, 'STALE_REVISION');
    const resultHash = hash(message.resultHash);
    check(this.#signer('Submission', message, signature) === s.provider, 'PROVIDER_SIGNATURE');
    s.submission = { revision: s.revision, termsHash: s.termsHash, resultHash };
    s.status = 'SUBMITTED';
    s.events.push({ type: 'Submitted', ...s.submission });
    return this.snapshot();
  }
  accept(message, signature) {
    const s = this.#state;
    check(s.status === 'SUBMITTED', 'NOT_SUBMITTED'); this.#live(message);
    check(uint(message.revision, 64) === s.submission.revision && hash(message.termsHash) === s.submission.termsHash
      && hash(message.resultHash) === s.submission.resultHash, 'SUBMISSION_MISMATCH');
    check(this.#signer('Acceptance', message, signature) === s.buyer, 'BUYER_SIGNATURE');
    s.providerPaid += s.escrow; s.escrow = 0n; s.status = 'ACCEPTED';
    s.events.push({ type: 'Accepted', ...s.submission, paid: s.providerPaid });
    return this.snapshot();
  }
}
