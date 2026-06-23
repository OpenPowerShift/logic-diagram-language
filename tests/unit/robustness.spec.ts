import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';
import { layoutDiagram } from '../../src/renderer/layout.js';
import { resolveOptions } from '../../src/parser/ast.js';

// Robustness corpus: a broad range of made-up diagrams (simple gates, deep/wide trees, fan-out
// DAGs, feedback, every block type, generic FB, labels, all options, and a few pathological
// cases). Each is asserted against the CORRECTNESS invariants that must hold for any input —
// orthogonality, no wire through a gate body, connectivity, and no overlapping gate bodies.
// (Soft quality — sub-MIN_DOGLEG jogs and crossing counts on extreme fan-in — is tracked in
// IMPLEMENTATION.md "Current Issues", not asserted here.)
const chain = (op: string, n: number) => Array.from({ length: n }, (_, i) => `I${i}`).join(` ${op} `);

const CORPUS: Record<string, string> = {
  and2: `O = A AND B`,
  or3: `O = A OR B OR C`,
  not: `O = NOT A`,
  mix: `O = (A AND B) OR (C AND NOT D)`,
  nestdeep: `O = A AND (B OR (C AND (D OR (E AND F))))`,
  notchain: `O = NOT NOT NOT NOT A`,
  andchain: `O = ${chain('AND', 8)}`,
  orchain: `O = ${chain('OR', 10)}`,
  and12: `O = ${chain('AND', 12)}`,
  or20: `O = ${chain('OR', 20)}`,
  or30: `O = ${chain('OR', 30)}`,
  bars: `OPTION GATE_INPUT_STYLE = BARS\nO = ${chain('AND', 9)}`,
  fanout: `S = A AND B\nO1 = S OR C\nO2 = S OR D\nO3 = S OR E\nO4 = S AND F`,
  dag: `X = A AND B\nY = B AND C\nZ = X OR Y\nO = Z AND (X OR Y)`,
  diamond: `L = A OR B\nR = A AND B\nO = L AND R`,
  eightOut: `OPTION OUTPUT_ORDER = AUTO\n${Array.from({ length: 8 }, (_, i) => `O${i} = A${i} AND B${i}`).join('\n')}`,
  sharedouts: `OPTION OUTPUT_ORDER = AUTO\nM = A OR B OR C\nO1 = M AND D\nO2 = M AND E\nO3 = NOT M\nO4 = M OR F`,
  sealin: `Q = SET OR (Q AND NOT RESET)`,
  sealin2: `BFT = BFI OR BFT AND (CB AND I2T)`,
  twolatch: `OPTION OUTPUT_ORDER = AUTO\nQ1 = S1 OR (Q1 AND NOT R1)\nQ2 = S2 OR (Q2 AND NOT R2)`,
  bubbles: `OPTION INVERSION = BUBBLES\nO = A AND NOT B AND C AND NOT D`,
  bubbleout: `OPTION INVERSION = BUBBLES\nO1 = NOT (A AND B)\nO2 = NOT (C OR D)\nO3 = NOT E`,
  bubbleord: `OPTION INVERSION = BUBBLES\nOPTION INPUT_ORDER = AUTO\nO = (P OR Q OR R) AND NOT BLK OR (X OR Y)`,
  timer: `O = TIMER(START, 2cyc, 5cyc)`,
  sr: `O = SR(SET, RESET)\nN = SR#L(GO, STOP).NQ`,
  compare: `O = COMPARE(IA, IPK)`,
  edges: `O1 = RISING(A)\nO2 = FALLING(B)`,
  blocknest: `TRIP = TIMER(SR(COMPARE(IA, IPK), RST), 0, 30cyc)`,
  blockmix: `OPTION OUTPUT_ORDER = AUTO\nTRIP = SR(COMPARE(IA,IPK) AND EN, RST)\nALARM = RISING(COMPARE(IA,IPK))\nDROP = FALLING(CB)`,
  fb: `O = FB#P(A, B, C).OUT\nP.Name="Func"`,
  fbmulti: `OPTION OUTPUT_ORDER = AUTO\nT = FB#R(PH=IA, EF=IN).TRIP\nA = FB#R(PH=IA, EF=IN).ALARM\nR.Name="Relay"`,
  label: `G = A OR B OR C\nO = G AND D\nG.Name="OC"\nG.Description="51"`,
  multilabel: `OPTION OUTPUT_ORDER = AUTO\nPH=O51 OR O50\nEF=E51 OR E50\nHS=O502 OR E502\nT=PH OR EF OR HS\nPH.Name="Phase"\nEF.Name="Earth"\nHS.Name="HiSet"`,
  compact: `OPTION COMPACTNESS = COMPACT\nO = (A AND B AND C) OR (D AND E AND F)`,
  compactv: `OPTION COMPACTNESS = COMPACT_V\nO = ${chain('OR', 12)}`,
  spacious: `OPTION COMPACTNESS = SPACIOUS\nO = A AND B AND C`,
  factors: `OPTION COMPACTNESS = 130,80\nO = (A OR B) AND (C OR D) AND (E OR F)`,
  square: `OPTION PORT_STYLE = SQUARE\nO = A AND B`,
  decl: `OPTION OUTPUT_ORDER = DECLARATION\nO1 = A AND B\nO2 = C OR D\nO3 = NOT E`,
  wide: `OPTION OUTPUT_ORDER = AUTO\n${Array.from({ length: 6 }, (_, i) => `O${i} = ${chain('AND', 4)} OR Z${i}`).join('\n')}`,
  balanced: `O = ((A AND B) OR (C AND D)) AND ((E AND F) OR (G AND H))`,
  bigmix: `OPTION OUTPUT_ORDER = AUTO\nM1 = A AND B\nM2 = C OR D\nM3 = M1 AND M2\nM4 = NOT M3\nTRIP = M3 OR M4 OR E\nALARM = M1 OR M2`,
  protscheme: `OPTION OUTPUT_ORDER = AUTO\nOC = COMPARE(IA, IPK)\nLATCH = SR(OC AND EN, RST)\nTRIP = TIMER(LATCH, 0, 12cyc)\nALARM = RISING(OC)\nBF = LATCH AND CB52A`,
  everything: `OPTION OUTPUT_ORDER = AUTO\nOPTION INVERSION = BUBBLES\nP = COMPARE(IA, IPK)\nQ = SR(P, RST)\nT = TIMER(Q AND NOT BLK, 1cyc, 0)\nTRIP = T OR FALLING(CB)\nALARM = RISING(P) OR EXT\nP.Name="50P"\nQ.Name="Latch"`,
};

describe('Robustness corpus (correctness invariants)', () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    it(name, () => {
      const r = parse(src);
      expect(r.errors, 'parse errors').toEqual([]);
      const l = layoutDiagram(r.diagram, r.diagram.portMeta, resolveOptions(r.diagram.options));
      const byId = new Map(l.nodes.map(n => [n.id, n]));

      for (const w of l.wires) {
        const p = w.points;
        for (let i = 0; i < p.length - 1; i++) {
          const a = p[i], b = p[i + 1];
          // orthogonal
          expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${name}: diagonal segment`).toBe(true);
          // no wire through a non-endpoint gate body
          for (const n of l.nodes) {
            if (n.id === w.fromId || n.id === w.toId) continue;
            const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
            expect(x1 > n.absX + 1 && x0 < n.absX + n.width - 1 && y1 > n.absY + 1 && y0 < n.absY + n.height - 1,
              `${name}: wire ${w.fromId}->${w.toId} crosses ${n.id}`).toBe(false);
          }
        }
        // connectivity (skip feedback loop-backs which tap the signal line)
        if (!w.feedback) {
          const from = byId.get(w.fromId), to = byId.get(w.toId), p0 = p[0], pN = p[p.length - 1];
          expect(!!from && from.outputs.some(s => Math.abs(p0.x - s.absX) < 1 && Math.abs(p0.y - s.absY) < 1), `${name}: ${w.fromId}->${w.toId} start off-port`).toBe(true);
          expect(!!to && to.inputs.some(s => Math.abs(pN.x - s.absX) < 1 && Math.abs(pN.y - s.absY) < 1), `${name}: ${w.fromId}->${w.toId} end off-port`).toBe(true);
        }
      }

      // no overlapping gate bodies
      for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
        const a = l.nodes[i], b = l.nodes[j];
        expect(a.absX + a.width > b.absX + 1 && b.absX + b.width > a.absX + 1 && a.absY + a.height > b.absY + 1 && b.absY + b.height > a.absY + 1,
          `${name}: ${a.id} overlaps ${b.id}`).toBe(false);
      }
    });
  }
});
