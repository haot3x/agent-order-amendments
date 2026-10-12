import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, id, ZeroHash } from 'ethers';
import { OrderModel, typed } from '../src/protocol.mjs';

function fixture(overrides = {}) {
  const buyer = Wallet.createRandom(), provider = Wallet.createRandom(), outsider = Wallet.createRandom();
  let time = 1000n;
  const terms = { scopeHash: id('3 projects'), acceptanceHash: id('3 sources'), totalPrice: 100n, deadline: 2000n };
  const model = new OrderModel({
    domain: { name: 'AgentServiceOrderAmendments', version: '0.1', chainId: 31337n,
      verifyingContract: '0x0000000000000000000000000000000000000001' },
    orderId: id('order-1'), buyer: buyer.address, provider: provider.address,
    asset: '0x0000000000000000000000000000000000000002',
    terms, buyerBalance: 500n, now: () => time, ...overrides,
  });
  const next = { ...terms, scopeHash: id('10 projects'), acceptanceHash: id('10 sources'), totalPrice: 180n, deadline: 3000n };
  const sign = (wallet, kind, value, domain = model.domain) => wallet.signTypedData(domain, typed(kind), value);
  const signatures = async (a) => Promise.all([sign(buyer, 'Amendment', a), sign(provider, 'Amendment', a)]);
  const delivery = () => { const s = model.snapshot(); return { orderId: s.orderId, revision: s.revision, termsHash: s.termsHash, resultHash: id('result'), validUntil: 1500n }; };
  return { buyer, provider, outsider, model, terms, next, sign, signatures, delivery, setTime: v => { time = v; } };
}

test('signed amendment locks the supplement and keeps historical terms', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n);
  const s = f.model.applyAmendment(a, f.next, ...await f.signatures(a));
  assert.equal(s.revision, 1n); assert.equal(s.escrow, 180n); assert.equal(s.buyerAvailable, 320n);
  assert.deepEqual(s.history[0].terms, f.terms); assert.deepEqual(s.history[1].terms, f.next);
  assert.equal(s.buyerAvailable + s.escrow + s.providerPaid, 500n);
});

test('neither a missing signature nor a stranger authorizes the supplement', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n), before = f.model.snapshot();
  const bs = await f.sign(f.buyer, 'Amendment', a);
  assert.throws(() => f.model.applyAmendment(a, f.next, bs, '0x'), /INVALID_SIGNATURE/);
  const wrong = await f.sign(f.outsider, 'Amendment', a);
  assert.throws(() => f.model.applyAmendment(a, f.next, wrong, bs), /BUYER_SIGNATURE/);
  assert.deepEqual(f.model.snapshot(), before);
});

test('signed terms cannot be substituted', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n), sigs = await f.signatures(a);
  const before = f.model.snapshot();
  assert.throws(() => f.model.applyAmendment(a, { ...f.next, acceptanceHash: id('easier criteria') }, ...sigs), /TERMS_MISMATCH/);
  assert.deepEqual(f.model.snapshot(), before);
});

test('insufficient funds leaves nonce, terms, history and balances untouched', async () => {
  const f = fixture({ buyerBalance: 110n }), a = f.model.amendment(f.next, 1500n), before = f.model.snapshot();
  const sigs = await f.signatures(a);
  assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /INSUFFICIENT_FUNDS/);
  assert.deepEqual(f.model.snapshot(), before);
});

test('expiry is exclusive at validUntil', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n), sigs = await f.signatures(a);
  f.setTime(1500n);
  assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /EXPIRED/);
});

test('expired base order cannot be resurrected by an amendment', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 2500n), sigs = await f.signatures(a);
  f.setTime(2000n);
  assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /ORDER_DEADLINE/);
});

test('chained amendments use the current deadline and price, and invalidate competing changes', async () => {
  const f = fixture(), first = f.model.amendment(f.next, 1500n);
  f.model.applyAmendment(first, f.next, ...await f.signatures(first));
  // The initial deadline has passed; the agreed revision 1 deadline has not.
  f.setTime(2500n);
  const thirdTerms = { ...f.next, totalPrice: 220n, deadline: 4000n };
  const competingTerms = { ...thirdTerms, totalPrice: 230n };
  const second = f.model.amendment(thirdTerms, 2900n);
  const competing = f.model.amendment(competingTerms, 2900n);
  const secondSignatures = await f.signatures(second);
  const competingSignatures = await f.signatures(competing);
  const s = f.model.applyAmendment(second, thirdTerms, ...secondSignatures);
  assert.equal(s.revision, 2n); assert.equal(s.nonce, 2n);
  assert.equal(s.escrow, 220n); assert.equal(s.buyerAvailable, 280n);
  assert.deepEqual(s.events.filter(e => e.type === 'AmendmentApplied').map(e => e.delta), [80n, 40n]);
  assert.deepEqual(s.history.map(h => h.terms.totalPrice), [100n, 180n, 220n]);
  assert.equal(s.buyerAvailable + s.escrow + s.providerPaid, 500n);
  assert.throws(() => f.model.applyAmendment(competing, competingTerms, ...competingSignatures), /STALE_REVISION/);
  assert.deepEqual(f.model.snapshot(), s);
});

test('chained amendments cannot revive an order at the current deadline', async () => {
  const f = fixture(), first = f.model.amendment(f.next, 1500n);
  f.model.applyAmendment(first, f.next, ...await f.signatures(first));
  const thirdTerms = { ...f.next, totalPrice: 220n, deadline: 4000n };
  const second = f.model.amendment(thirdTerms, 3500n), sigs = await f.signatures(second);
  f.setTime(3000n);
  const before = f.model.snapshot();
  assert.throws(() => f.model.applyAmendment(second, thirdTerms, ...sigs), /ORDER_DEADLINE/);
  assert.deepEqual(f.model.snapshot(), before);
});

test('failed funding of a second amendment preserves the already accepted revision', async () => {
  const f = fixture({ buyerBalance: 200n }), first = f.model.amendment(f.next, 1500n);
  f.model.applyAmendment(first, f.next, ...await f.signatures(first));
  f.setTime(2500n);
  const thirdTerms = { ...f.next, totalPrice: 220n, deadline: 4000n };
  const second = f.model.amendment(thirdTerms, 2900n), sigs = await f.signatures(second);
  const before = f.model.snapshot();
  assert.equal(before.revision, 1n); assert.equal(before.escrow, 180n); assert.equal(before.buyerAvailable, 20n);
  assert.throws(() => f.model.applyAmendment(second, thirdTerms, ...sigs), /INSUFFICIENT_FUNDS/);
  assert.deepEqual(f.model.snapshot(), before);
});

test('replay and competing amendments from the same revision cannot both apply', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n);
  const alternative = { ...f.next, totalPrice: 190n }, b = f.model.amendment(alternative, 1500n);
  const sigs = await f.signatures(a), bsigs = await f.signatures(b);
  f.model.applyAmendment(a, f.next, ...sigs);
  const after = f.model.snapshot();
  assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /STALE_REVISION/);
  assert.throws(() => f.model.applyAmendment(b, alternative, ...bsigs), /STALE_REVISION/);
  assert.deepEqual(f.model.snapshot(), after);
});

test('signatures are bound to the chain and verifying contract', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n);
  for (const domain of [{ ...f.model.domain, chainId: 1n }, { ...f.model.domain, verifyingContract: '0x0000000000000000000000000000000000000003' }]) {
    const sigs = await Promise.all([f.buyer, f.provider].map(w => f.sign(w, 'Amendment', a, domain)));
    assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /BUYER_SIGNATURE/);
  }
});

test('another order cannot reuse signed amendments', async () => {
  const f = fixture(), a = { ...f.model.amendment(f.next, 1500n), orderId: id('other-order') };
  const sigs = await f.signatures(a);
  assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /WRONG_ORDER/);
});

test('either party can invalidate pending proposals without cancelling work', async () => {
  for (const party of ['buyer', 'provider']) {
    const f = fixture(), a = f.model.amendment(f.next, 1500n), sigs = await f.signatures(a);
    const m = { orderId: a.orderId, nonce: 0n, validUntil: 1500n };
    f.model.invalidate(m, await f.sign(f[party], 'Invalidation', m));
    assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /STALE_NONCE/);
    const s = f.model.snapshot();
    assert.equal(s.status, 'ACTIVE'); assert.equal(s.revision, 0n); assert.equal(s.escrow, 100n);
  }
});

test('a stranger cannot invalidate a signed offer', async () => {
  const f = fixture(), m = { orderId: f.model.snapshot().orderId, nonce: 0n, validUntil: 1500n };
  const signature = await f.sign(f.outsider, 'Invalidation', m);
  assert.throws(() => f.model.invalidate(m, signature), /PARTY_SIGNATURE/);
});

test('submitted work freezes amendment eligibility and acceptance binds exact evidence', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n), sigs = await f.signatures(a), d = f.delivery();
  f.model.submit(d, await f.sign(f.provider, 'Submission', d));
  assert.throws(() => f.model.applyAmendment(a, f.next, ...sigs), /NOT_ACTIVE/);
  const changed = { ...d, resultHash: id('different result') };
  const signature = await f.sign(f.buyer, 'Acceptance', changed);
  assert.throws(() => f.model.accept(changed, signature), /SUBMISSION_MISMATCH/);
  assert.equal(f.model.snapshot().escrow, 100n);
});

test('amended work settles once to its provider with conservation of mock balances', async () => {
  const f = fixture(), a = f.model.amendment(f.next, 1500n);
  f.model.applyAmendment(a, f.next, ...await f.signatures(a));
  const d = f.delivery();
  f.model.submit(d, await f.sign(f.provider, 'Submission', d));
  const signature = await f.sign(f.buyer, 'Acceptance', d);
  const s = f.model.accept(d, signature);
  assert.equal(s.status, 'ACCEPTED'); assert.equal(s.providerPaid, 180n); assert.equal(s.escrow, 0n);
  assert.equal(s.buyerAvailable + s.providerPaid, 500n);
  assert.throws(() => f.model.accept(d, signature), /NOT_SUBMITTED/);
});

test('delivery cannot refer to the old scope after a change', async () => {
  const f = fixture(), d = f.delivery(), sig = await f.sign(f.provider, 'Submission', d), a = f.model.amendment(f.next, 1500n);
  f.model.applyAmendment(a, f.next, ...await f.signatures(a));
  assert.throws(() => f.model.submit(d, sig), /STALE_REVISION/);
});

test('amendment signatures do not serve as acceptance signatures', async () => {
  const f = fixture(), d = f.delivery();
  f.model.submit(d, await f.sign(f.provider, 'Submission', d));
  const submissionSignature = await f.sign(f.buyer, 'Submission', d);
  assert.throws(() => f.model.accept(d, submissionSignature), /BUYER_SIGNATURE/);
});

test('prototype restricts price decreases and deadline shortening', async () => {
  const f = fixture();
  for (const [t, error] of [[{ ...f.next, totalPrice: 50n }, /PRICE_DECREASE/], [{ ...f.next, deadline: 1900n }, /DEADLINE_SHORTENING/]]) {
    const a = f.model.amendment(t, 1500n), sigs = await f.signatures(a);
    assert.throws(() => f.model.applyAmendment(a, t, ...sigs), error);
  }
});

test('snapshots cannot mutate internal authority or balances', () => {
  const f = fixture(), s = f.model.snapshot(), domain = f.model.domain;
  s.buyer = f.outsider.address; s.buyerAvailable = 1000000n; s.history[0].terms.totalPrice = 0n;
  domain.chainId = 1n;
  assert.equal(f.model.snapshot().buyer, f.buyer.address);
  assert.equal(f.model.snapshot().buyerAvailable, 400n);
  assert.equal(f.model.snapshot().history[0].terms.totalPrice, 100n);
  assert.equal(f.model.domain.chainId, 31337n);
});

test('hashes and integers have an unambiguous encoding', () => {
  const f = fixture();
  assert.throws(() => f.model.amendment({ ...f.next, totalPrice: 180 }, 1500n), /INTEGER_FORMAT/);
  assert.throws(() => f.model.amendment({ ...f.next, scopeHash: ZeroHash }, 1500n), /HASH_FORMAT/);
  assert.throws(() => f.model.amendment({ ...f.next, extra: 'not signed' }, 1500n), /TERMS_FIELDS/);
  assert.throws(() => f.model.amendment({ ...f.next, deadline: 2n ** 64n }, 1500n), /INTEGER_RANGE/);
});
