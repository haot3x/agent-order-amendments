// Runs ERC-8448 order lifecycles on a local chain through WorkRecordOrderFixture and captures what an ERC-8505 reader
// needs: the source descriptor, the source's logs and the receipts of the money transactions. Used by the vector
// generator and by the tests. Local Anvil only; nothing here can be re-read from a public chain.
import { getAddress, id, MaxUint256 } from 'ethers';
import { localEvm } from './local-evm.mjs';
import { compile } from './compile.mjs';
import { domain, hashTerms, buildPayload, buildIntent, hashIntent, buildAcceptance, INTENT_TYPES, ACCEPTANCE_TYPES } from '../src/profile.mjs';

export const FIXTURE = 'contracts/test/WorkRecordOrderFixture.sol';
const DEADLINE = 2000100000n;
const send = async (promise) => (await promise).wait();
const plainLog = (l) => ({ address: l.address, topics: [...l.topics], data: l.data, blockNumber: l.blockNumber, logIndex: l.index, transactionHash: l.transactionHash });

/** The descriptor of a deployed WorkRecordOrderFixture. `fromBlock` is its deployment block. */
export function descriptorOf({ chainId, contract, asset, fromBlock }) {
  return {
    chainId,
    contract: getAddress(contract),
    asset: `eip155:${chainId}/erc20:${getAddress(asset)}`,
    fromBlock,
    finality: 1,
    events: [
      { step: 'funded', event: 'TaskFunded(uint256 indexed task, address indexed client, uint256 amount, bytes32 brief)',
        fields: { task: 'task', client: 'client', amount: 'amount', brief: 'brief' } },
      { step: 'assigned', event: 'WorkerAssigned(uint256 indexed task, address indexed worker)',
        fields: { task: 'task', worker: 'worker' }, actor: 'worker' },
      { step: 'supplemented', event: 'TaskSupplemented(uint256 indexed task, uint256 amount, bytes32 brief)',
        fields: { task: 'task', amount: 'amount', brief: 'brief' } },
      { step: 'delivered', event: 'WorkDelivered(uint256 indexed task, address indexed worker, bytes32 result)',
        fields: { task: 'task', worker: 'worker', result: 'result' } },
      { step: 'verdict', event: 'Verdict(uint256 indexed task, address indexed evaluator, bool accepted, bytes32 ref)',
        fields: { task: 'task', evaluator: 'evaluator', accepted: 'accepted', ref: 'ref' } },
      { step: 'paid', event: 'TaskPaid(uint256 indexed task, address indexed worker, address indexed to, uint256 amount, uint256 fee)',
        fields: { task: 'task', worker: 'worker', to: 'to', amount: 'amount', fee: 'fee' }, feeIncluded: false },
      { step: 'refunded', event: 'TaskRefunded(uint256 indexed task, address indexed to, uint256 amount)',
        fields: { task: 'task', to: 'to', amount: 'amount' } },
    ],
  };
}

export async function runScenarios() {
  const env = await localEvm(compile([FIXTURE]));
  try {
    const [buyer, provider, executor] = env.signers;
    const [buyerKey, providerKey] = env.wallets;
    const token = await env.deploy('TestToken');
    const core = await env.deploy('WorkRecordOrderFixture', [token.target]);
    const fromBlock = (await core.deploymentTransaction().wait()).blockNumber;
    await send(token.mint(buyer.address, 10000n));
    await send(token.approve(core.target, MaxUint256));

    const terms = (name, totalPrice, criteria = 'criteria-0') => ({ scopeHash: id(`${name}/scope/${totalPrice}`), acceptanceHash: id(`${name}/${criteria}`), totalPrice, deadline: DEADLINE });
    const open = async (name, price) => {
      const orderId = id(`work-record/${name}`);
      const initial = terms(name, price);
      await send(core.offerOrder(orderId, provider.address, initial));
      await send(core.connect(provider).activateOrder(orderId));
      return { orderId, name, briefs: [hashTerms(initial)] };
    };
    // One fully signed amendment; returns whether the isolated application call succeeded.
    const amend = async (order, next) => {
      const o = await core.getOrder(order.orderId);
      const payload = buildPayload({ orderContract: core.target, orderId: order.orderId, baseRevision: o.revision,
        baseTermsHash: o.termsHash, amendmentNonce: o.amendmentNonce, newTermsHash: hashTerms(next), newTerms: next,
        validUntil: 2000095000n }, 2000000000n);
      const intent = buildIntent({ payload, expiry: 2000090000n, nonce: await core.getAgentNonce(buyer.address) + 1n,
        agentId: buyer.address, participants: [buyer.address, provider.address] });
      await send(core.proposeCoordination(intent, await buyerKey.signTypedData(domain(core.target), INTENT_TYPES, intent), payload));
      const h = hashIntent(intent);
      for (const [signer, key] of [[buyer, buyerKey], [provider, providerKey]]) {
        const acceptance = buildAcceptance(intent, signer.address);
        await send(core.connect(signer).acceptCoordination(h, { ...acceptance,
          signature: await key.signTypedData(domain(core.target), ACCEPTANCE_TYPES, acceptance) }));
      }
      const receipt = await send(core.connect(executor).executeCoordination(h, payload, '0x', { gasLimit: 2000000 }));
      const executed = receipt.logs.map((l) => { try { return core.interface.parseLog(l); } catch { return null; } })
        .find((l) => l?.name === 'CoordinationExecuted');
      if (executed.args.success) order.briefs.push(hashTerms(next));
      return executed.args.success;
    };
    const deliverAndAccept = async (order) => {
      const o = await core.getOrder(order.orderId);
      const result = id(`work-record/${order.name}/result`);
      await send(core.connect(provider).submit(order.orderId, o.revision, o.termsHash, result));
      await send(core.acceptDelivery(order.orderId, o.revision, o.termsHash, result));
    };

    // 100 -> 180, delivered, accepted, paid 180.
    const increase = await open('price-increase', 100n);
    await amend(increase, terms('price-increase', 180n));
    await deliverAndAccept(increase);

    // Criteria change at an unchanged price: the terms hash changes and no token moves.
    const samePrice = await open('same-price', 100n);
    await amend(samePrice, terms('same-price', 100n, 'criteria-1'));
    await deliverAndAccept(samePrice);

    // 100 -> 180 -> 220, paid 220.
    const twice = await open('two-amendments', 100n);
    await amend(twice, terms('two-amendments', 180n));
    await amend(twice, terms('two-amendments', 220n));
    await deliverAndAccept(twice);

    // The top-up cannot be collected: the application call reverts, the order keeps its terms, and it pays 100.
    const failed = await open('failed-top-up', 100n);
    await send(token.approve(core.target, 0n));
    const applied = await amend(failed, terms('failed-top-up', 180n));
    if (applied) throw new Error('the unfunded amendment applied');
    await send(token.approve(core.target, MaxUint256));
    await deliverAndAccept(failed);

    // Never amended: the baseline both readers agree on.
    const plain = await open('never-amended', 100n);
    await deliverAndAccept(plain);

    // 100 -> 180, never delivered, refunded 180 after the deadline.
    const lapsed = await open('amended-then-lapsed', 100n);
    await amend(lapsed, terms('amended-then-lapsed', 180n));
    await env.rpc.send('evm_setNextBlockTimestamp', [Number(DEADLINE)]);
    await send(core.connect(executor).refundExpiredOrder(lapsed.orderId));

    const { chainId } = await env.rpc.getNetwork();
    const source = descriptorOf({ chainId: Number(chainId), contract: core.target, asset: token.target, fromBlock });
    const declared = new Set(source.events.map((e) => core.interface.getEvent(e.event.slice(0, e.event.indexOf('('))).topicHash));
    const logs = (await env.rpc.getLogs({ address: core.target, fromBlock, toBlock: 'latest' })).filter((l) => declared.has(l.topics[0]));
    const moneyTopics = new Set(['TaskFunded', 'TaskSupplemented', 'TaskPaid', 'TaskRefunded'].map((n) => core.interface.getEvent(n).topicHash));
    const receipts = {};
    for (const tx of new Set(logs.filter((l) => moneyTopics.has(l.topics[0])).map((l) => l.transactionHash))) {
      receipts[tx] = { logs: (await env.rpc.getTransactionReceipt(tx)).logs.map(plainLog) };
    }
    const tasks = [increase, samePrice, twice, failed, plain, lapsed].map((o) => ({ name: o.name, task: BigInt(o.orderId).toString(), briefs: o.briefs }));
    return { source, logs: logs.map(plainLog), receipts, tasks, parties: { client: buyer.address, worker: provider.address } };
  } finally {
    await env.close();
  }
}
