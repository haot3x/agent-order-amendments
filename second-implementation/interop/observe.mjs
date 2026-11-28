import { writeFileSync } from 'node:fs';
import { observe, replayVector } from './scenarios.mjs';
const out = {};
for (const name of ['reference', 'second']) { out[name] = await observe(name); out[name].scenarios['published vector on a live chain'] = await replayVector(name); }
writeFileSync(new URL('./observations.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
const a = out.reference.scenarios, b = out.second.scenarios;
for (const k of Object.keys(a)) console.log(JSON.stringify(a[k]) === JSON.stringify(b[k]) ? 'SAME   ' : 'DIFFERS', k);
