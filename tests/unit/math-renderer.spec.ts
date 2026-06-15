import { describe, it, expect } from 'vitest';
import { splitIntoSegments, hasMathContent } from '../../src/renderer/math-renderer.js';

describe('splitIntoSegments', () => {
  it('returns plain text segment for string without math', () => {
    const segments = splitIntoSegments('Hello World');
    expect(segments).toEqual([{ type: 'plain', text: 'Hello World' }]);
  });

  it('returns math segment for $...$ content', () => {
    const segments = splitIntoSegments('$I_a$');
    expect(segments).toEqual([{ type: 'math', text: 'I_a' }]);
  });

  it('handles mixed plain and math content', () => {
    const segments = splitIntoSegments('Phase $I_a$ current');
    expect(segments).toEqual([
      { type: 'plain', text: 'Phase ' },
      { type: 'math', text: 'I_a' },
      { type: 'plain', text: ' current' },
    ]);
  });

  it('handles escaped dollar sign', () => {
    const segments = splitIntoSegments('Cost \\\$5.00');
    expect(segments).toEqual([{ type: 'plain', text: 'Cost $5.00' }]);
  });

  it('handles multiple math segments', () => {
    const segments = splitIntoSegments('$I_a$ + $I_b$');
    expect(segments).toEqual([
      { type: 'math', text: 'I_a' },
      { type: 'plain', text: ' + ' },
      { type: 'math', text: 'I_b' },
    ]);
  });

  it('handles unclosed dollar sign as plain text', () => {
    const segments = splitIntoSegments('price $5');
    expect(segments).toEqual([{ type: 'plain', text: 'price $5' }]);
  });

  it('handles empty math segment', () => {
    const segments = splitIntoSegments('$$');
    expect(segments).toEqual([{ type: 'math', text: '' }]);
  });
});

describe('hasMathContent', () => {
  it('returns true when text contains math delimiters', () => {
    expect(hasMathContent('$I_a$')).toBe(true);
    expect(hasMathContent('Phase $I_{set}$ current')).toBe(true);
  });

  it('returns false when text has no math delimiters', () => {
    expect(hasMathContent('Hello World')).toBe(false);
    expect(hasMathContent('Price: 5 dollars')).toBe(false);
  });

  it('returns false for escaped dollar signs', () => {
    expect(hasMathContent('Cost \\$5.00')).toBe(false);
  });
});

