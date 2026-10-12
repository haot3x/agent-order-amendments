import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id, keccak256, toUtf8Bytes, parseUnits, formatUnits } from 'ethers';
import { localEvm } from './local-evm.mjs';
import { domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES } from '../src/profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = resolve(root, 'artifacts/local-order-demo');
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const hashDocument = value => keccak256(toUtf8Bytes(json(value)));
const units = value => parseUnits(String(value), 18);
const statusNames = ['None', 'Offered', 'Active', 'Submitted', 'Accepted', 'Cancelled', 'Refunded'];
const transactions = [], checkpoints = [];
const projects = JSON.parse(await readFile(resolve(root, 'examples/finch-demo/projects.json'), 'utf8'));

console.log('Finch-style local order demo — synthetic projects, disposable TEST tokens, no public network.');
const env = await localEvm();
try {
  const [buyer, provider, relayer] = env.signers;
  const token = await env.deploy('TestToken');
  const order = await env.deploy('ExperimentalOrderAmendments', [token.target]);
  const chainId = (await env.rpc.getNetwork()).chainId;
  assert.equal(chainId, 31337n);
  const now = BigInt((await env.rpc.getBlock('latest')).timestamp);
  const orderId = id('finch-demo-research-order');

  async function tx(label, promise) {
    const receipt = await (await promise).wait();
    assert.equal(receipt.status, 1, label);
    const events = receipt.logs.flatMap(log => {
      const contract = log.address.toLowerCase() === order.target.toLowerCase() ? order
        : log.address.toLowerCase() === token.target.toLowerCase() ? token : null;
      if (!contract) return [];
      const parsed = contract.interface.parseLog(log);
      return [{ contract: log.address, event: parsed.name, args: parsed.args.toObject(true) }];
    });
    transactions.push({ label, hash: receipt.hash, block: receipt.blockNumber, events });
    return events;
  }
  async function checkpoint(label, oid = orderId, extra = {}) {
    const o = await order.getOrder(oid);
    const balances = {};
    for (const [name, address] of Object.entries({ buyer: buyer.address, provider: provider.address, escrowContract: order.target })) {
      balances[name] = formatUnits(await token.balanceOf(address), 18);
    }
    const point = { label, orderId: oid, status: statusNames[Number(o.status)], revision: o.revision,
      orderEscrow: formatUnits(o.escrow, 18), termsHash: o.termsHash, resultHash: o.resultHash, balances, ...extra };
    checkpoints.push(point);
    console.log(`${label}: ${point.status}, revision=${o.revision}, order escrow=${point.orderEscrow} TEST; buyer=${balances.buyer}, provider=${balances.provider}`);
    return o;
  }

  // Both versions commit to exact UTF-8 document bytes, saved alongside receipts.
  const scope0 = { task: 'List 3 synthetic projects from the local fixture', projectIds: projects.slice(0, 3).map(p => p.id) };
  const criteria0 = { projectIds: scope0.projectIds, requiredFields: ['id', 'name', 'category', 'source'], sourceRule: 'Every row must exactly match its local fixture record' };
  const scope1 = { task: 'Expand the same order to 10 synthetic projects', projectIds: projects.map(p => p.id) };
  const criteria1 = { ...criteria0, projectIds: scope1.projectIds };
  const originalTerms = { scopeHash: hashDocument(scope0), acceptanceHash: hashDocument(criteria0), totalPrice: units(100), deadline: now + 86400n };
  const amendedTerms = { scopeHash: hashDocument(scope1), acceptanceHash: hashDocument(criteria1), totalPrice: units(180), deadline: now + 172800n };

  await tx('Mint local test funds', token.mint(buyer.address, units(1000)));
  await tx('Approve initial 100', token.approve(order.target, units(100)));
  await tx('Offer order for 100', order.offerOrder(orderId, provider.address, originalTerms));
  await checkpoint('1. Buyer funds the order');
  await tx('Provider accepts original order', order.connect(provider).activateOrder(orderId));
  const base = await checkpoint('2. Provider starts work');

  const amendmentData = { orderContract: order.target, orderId, baseRevision: base.revision, baseTermsHash: base.termsHash,
    amendmentNonce: base.amendmentNonce, newTermsHash: hashTerms(amendedTerms), newTerms: amendedTerms, validUntil: now + 3600n };
  const payload = buildPayload(amendmentData, now);
  const intent = buildIntent({ payload, expiry: now + 3600n, nonce: 1n, agentId: buyer.address, participants: [buyer.address, provider.address] });
  const intentHash = hashIntent(intent);
  const intentSignature = await env.wallets[0].signTypedData(domain(order.target, chainId), INTENT_TYPES, intent);
  await tx('Propose signed amendment', order.proposeCoordination(intent, intentSignature, payload));
  const acceptances = [];
  for (const [index, party] of [buyer, provider].entries()) {
    const message = buildAcceptance(intent, party.address);
    const acceptance = { ...message, signature: await env.wallets[index].signTypedData(domain(order.target, chainId), ACCEPTANCE_TYPES, message) };
    acceptances.push(acceptance);
    await tx(`${index === 0 ? 'Buyer' : 'Provider'} signs amendment acceptance`, order.connect(party).acceptCoordination(intentHash, acceptance));
  }
  assert.equal((await order.getCoordinationStatus(intentHash)).status, 2n);
  const pending = await checkpoint('3. Both agreed; amendment is Ready', orderId, { coordinationStatus: 'Ready' });
  assert.equal(pending.revision, 0n);
  assert.equal(pending.escrow, units(100));
  await tx('Approve only the supplemental 80', token.approve(order.target, units(80)));
  const applied = await tx('Relayer applies amendment and collects 80', order.connect(relayer).executeCoordination(intentHash, payload, '0x'));
  assert.equal(applied.find(e => e.event === 'CoordinationExecuted').args.success, true);
  assert.equal(applied.find(e => e.event === 'OrderAmendmentApplied').args.supplement, units(80));
  const current = await checkpoint('4. Supplement funded; new version is effective', orderId, { coordinationStatus: 'Executed', applicationSuccess: true });
  assert.equal(current.revision, 1n);
  assert.equal(current.termsHash, hashTerms(amendedTerms));
  assert.equal(current.escrow, units(180));

  // Deterministic stand-in for an agent's output. No LLM, live research or Finch
  // backend is called. The buyer checks agreed structure/fixture correspondence.
  const report = { synthetic: true, title: 'Ten-project local research fixture', projects: projects.map(p => ({ ...p })) };
  const resultHash = hashDocument(report);
  await tx('Provider submits revision 1 deliverable', order.connect(provider).submit(orderId, current.revision, current.termsHash, resultHash));
  await checkpoint('5. Work submitted; payment awaits buyer review');
  const submitted = await order.getOrder(orderId);
  assert.equal(hashDocument(criteria1), submitted.terms.acceptanceHash);
  assert.equal(hashDocument(report), submitted.resultHash);
  assert.deepEqual(report.projects.map(p => p.id).sort(), [...criteria1.projectIds].sort());
  for (const row of report.projects) {
    const source = projects.find(p => p.id === row.id);
    for (const field of criteria1.requiredFields) assert.equal(row[field], source[field]);
  }
  console.log('   Buyer-side checks passed: 10 agreed IDs, required fields, fixture correspondence, exact result hash.');
  await tx('Buyer accepts exact delivery; provider receives 180', order.acceptDelivery(orderId, submitted.revision, submitted.termsHash, submitted.resultHash));
  const settled = await checkpoint('6. Buyer accepted and provider was paid', orderId, { review: 'BuyerApproved', payment: 'Paid', amount: '180.0' });
  assert.equal(settled.status, 4n);
  assert.equal(settled.escrow, 0n);
  assert.equal(await token.balanceOf(provider.address), units(180));

  const cancelledId = id('finch-demo-cancelled-offer');
  await tx('Approve 40 for cancellable offer', token.approve(order.target, units(40)));
  await tx('Create unactivated offer', order.offerOrder(cancelledId, provider.address, { ...originalTerms, totalPrice: units(40) }));
  await tx('Buyer cancels offer and receives 40 back', order.cancelOfferedOrder(cancelledId));
  const cancelled = await checkpoint('7. Unactivated offer cancelled and refunded', cancelledId);
  assert.equal(cancelled.status, 5n);
  assert.equal(cancelled.escrow, 0n);

  const expiredId = id('finch-demo-expired-order');
  const expiry = now + 7200n;
  await tx('Approve 60 for expiry example', token.approve(order.target, units(60)));
  await tx('Create timeout example', order.offerOrder(expiredId, provider.address, { ...originalTerms, totalPrice: units(60), deadline: expiry }));
  await tx('Provider starts timeout example', order.connect(provider).activateOrder(expiredId));
  await env.rpc.send('evm_setNextBlockTimestamp', [Number(expiry)]);
  await tx('No delivery by deadline; relayer refunds 60 to buyer', order.connect(relayer).refundExpiredOrder(expiredId, { gasLimit: 500000 }));
  const refunded = await checkpoint('8. Undelivered order timed out and was refunded', expiredId);
  assert.equal(refunded.status, 6n);
  assert.equal(refunded.escrow, 0n);
  assert.equal(await token.balanceOf(buyer.address), units(820));
  assert.equal(await token.balanceOf(provider.address), units(180));
  assert.equal(await token.balanceOf(order.target), 0n);

  await mkdir(outputDir, { recursive: true });
  const documents = { 'scope-v0.json': scope0, 'criteria-v0.json': criteria0, 'scope-v1.json': scope1,
    'criteria-v1.json': criteria1, 'delivery.json': report,
    'signed-amendment.json': { domain: domain(order.target, chainId), amendmentData, payload, intent, intentSignature, acceptances },
    'receipt.json': { localOnly: true, chainId, asset: token.target, contract: order.target,
      parties: { buyer: buyer.address, provider: provider.address, relayer: relayer.address },
      unit: 'TEST (18 decimals); raw event amounts are base units', originalTerms, amendedTerms, checkpoints, transactions } };
  for (const [name, contents] of Object.entries(documents)) await writeFile(resolve(outputDir, name), json(contents));
  console.log(`\nPASS: provider received 180 TEST once; both refunds returned to buyer; escrow balance is zero.\nSaved documents, signatures and transaction receipts: ${outputDir}\nThe disposable local chain is now stopped. Receipts are local evidence, not public explorer records.`);
} finally {
  await env.close();
}
