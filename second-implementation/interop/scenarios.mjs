// Drives one ERC-8448 implementation through a fixed set of scenarios using only the spec-level client, and returns
// what an outside observer sees. The same scenarios run against each implementation; the tests compare the results.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, ContractFactory, HDNodeWallet, JsonRpcProvider, MaxUint256, Wallet, id } from 'ethers';
import { COMMON_ABI, STATUS, common, hashIntent, hashTerms, prepareAmendment } from './client.mjs';
import { compile } from '../../scripts/compile.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// The reference implementation and its disposable test contracts, compiled from this repository's sources.
let built;
const reference = (name) => (built ??= compile())[name];
const GENESIS = 2000000000;
const DEADLINE = 2000100000n;
const coder = AbiCoder.defaultAbiCoder();
const send = async (promise) => (await promise).wait();
const TRANSFER = id('Transfer(address,address,uint256)');

export async function startChain() {
  const proc = spawn(process.execPath, [here('../../node_modules/@foundry-rs/anvil/bin.mjs'), '--host', '127.0.0.1', '--port', '0',
    '--chain-id', '31337', '--hardfork', 'cancun', '--timestamp', String(GENESIS)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(new Error('local chain startup timeout')); }, 15000);
    proc.once('error', (e) => { clearTimeout(timeout); reject(e); });
    proc.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`local chain exited (${code})`)); });
    const read = (chunk) => { output += chunk.toString(); const m = output.match(/Listening on (127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timeout); resolve(`http://${m[1]}`); } };
    proc.stdout.on('data', read); proc.stderr.on('data', read);
  });
  const rpc = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 20 });
  const keys = [0, 1, 2].map((i) => HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${i}`));
  const signers = await Promise.all(keys.map((w) => rpc.getSigner(w.address)));
  return { rpc, keys, signers, close: async () => { rpc.destroy(); if (proc.exitCode === null) { const done = once(proc, 'exit'); proc.kill('SIGTERM'); await done; } } };
}

/** The two implementations: how to deploy each and how to reach its application-defined order API. */
export const IMPLEMENTATIONS = {
  reference: {
    label: 'reference (contracts/ExperimentalOrderAmendments.sol)',
    artifact: () => reference('ExperimentalOrderAmendments'),
    constructorArgs: (token) => [token],
    open: async (c, orderId, provider, token, terms) => { await send(c.offerOrder(orderId, provider.address, terms)); await send(c.connect(provider).activateOrder(orderId)); },
    offer: (c, orderId, provider, token, terms) => send(c.offerOrder(orderId, provider.address, terms)),
    submit: (c, provider, orderId, revision, termsHash, result) => send(c.connect(provider).submit(orderId, revision, termsHash, result)),
    offerData: (c, orderId, provider, token, terms) => c.interface.encodeFunctionData('offerOrder', [orderId, provider, terms]),
    agreeData: (c, orderId) => c.interface.encodeFunctionData('activateOrder', [orderId]),
  },
  second: {
    label: 'second (clean-room, Foundry)',
    artifact: () => { const a = JSON.parse(readFileSync(here('../impl/out/AgentOrderAmendments.sol/AgentOrderAmendments.json'), 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object }; },
    constructorArgs: () => [],
    open: async (c, orderId, provider, token, terms) => { await send(c.createOrder(orderId, provider.address, token, terms)); await send(c.connect(provider).agreeOrder(orderId, hashTerms(terms))); },
    offer: (c, orderId, provider, token, terms) => send(c.createOrder(orderId, provider.address, token, terms)),
    submit: (c, provider, orderId, revision, termsHash, result) => send(c.connect(provider).submitWork(orderId, revision, termsHash, result)),
    offerData: (c, orderId, provider, token, terms) => c.interface.encodeFunctionData('createOrder', [orderId, provider, token, terms]),
    agreeData: (c, orderId, terms) => c.interface.encodeFunctionData('agreeOrder', [orderId, hashTerms(terms)]),
  },
};

const viewOf = (s) => ({ buyer: s.buyer, provider: s.provider, revision: s.revision.toString(), termsHash: s.termsHash,
  amendmentNonce: s.amendmentNonce.toString(), terms: { scopeHash: s.terms.scopeHash, acceptanceHash: s.terms.acceptanceHash,
    totalPrice: s.terms.totalPrice.toString(), deadline: s.terms.deadline.toString() }, eligible: s.eligible });

/** Runs every scenario against one implementation on its own fresh chain. */
export async function observe(name) {
  const impl = IMPLEMENTATIONS[name];
  const chain = await startChain();
  try {
    const { rpc, keys, signers } = chain;
    const [buyer, provider, relayer] = signers;
    const [buyerKey, providerKey] = keys;
    const tokenArtifact = reference('TestToken');
    const token = await (await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, buyer).deploy()).waitForDeployment();
    const built = impl.artifact();
    const full = await (await new ContractFactory(built.abi, built.bytecode, buyer).deploy(...impl.constructorArgs(token.target))).waitForDeployment();
    // Everything below the application-defined setup goes through the spec-level ABI only.
    const c = new Contract(full.target, COMMON_ABI, buyer);
    await send(token.mint(buyer.address, 100000n));
    await send(token.approve(full.target, MaxUint256));
    const B = { address: buyer.address, key: buyerKey };
    const P = { address: provider.address, key: providerKey };
    const defaults = { initiator: B, signers: [B, P], expiry: 2000090000n, validUntil: 2000095000n, timestamp: BigInt(GENESIS) };
    const terms = (tag, totalPrice, deadline = DEADLINE) => ({ scopeHash: id(`${tag}/scope`), acceptanceHash: id(`${tag}/criteria`), totalPrice, deadline });
    const open = async (tag, price = 100n) => { const orderId = id(`interop/${tag}`); await impl.open(full, orderId, provider, token.target, terms(`${tag}/0`, price)); return orderId; };
    const state = async (orderId) => viewOf(await c.getAmendmentState(orderId));
    const balances = async () => ({ buyer: (await token.balanceOf(buyer.address)).toString(), held: (await token.balanceOf(full.target)).toString() });
    const status = async (h) => STATUS[Number((await c.getCoordinationStatus(h)).status)];
    const attempt = async (fn) => { try { return { ok: true, receipt: await fn() }; } catch (e) { return { ok: false, error: e }; } };
    const eventsOf = (receipt) => receipt.logs.filter((l) => l.address === full.target).map((l) => { try { return common.parseLog(l); } catch { return null; } }).filter(Boolean);

    // propose + both acceptances; each stage reports whether the transaction was accepted.
    const consent = async (p, { acceptCallers } = {}) => {
      const out = { propose: (await attempt(() => send(c.proposeCoordination(p.intent, p.intentSignature, p.payload)))).ok, accepts: [] };
      if (!out.propose) return out;
      for (const [i, a] of p.acceptances.entries()) {
        const caller = acceptCallers?.[i] ?? (a.participant === buyer.address ? buyer : provider);
        const r = await attempt(() => send(c.connect(caller).acceptCoordination(p.intentHash, a)));
        out.accepts.push(r.ok);
        if (r.ok) out.lastAccepted = eventsOf(r.receipt).find((e) => e.name === 'CoordinationAccepted')?.args.acceptanceHash;
      }
      out.status = await status(p.intentHash);
      return out;
    };
    // executeCoordination from the relayer; reports the outer result and what the receipt holds.
    const execute = async (p, executionData = '0x') => {
      const r = await attempt(() => send(c.connect(relayer).executeCoordination(p.intentHash, p.payload, executionData, { gasLimit: 2000000 })));
      if (!r.ok) return { outer: 'revert', status: await status(p.intentHash) };
      const events = eventsOf(r.receipt);
      const executed = events.find((e) => e.name === 'CoordinationExecuted');
      const applied = events.find((e) => e.name === 'OrderAmendmentApplied');
      const out = { outer: 'mined', success: executed.args.success, executor: executed.args.executor === relayer.address,
        appliedLogs: events.filter((e) => e.name === 'OrderAmendmentApplied').length,
        tokenTransfers: r.receipt.logs.filter((l) => l.address === token.target && l.topics[0] === TRANSFER).length,
        status: await status(p.intentHash) };
      if (applied) out.applied = { intentHash: applied.args.intentHash === p.intentHash, orderId: applied.args.orderId, revision: applied.args.revision.toString(),
        previousTermsHash: applied.args.previousTermsHash, newTermsHash: applied.args.newTermsHash, supplement: applied.args.supplement.toString() };
      if (executed.args.success) {
        const [orderId, revision, newTermsHash, supplement] = coder.decode(['bytes32', 'uint64', 'bytes32', 'uint256'], executed.args.result);
        out.result = { orderId, revision: revision.toString(), newTermsHash, supplement: supplement.toString(), bytes: (executed.args.result.length - 2) / 2 };
      } else out.failureResultBytes = (executed.args.result.length - 2) / 2;
      return out;
    };
    const amend = async (orderId, tag, price, opts = {}) => prepareAmendment(c, 31337n, orderId, (t) => ({ ...t, scopeHash: id(`${tag}/scope`), totalPrice: price, ...opts.terms }), { ...defaults, ...opts });

    const scenarios = {};
    const scenario = async (title, fn) => {
      const snapshot = await rpc.send('evm_snapshot', []);
      try { scenarios[title] = await fn(); } finally { await rpc.send('evm_revert', [snapshot]); }
    };

    await scenario('unknown order', async () => {
      const unknown = id('interop/never-created');
      const data = async (orderId) => { try { await c.getAmendmentState(orderId); return 'returned'; } catch (e) { return e.data; } };
      return { unknown: await data(unknown), expected: common.encodeErrorResult('UnknownOrder', [unknown]),
        zero: await data('0x' + '00'.repeat(32)), expectedZero: common.encodeErrorResult('UnknownOrder', ['0x' + '00'.repeat(32)]) };
    });

    await scenario('offered order is readable and ineligible', async () => {
      const orderId = id('interop/offered');
      await impl.offer(full, orderId, provider, token.target, terms('offered/0', 100n));
      return state(orderId);
    });

    await scenario('100 to 180 through the common view, then 180 to 220', async () => {
      const orderId = await open('happy');
      const before = { state: await state(orderId), balances: await balances() };
      const first = await amend(orderId, 'happy/1', 180n, { terms: { deadline: DEADLINE + 1000n } });
      const hashes = { intentStructHashMatchesClient: first.intentHash === hashIntent(first.intent) };
      const consent1 = await consent(first);
      const afterConsent = { state: await state(orderId), balances: await balances() };
      const exec1 = await execute(first);
      const mid = { state: await state(orderId), balances: await balances() };
      const second = await amend(orderId, 'happy/2', 220n);
      const consent2 = await consent(second);
      const exec2 = await execute(second);
      return { before, hashes, consent1, consentChangedNothing: JSON.stringify(afterConsent) === JSON.stringify(before), exec1, mid,
        consent2, exec2, after: { state: await state(orderId), balances: await balances() }, replay: await execute(first) };
    });

    await scenario('two amendments on one base revision', async () => {
      const orderId = await open('race');
      const a = await amend(orderId, 'race/a', 150n);
      await consent(a);
      const b = await amend(orderId, 'race/b', 170n);
      await consent(b);
      const first = await execute(a);
      const between = { state: await state(orderId), balances: await balances() };
      const second = await execute(b);
      return { first, second, unchangedBySecond: JSON.stringify({ state: await state(orderId), balances: await balances() }) === JSON.stringify(between), state: await state(orderId) };
    });

    await scenario('provider invalidates a fully accepted amendment', async () => {
      const orderId = await open('invalidate');
      const p = await amend(orderId, 'invalidate/1', 180n);
      const consented = await consent(p);
      const before = { state: await state(orderId), balances: await balances() };
      const receipt = await send(c.connect(provider).invalidateAmendments(orderId));
      const e = eventsOf(receipt).find((x) => x.name === 'AmendmentsInvalidated');
      const afterInvalidation = await state(orderId);
      const exec = await execute(p);
      const stranger = (await attempt(() => send(c.connect(relayer).invalidateAmendments(orderId)))).ok;
      return { consented, event: { orderId: e.args.orderId === orderId, participant: e.args.participant === provider.address, amendmentNonce: e.args.amendmentNonce.toString() },
        intentStatusAfterInvalidation: consented.status, afterInvalidation, exec, strangerCanInvalidate: stranger,
        fundsAndTermsIntact: (await balances()).held === before.balances.held && afterInvalidation.termsHash === before.state.termsHash };
    });

    await scenario('funding fails, then a fresh intent succeeds', async () => {
      const orderId = await open('funding');
      const p = await amend(orderId, 'funding/1', 180n);
      await consent(p);
      const eligibleWithoutAllowance = await (async () => { await send(token.approve(full.target, 0n)); return (await state(orderId)).eligible; })();
      const before = { state: await state(orderId), balances: await balances() };
      const failed = await execute(p);
      const unchanged = JSON.stringify({ state: await state(orderId), balances: await balances() }) === JSON.stringify(before);
      await send(token.approve(full.target, MaxUint256));
      const retryOld = await execute(p);
      const reacceptOld = (await attempt(() => send(c.connect(provider).acceptCoordination(p.intentHash, p.acceptances[1])))).ok;
      const fresh = await amend(orderId, 'funding/1', 180n);
      const freshConsent = await consent(fresh);
      return { eligibleWithoutAllowance, failed, unchanged, retryOld, reacceptOld, sameBaseState: fresh.data.baseRevision === p.data.baseRevision && fresh.data.amendmentNonce === p.data.amendmentNonce,
        differentIntent: fresh.intentHash !== p.intentHash, freshConsent, freshExec: await execute(fresh) };
    });

    await scenario('token moves funds and then returns false', async () => {
      const orderId = await open('false-token');
      const p = await amend(orderId, 'false-token/1', 180n);
      await consent(p);
      const before = { state: await state(orderId), balances: await balances() };
      await send(token.setFailAfterTransfer(true));
      const exec = await execute(p);
      await send(token.setFailAfterTransfer(false));
      return { exec, unchanged: JSON.stringify({ state: await state(orderId), balances: await balances() }) === JSON.stringify(before) };
    });

    await scenario('nonempty execution data', async () => {
      const orderId = await open('execution-data');
      const p = await amend(orderId, 'execution-data/1', 180n);
      await consent(p);
      return { withData: await execute(p, '0x01'), thenWithout: await execute(p) };
    });

    await scenario('work submitted before execution', async () => {
      const orderId = await open('submitted');
      const p = await amend(orderId, 'submitted/1', 180n);
      await consent(p);
      const s = await c.getAmendmentState(orderId);
      await impl.submit(full, provider, orderId, s.revision, s.termsHash, id('result'));
      const view = await state(orderId);
      return { view, exec: await execute(p), invalidateAfterSubmission: (await attempt(() => send(c.invalidateAmendments(orderId)))).ok,
        unchanged: JSON.stringify(await state(orderId)) === JSON.stringify(view) };
    });

    await scenario('price decrease and deadline shortening', async () => {
      const orderId = await open('out-of-profile', 100n);
      const lower = await amend(orderId, 'out-of-profile/lower', 90n);
      const lowerConsent = await consent(lower);
      const lowerExec = lowerConsent.status === 'Ready' ? await execute(lower) : null;
      const shorter = await amend(orderId, 'out-of-profile/shorter', 120n, { terms: { deadline: DEADLINE - 1n } });
      const shorterConsent = await consent(shorter);
      const shorterExec = shorterConsent.status === 'Ready' ? await execute(shorter) : null;
      return { lowerConsent, lowerExec, shorterConsent, shorterExec, state: await state(orderId) };
    });

    await scenario('unchanged terms', async () => {
      const orderId = await open('no-change');
      const p = await prepareAmendment(c, 31337n, orderId, (t) => t, defaults);
      const consented = await consent(p);
      return { consented, exec: consented.status === 'Ready' ? await execute(p) : null, state: await state(orderId) };
    });

    await scenario('same price, new criteria', async () => {
      const orderId = await open('same-price');
      const p = await prepareAmendment(c, 31337n, orderId, (t) => ({ ...t, acceptanceHash: id('same-price/criteria-1') }), defaults);
      await consent(p);
      return { exec: await execute(p), state: await state(orderId) };
    });

    await scenario('time equals the amendment validity limit', async () => {
      const orderId = await open('valid-until');
      const p = await amend(orderId, 'valid-until/1', 180n, { validUntil: 2000050000n });
      await consent(p);
      await rpc.send('evm_setNextBlockTimestamp', [2000050000]);
      return { exec: await execute(p), state: await state(orderId) };
    });

    await scenario('time equals the order deadline', async () => {
      const orderId = await open('deadline');
      const p = await amend(orderId, 'deadline/1', 180n, { expiry: DEADLINE + 5000n, validUntil: DEADLINE + 5000n });
      await consent(p);
      await rpc.send('evm_setNextBlockTimestamp', [Number(DEADLINE)]);
      const exec = await execute(p);
      const view = await state(orderId);
      return { exec, eligibleAtDeadline: view.eligible, invalidateAtDeadline: (await attempt(() => send(c.invalidateAmendments(orderId)))).ok, readable: view.revision === '0' };
    });

    await scenario('deadline extension is used by the view and by later amendments', async () => {
      const orderId = await open('extension');
      const extended = DEADLINE + 5000n;
      const p = await amend(orderId, 'extension/1', 180n, { terms: { deadline: extended } });
      await consent(p);
      const exec = await execute(p);
      await rpc.send('evm_setNextBlockTimestamp', [Number(DEADLINE) + 10]);
      await rpc.send('evm_mine', []);
      const eligiblePastOriginalDeadline = (await state(orderId)).eligible;
      const later = await amend(orderId, 'extension/2', 220n, { expiry: extended - 10n, validUntil: extended - 10n });
      await consent(later);
      return { exec, eligiblePastOriginalDeadline, laterExec: await execute(later) };
    });

    await scenario('signature forms and submission by the other participant', async () => {
      const orderId = await open('signatures');
      const p = await amend(orderId, 'signatures/1', 180n, { signers: [{ ...B, compact: true }, P] });
      // The buyer submits both attestations: its own compact one and the provider's 65-byte one.
      const consented = await consent(p, { acceptCallers: [buyer, buyer] });
      const exec = await execute(p);
      const forged = await amend(orderId, 'signatures/2', 220n, { signers: [B, { address: provider.address, key: buyerKey }] });
      const forgedConsent = await consent(forged);
      const outsider = await amend(orderId, 'signatures/3', 220n);
      await send(c.proposeCoordination(outsider.intent, outsider.intentSignature, outsider.payload));
      const outsiderSubmits = (await attempt(() => send(c.connect(relayer).acceptCoordination(outsider.intentHash, outsider.acceptances[0])))).ok;
      return { compactBytes: (p.acceptances[0].signature.length - 2) / 2, consented: { ...consented, lastAccepted: undefined }, exec,
        forgedProviderAcceptance: forgedConsent.accepts, outsiderSubmits };
    });

    await scenario('proposal rules', async () => {
      const orderId = await open('proposal');
      const tryPropose = async (tweak) => { const p = await amend(orderId, 'proposal/x', 180n, { tweak }); return (await attempt(() => send(c.proposeCoordination(p.intent, p.intentSignature, p.payload)))).ok; };
      const out = {
        nonzeroCoordinationValue: await tryPropose({ intent: { coordinationValue: 1n } }),
        unsortedParticipants: await tryPropose({ intent: { participants: [buyer.address, provider.address].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)) } }),
        outsiderAsInitiator: await (async () => { const p = await amend(orderId, 'proposal/outsider', 180n, { initiator: { address: relayer.address, key: keys[2] } }); return (await attempt(() => send(c.proposeCoordination(p.intent, p.intentSignature, p.payload)))).ok; })(),
        nonzeroPayloadConditions: await tryPropose({ payload: { conditionsHash: id('conditions') } }),
        nonemptyMetadata: await tryPropose({ payload: { metadata: '0x01' } }),
      };
      const nonzeroAcceptance = await amend(orderId, 'proposal/acceptance', 180n);
      await send(c.proposeCoordination(nonzeroAcceptance.intent, nonzeroAcceptance.intentSignature, nonzeroAcceptance.payload));
      const a = { ...nonzeroAcceptance.acceptances[0], nonce: 1n };
      a.signature = await buyerKey.signTypedData({ name: 'ERC-8001', version: '1', chainId: 31337n, verifyingContract: c.target },
        { AcceptanceAttestation: [{ name: 'intentHash', type: 'bytes32' }, { name: 'participant', type: 'address' }, { name: 'nonce', type: 'uint64' }, { name: 'expiry', type: 'uint64' }, { name: 'conditionsHash', type: 'bytes32' }] },
        { intentHash: a.intentHash, participant: a.participant, nonce: a.nonce, expiry: a.expiry, conditionsHash: a.conditionsHash });
      out.nonzeroAcceptanceNonce = (await attempt(() => send(c.acceptCoordination(nonzeroAcceptance.intentHash, a)))).ok;
      const stale = await amend(orderId, 'proposal/nonce', 180n, { tweak: { intent: { nonce: await c.getAgentNonce(buyer.address) } } });
      out.reusedInitiatorNonce = (await attempt(() => send(c.proposeCoordination(stale.intent, stale.intentSignature, stale.payload)))).ok;
      return out;
    });

    await scenario('cancellation', async () => {
      const orderId = await open('cancel');
      const p = await amend(orderId, 'cancel/1', 180n, { expiry: 2000040000n, validUntil: 2000040000n });
      await consent(p);
      const byOther = (await attempt(() => send(c.connect(provider).cancelCoordination(p.intentHash, 'no')))).ok;
      const receipt = await send(c.cancelCoordination(p.intentHash, 'withdrawn'));
      const cancelled = eventsOf(receipt).find((e) => e.name === 'CoordinationCancelled');
      const q = await amend(orderId, 'cancel/2', 180n, { expiry: 2000040000n, validUntil: 2000040000n });
      await consent(q);
      await rpc.send('evm_setNextBlockTimestamp', [2000040000]);
      await rpc.send('evm_mine', []);
      const statusAtExpiry = await status(q.intentHash);
      const execAtExpiry = await execute(q);
      const anyone = await attempt(() => send(c.connect(relayer).cancelCoordination(q.intentHash, 'expired')));
      return { byOtherBeforeExpiry: byOther, proposerCancel: { finalStatus: STATUS[Number(cancelled.args.finalStatus)], status: await status(p.intentHash) },
        execAfterCancel: await execute(p), statusAtExpiry, execAtExpiry, anyoneAfterExpiry: anyone.ok,
        finalStatusAfterExpiry: anyone.ok ? STATUS[Number(eventsOf(anyone.receipt).find((e) => e.name === 'CoordinationCancelled').args.finalStatus)] : null,
        statusAfter: await status(q.intentHash), orderUntouched: (await state(orderId)).revision === '0' };
    });

    await scenario('payload that is not the canonical profile payload', async () => {
      const orderId = await open('malformed');
      const one = async (tweak, patch) => {
        const p = await amend(orderId, 'malformed/x', 180n, { tweak });
        if (patch) {
          // Re-sign after changing the payload bytes, so only the profile rule under test can reject it.
          patch(p);
          p.intent.payloadHash = (await import('./client.mjs')).hashPayload(p.payload);
          p.intentHash = hashIntent(p.intent);
          const domain = { name: 'ERC-8001', version: '1', chainId: 31337n, verifyingContract: c.target };
          const { INTENT_TYPES, ACCEPTANCE_TYPES } = await import('./client.mjs');
          p.intentSignature = await buyerKey.signTypedData(domain, INTENT_TYPES, p.intent);
          for (const a of p.acceptances) {
            a.intentHash = p.intentHash;
            a.signature = await (a.participant === buyer.address ? buyerKey : providerKey).signTypedData(domain, ACCEPTANCE_TYPES,
              { intentHash: a.intentHash, participant: a.participant, nonce: a.nonce, expiry: a.expiry, conditionsHash: a.conditionsHash });
          }
        }
        const consented = await consent(p);
        const exec = consented.status === 'Ready' ? await execute(p) : null;
        return { applied: exec?.success === true, rejectedAt: !consented.propose ? 'propose' : exec && exec.outer === 'mined' && !exec.success ? 'application' : exec?.outer === 'revert' ? 'execute' : 'accept' };
      };
      const out = {
        trailingBytes: await one(undefined, (p) => { p.payload.coordinationData += '00'.repeat(32); }),
        termsHashMismatch: await one({ data: { newTermsHash: id('not the terms hash') } }),
        otherOrderContract: await one({ data: { orderContract: token.target } }),
        wrongPayloadVersion: await one({ payload: { version: id('ORDER_AMENDMENT_PAYLOAD_V2') } }),
        zeroScopeHash: await one(undefined, undefined).then(async () => {
          const p = await prepareAmendment(c, 31337n, orderId, (t) => ({ ...t, scopeHash: '0x' + '00'.repeat(32), totalPrice: 180n }), defaults);
          const consented = await consent(p);
          const exec = consented.status === 'Ready' ? await execute(p) : null;
          return { applied: exec?.success === true, rejectedAt: !consented.propose ? 'propose' : 'application' };
        }),
      };
      out.orderUntouched = (await state(orderId)).revision === '1' ? 'one valid control amendment applied' : (await state(orderId)).revision;
      return out;
    });

    await scenario('an acceptance expires before the intent', async () => {
      const orderId = await open('acceptance-expiry');
      const p = await amend(orderId, 'acceptance-expiry/1', 180n, { signers: [B, { ...P, expiry: 2000030000n }] });
      const consented = await consent(p);
      await rpc.send('evm_setNextBlockTimestamp', [2000030000]);
      await rpc.send('evm_mine', []);
      const statusAtAcceptanceExpiry = await status(p.intentHash);
      const exec = await execute(p);
      return { consented: consented.status, statusAtAcceptanceExpiry, exec, orderUntouched: (await state(orderId)).revision === '0' };
    });

    await scenario('contract buyer signs through ERC-1271', async () => {
      const walletArtifact = reference('Test1271Wallet');
      const wallet = await (await new ContractFactory(walletArtifact.abi, walletArtifact.bytecode, buyer).deploy(buyer.address)).waitForDeployment();
      await send(token.mint(wallet.target, 1000n));
      await send(wallet.execute(token.target, token.interface.encodeFunctionData('approve', [full.target, MaxUint256])));
      const orderId = id('interop/erc1271');
      const initial = terms('erc1271/0', 100n);
      await send(wallet.execute(full.target, impl.offerData(full, orderId, provider.address, token.target, initial)));
      await send(provider.sendTransaction({ to: full.target, data: impl.agreeData(full, orderId, initial) }));
      const W = { address: wallet.target, key: buyerKey };
      // The provider initiates and submits both attestations; the wallet's owner key signs for the wallet.
      const make = (tag, price) => prepareAmendment(c, 31337n, orderId, (t) => ({ ...t, scopeHash: id(`${tag}/scope`), totalPrice: price }), { ...defaults, initiator: P, signers: [W, P] });
      const p = await make('erc1271/1', 180n);
      const consented = await consent(p, { acceptCallers: [provider, provider] });
      // The wallet changes its signing policy after accepting. Execution must not revalidate it.
      await send(wallet.setReject(true));
      const exec = await execute(p);
      const q = await make('erc1271/2', 220n);
      const whileRejecting = await consent(q, { acceptCallers: [provider, provider] });
      return { buyerIsContract: (await state(orderId)).buyer === wallet.target, consented: { ...consented, lastAccepted: undefined }, exec,
        acceptsWhileWalletRejects: whileRejecting.accepts, walletBalance: (await token.balanceOf(wallet.target)).toString() };
    });

    return { implementation: impl.label, scenarios };
  } finally {
    await chain.close();
  }
}

/**
 * Replays the published ERC-8448 vector against one implementation on a live local chain: the contract's code is
 * placed at the vector's verifying contract address and the published signatures go through the real entry points.
 */
export async function replayVector(name) {
  const impl = IMPLEMENTATIONS[name];
  const vector = JSON.parse(readFileSync(here('../spec/order-amendment-v1.json'), 'utf8'));
  const chain = await startChain();
  try {
    const { rpc, signers } = chain;
    const [deployer, , relayer] = signers;
    const tokenArtifact = reference('TestToken');
    const token = await (await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, deployer).deploy()).waitForDeployment();
    const built = impl.artifact();
    const deployed = await (await new ContractFactory(built.abi, built.bytecode, deployer).deploy(...impl.constructorArgs(token.target))).waitForDeployment();
    const at = vector.domain.verifyingContract;
    await rpc.send('anvil_setCode', [at, await rpc.getCode(deployed.target)]);
    const full = new Contract(at, built.abi, deployer);
    const buyer = new Wallet('0x' + '1'.padStart(64, '0'), rpc);
    const provider = new Wallet('0x' + '2'.padStart(64, '0'), rpc);
    for (const w of [buyer, provider]) await rpc.send('anvil_setBalance', [w.address, '0x56BC75E2D63100000']);
    const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v]));
    const original = big(vector.originalTerms);
    await send(token.mint(buyer.address, 1000n));
    await send(token.connect(buyer).approve(at, MaxUint256));
    await send(buyer.sendTransaction({ to: at, data: impl.offerData(full, vector.data.orderId, provider.address, token.target, original) }));
    await send(provider.sendTransaction({ to: at, data: impl.agreeData(full, vector.data.orderId, original) }));
    const c = new Contract(at, COMMON_ABI, buyer);
    const before = viewOf(await c.getAmendmentState(vector.data.orderId));
    const payload = big(vector.payload);
    const intent = big(vector.intent);
    await send(c.proposeCoordination(intent, vector.intentSignature, payload));
    for (const a of vector.acceptances) {
      const signer = a.message.participant === buyer.address ? buyer : provider;
      await send(c.connect(signer).acceptCoordination(vector.expected.intentStructHash, { ...big(a.message), signature: a.signature }));
    }
    const ready = STATUS[Number((await c.getCoordinationStatus(vector.expected.intentStructHash)).status)];
    const receipt = await send(c.connect(relayer).executeCoordination(vector.expected.intentStructHash, payload, '0x', { gasLimit: 2000000 }));
    const events = receipt.logs.filter((l) => l.address === at).map((l) => { try { return common.parseLog(l); } catch { return null; } }).filter(Boolean);
    const applied = events.find((e) => e.name === 'OrderAmendmentApplied');
    return { baseMatchesVector: before.termsHash === vector.data.baseTermsHash && before.revision === vector.data.baseRevision && before.amendmentNonce === vector.data.amendmentNonce,
      buyer: before.buyer === vector.buyer, provider: before.provider === vector.provider, ready,
      success: events.find((e) => e.name === 'CoordinationExecuted').args.success,
      applied: { intentHash: applied.args.intentHash === vector.expected.intentStructHash, revision: applied.args.revision.toString(),
        previousTermsHash: applied.args.previousTermsHash === vector.data.baseTermsHash, newTermsHash: applied.args.newTermsHash === vector.expected.termsHash, supplement: applied.args.supplement.toString() },
      after: viewOf(await c.getAmendmentState(vector.data.orderId)) };
  } finally {
    await chain.close();
  }
}

export { Wallet };
