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
});