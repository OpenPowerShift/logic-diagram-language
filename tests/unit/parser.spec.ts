import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/index.js';

describe('LDL Parser', () => {
  describe('simple expressions', () => {
    it('parses a simple AND expression', () => {
      const result = parse('OUT = A AND B');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(1);
      expect(result.diagram.outputs[0].name).toBe('OUT');
    });

    it('parses a simple OR expression', () => {
      const result = parse('OUT = A OR B');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(1);
    });

    it('parses a NOT expression', () => {
      const result = parse('OUT = NOT A');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(1);
    });

    it('parses a combined expression with precedence', () => {
      const result = parse('CBFPS = AB AND DC OR (NOT DC AND GF)');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(1);
      expect(result.diagram.outputs[0].name).toBe('CBFPS');
    });

    it('parses multiple outputs', () => {
      const result = parse('X = A AND B\nY = C OR D');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(2);
    });

    it('parses nested NOT', () => {
      const result = parse('OUT = NOT NOT A');
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('port metadata', () => {
    it('parses .Name attributes', () => {
      const result = parse('I1.Name = "CBQ 00 Open"');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.portMeta).toHaveLength(1);
      expect(result.diagram.portMeta[0].identifier).toBe('I1');
      expect(result.diagram.portMeta[0].property).toBe('Name');
      expect(result.diagram.portMeta[0].value).toBe('CBQ 00 Open');
    });

    it('parses .Description attributes', () => {
      const result = parse('I1.Description = "(BI 3.1)"');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.portMeta).toHaveLength(1);
      expect(result.diagram.portMeta[0].identifier).toBe('I1');
      expect(result.diagram.portMeta[0].property).toBe('Description');
    });

    it('parses both Name and Description for same port', () => {
      const source = `I1.Name = "Test"
I1.Description = "(ref)"`;
      const result = parse(source);
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.portMeta).toHaveLength(2);
    });

    it('parses interlocking example with metadata', () => {
      const source = `I1.Name = "CBQ 00 Open"
I1.Description = "(BI 3.1)"

O1 = I1 AND I2

O1.Name = "Output"
O1.Description = "(BO 3.2)"`;
      const result = parse(source);
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.portMeta).toHaveLength(4);
      expect(result.diagram.outputs).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('reports errors for invalid syntax', () => {
      const result = parse('=== invalid');
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('handles empty input gracefully', () => {
      const result = parse('');
      expect(result.diagram.outputs).toHaveLength(0);
    });
  });

  describe('named gates (AND#ID / OR#ID / NOT#ID)', () => {
    it('parses AND#ID(A, B) as a gate with id', () => {
      const result = parse('OUT = AND#MYID(A, B)');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(1);
      const expr = result.diagram.outputs[0].expression;
      expect(expr.kind).toBe('gate');
      if (expr.kind === 'gate') {
        expect(expr.gateType).toBe('AND');
        expect(expr.id).toBe('MYID');
        expect(expr.inputs).toHaveLength(2);
      }
    });

    it('parses OR#ID(A, B, C) as a gate with id', () => {
      const result = parse('OUT = OR#G1(A, B, C)');
      expect(result.errors).toHaveLength(0);
      const expr = result.diagram.outputs[0].expression;
      expect(expr.kind).toBe('gate');
      if (expr.kind === 'gate') {
        expect(expr.gateType).toBe('OR');
        expect(expr.id).toBe('G1');
        expect(expr.inputs).toHaveLength(3);
      }
    });

    it('parses NOT#ID(A) as a gate with id', () => {
      const result = parse('OUT = NOT#INV(A)');
      expect(result.errors).toHaveLength(0);
      const expr = result.diagram.outputs[0].expression;
      expect(expr.kind).toBe('gate');
      if (expr.kind === 'gate') {
        expect(expr.gateType).toBe('NOT');
        expect(expr.id).toBe('INV');
        expect(expr.inputs).toHaveLength(1);
      }
    });

    it('composes with infix operators', () => {
      const result = parse('OUT = AND#G1(A, B) OR C');
      expect(result.errors).toHaveLength(0);
      const expr = result.diagram.outputs[0].expression;
      expect(expr.kind).toBe('gate');
      if (expr.kind === 'gate' && expr.gateType === 'OR') {
        expect(expr.inputs[0].kind).toBe('gate');
        if (expr.inputs[0].kind === 'gate') expect(expr.inputs[0].id).toBe('G1');
      }
    });
  });

  describe('bare port assignment (A = FB#ID.PORT)', () => {
    it('parses A = FB#PROT.ALARM as a symbolRef with port selector', () => {
      const result = parse('A = FB#PROT.ALARM');
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(1);
      expect(result.diagram.outputs[0].name).toBe('A');
      const expr = result.diagram.outputs[0].expression;
      expect(expr.kind).toBe('symbolRef');
      if (expr.kind === 'symbolRef') {
        expect(expr.symbolName).toBe('FB');
        expect(expr.id).toBe('PROT');
        expect(expr.portName).toBe('ALARM');
      }
    });

    it('parses multiple bare port assignments from the same block', () => {
      const src = `TRIP = FB#PROT(A, B).TRIP
ALARM = FB#PROT.ALARM
CLOSE = FB#PROT.CLOSE`;
      const result = parse(src);
      expect(result.errors).toHaveLength(0);
      expect(result.diagram.outputs).toHaveLength(3);
      expect(result.diagram.outputs[1].name).toBe('ALARM');
      expect(result.diagram.outputs[2].name).toBe('CLOSE');
    });
  });
});