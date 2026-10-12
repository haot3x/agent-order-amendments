import solc from 'solc';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function compile() {
  const files = ['contracts/ExperimentalOrderAmendments.sol','contracts/test/Fixtures.sol'];
  const input = {language:'Solidity',sources:Object.fromEntries(files.map(f=>[f,{content:readFileSync(resolve(root,f),'utf8')}])),
    settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const output = JSON.parse(solc.compile(JSON.stringify(input), {import: (path) => {
    try {return {contents:readFileSync(resolve(root,'node_modules',path),'utf8')}}
    catch {return {error:`Unresolved import: ${path}`}}
  }}));
  for (const e of output.errors ?? []) {
    if (e.severity === 'error') throw new Error(e.formattedMessage);
    process.stderr.write(e.formattedMessage);
  }
  return Object.fromEntries(files.flatMap(f=>Object.entries(output.contracts[f]).map(([name,c])=>[name,{abi:c.abi,bytecode:`0x${c.evm.bytecode.object}`}])));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifacts = compile();
  mkdirSync(resolve(root,'artifacts'),{recursive:true});
  for (const [name,artifact] of Object.entries(artifacts)) writeFileSync(resolve(root,'artifacts',`${name}.json`),JSON.stringify(artifact,null,2)+'\n');
  console.log(`Compiled ${Object.keys(artifacts).length} local-test contracts with solc ${solc.version()}`);
}
