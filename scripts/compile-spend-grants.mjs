import solc from 'solc-8427';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './compile.mjs';

export function compileSpendGrants() {
  const folder = 'contracts/vendor/erc8427';
  const manifest = JSON.parse(readFileSync(resolve(root, folder, 'manifest.json'), 'utf8'));
  const sources = {};
  for (const [name, record] of Object.entries(manifest.files)) {
    const content = readFileSync(resolve(root, folder, name), 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== record.sha256) {
      throw new Error(`Vendored ERC-8427 source changed: ${name}`);
    }
    sources[`${folder}/${name}`] = {content};
  }
  const input = {language: 'Solidity', sources, settings: {
    optimizer: {enabled: true, runs: 200}, viaIR: true, evmVersion: 'cancun',
    outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object']}},
  }};
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const error of output.errors ?? []) {
    if (error.severity === 'error') throw new Error(error.formattedMessage);
    process.stderr.write(error.formattedMessage);
  }
  return Object.fromEntries(Object.values(output.contracts).flatMap(contracts =>
    Object.entries(contracts).map(([name, contract]) => [name, {
      abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
    }])));
}
