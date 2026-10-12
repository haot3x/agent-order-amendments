import { Wallet, id } from 'ethers';
import { OrderModel, typed, json } from './src/protocol.mjs';

// Ephemeral test wallets. No connection to a network; no real money or USDC.
const buyer = Wallet.createRandom(), provider = Wallet.createRandom();
const model = new OrderModel({
  domain: { name: 'AgentServiceOrderAmendments', version: '0.1', chainId: 31337n,
    verifyingContract: '0x0000000000000000000000000000000000000001' },
  orderId: id('demo-order-1'), buyer: buyer.address, provider: provider.address,
  asset: '0x0000000000000000000000000000000000000002',
  terms: { scopeHash: id('3 projects, report'), acceptanceHash: id('3 projects with sources'), totalPrice: 100_000_000n, deadline: 2000n },
  buyerBalance: 500_000_000n, now: () => 1000n,
});
const next = { scopeHash: id('10 projects, report and spreadsheet'), acceptanceHash: id('10 projects with sources and spreadsheet'), totalPrice: 180_000_000n, deadline: 3000n };
const amendment = model.amendment(next, 1500n);
const signatures = await Promise.all([buyer, provider].map(w => w.signTypedData(model.domain, typed('Amendment'), amendment)));
model.applyAmendment(amendment, next, ...signatures);
const s = model.snapshot();
const delivery = { orderId: s.orderId, revision: s.revision, termsHash: s.termsHash, resultHash: id('demo report and spreadsheet bytes'), validUntil: 1500n };
model.submit(delivery, await provider.signTypedData(model.domain, typed('Submission'), delivery));
model.accept(delivery, await buyer.signTypedData(model.domain, typed('Acceptance'), delivery));
console.log('LOCAL SIMULATION ONLY: 100 -> 180 mock units; both parties signed; revised deliverable accepted.');
console.log(json(model.snapshot()));
