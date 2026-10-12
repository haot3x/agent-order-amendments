import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { JsonRpcProvider, ContractFactory, HDNodeWallet } from 'ethers';
import { compile, root } from '../../scripts/compile.mjs';

export async function localEvm() {
  const artifacts=compile();
  const proc=spawn(process.execPath,[resolve(root,'node_modules/@foundry-rs/anvil/bin.mjs'),
    '--host','127.0.0.1','--port','0','--chain-id','31337','--hardfork','cancun','--timestamp','2000000000'],{stdio:['ignore','pipe','pipe']});
  let output='';
  const url=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{proc.kill();reject(new Error('Local Anvil startup timeout'));},15000);
    proc.once('error',e=>{clearTimeout(timeout);reject(e)});
    proc.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Local Anvil exited (${code})`))});
    const read=chunk=>{output+=chunk.toString();const match=output.match(/Listening on (127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(`http://${match[1]}`)}};
    proc.stdout.on('data',read);proc.stderr.on('data',read);
  });
  const rpc=new JsonRpcProvider(url,31337,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20});
  const wallets=[0,1,2].map(i=>HDNodeWallet.fromPhrase('test test test test test test test test test test test junk',undefined,`m/44'/60'/0'/0/${i}`));
  const signers=await Promise.all(wallets.map(w=>rpc.getSigner(w.address)));
  const deploy=async(name,args=[],signer=signers[0])=>{
    const a=artifacts[name];const c=await new ContractFactory(a.abi,a.bytecode,signer).deploy(...args);
    await c.waitForDeployment();return c;
  };
  return {rpc,wallets,signers,deploy,close:async()=>{
    rpc.destroy();if(proc.exitCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done;}
  }};
}
