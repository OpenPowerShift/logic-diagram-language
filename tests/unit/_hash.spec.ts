import { it } from 'vitest';
import { createHash } from 'crypto';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import type { LayoutResult } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';
import { EXAMPLES } from '../../src/examples.js';
const r2 = (v:number)=>Math.round(v*100)/100;
const cmp=(a:unknown,b:unknown)=>{const sa=JSON.stringify(a),sb=JSON.stringify(b);return sa<sb?-1:sa>sb?1:0;};
function digest(l: LayoutResult){
  const nodes=l.nodes.map(n=>({type:n.gateType,block:n.blockType??null,box:[r2(n.absX),r2(n.absY),r2(n.width),r2(n.height)],label:n.label??null,name:n.name??null,desc:n.description??null,inputs:n.inputs.map(p=>[r2(p.absX),r2(p.absY),p.name,p.label??null,p.bubbled?1:0]).sort(cmp),outputs:n.outputs.map(p=>[r2(p.absX),r2(p.absY),p.name,p.bubbledOutput?1:0]).sort(cmp)})).sort(cmp);
  const wires=l.wires.map(w=>({feedback:w.feedback?1:0,points:w.points.map(p=>[r2(p.x),r2(p.y)])})).sort(cmp);
  const junctions=l.junctions.map(j=>[r2(j.x),r2(j.y)]).sort(cmp);
  const labels=l.labels.map(x=>[r2(x.x),r2(x.y),r2(x.width),r2(x.height),x.name??null,x.description??null]).sort(cmp);
  return {canvas:[r2(l.width),r2(l.height)],nodes,wires,junctions,labels};
}
it('hash', () => {
  const hashes:Record<string,string>={};
  for (const [name,src] of Object.entries(EXAMPLES)){
    const r=parse(src);
    const l=layoutDiagram(r.diagram,resolveOptions(r.diagram.options));
    hashes[name]=createHash('sha256').update(JSON.stringify(digest(l))).digest('hex');
  }
  console.log('SI_HASH ' + hashes['Shared Intermediates']);
  const corpus=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  console.log('CORPUS_HASH ' + corpus);
  for (const [k,v] of Object.entries(hashes)) console.log('  '+v.slice(0,16)+'  '+k);
});
