import type {
  GateType, LogicNode, PortNode, GateNode, SymbolRefNode, BlockNode, BlockType,
  Diagram, DiagramOutput, ObjectDecl, AttributeDecl, ConnectDecl,
  StyleDecl, ParseError, ParseResult, PortMeta, OptionDecl,
} from './ast.js';

const BLOCK_TYPES = new Set<BlockType>(['TIMER', 'SR', 'RISING', 'FALLING', 'COMPARE', 'FB']);

const KEYWORDS = new Set([
  'and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor',
  'symbol', 'end', 'port', 'input', 'output', 'bidi',
  'attribute', 'import', 'template', 'connect',
  'style', 'stylesheet', 'link', 'as', 'true', 'false',
  'option',
]);

interface Token {
  type: 'KEYWORD' | 'IDENT' | 'SYMBOL_NAME' | 'NUMBER' | 'STRING' | 'DURATION' | 'OP' | 'EOF';
  value: string;
  line: number;
  column: number;
  offset: number;
}

function tokenize(source: string): { tokens: Token[]; errors: ParseError[] } {
  const tokens: Token[] = [];
  const errors: ParseError[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  // Detect STYLE blocks at line start and skip the raw CSS (which contains characters the
  // tokenizer can't handle: #, {, }, :, ;, .). A STYLE block starts with `STYLE` on its own
  // line and ends with `END` on its own line. We emit a single STYLE token, then a raw CSS
  // STRING token containing the CSS body, then skip to END and emit END.
  const checkStyleBlock = (): boolean => {
    // Must be at the start of a line (col === 1 or only whitespace before pos on this line).
    let p = pos;
    while (p > 0 && source[p - 1] === ' ') p--;
    if (p > 0 && source[p - 1] !== '\n') return false;
    // Check if the line starts with STYLE (case-insensitive) followed by whitespace/newline.
    const rest = source.slice(pos);
    const m = rest.match(/^STYLE\s*[\n\r]/i);
    if (!m) return false;
    // Emit STYLE token.
    tokens.push({ type: 'KEYWORD', value: 'STYLE', line, column: col, offset: pos });
    const styleEnd = pos + m[0].length;
    // Advance past STYLE + newline.
    pos = styleEnd;
    line++;
    col = 1;
    // Find the next standalone END or END STYLE (on its own line).
    const endMatch = source.slice(pos).match(/\n\s*END(\s+STYLE)?\s*(\n|$)/i);
    let cssEnd: number;
    if (endMatch) {
      cssEnd = pos + endMatch.index!;
    } else {
      cssEnd = source.length;
    }
    // Emit a STRING token containing the raw CSS.
    const cssText = source.slice(pos, cssEnd).trim();
    if (cssText) {
      tokens.push({ type: 'STRING', value: cssText, line, column: 1, offset: pos });
    }
    // Advance to END.
    if (endMatch) {
      const endStart = pos + endMatch.index! + 1; // skip the \n before END
      // Count newlines in the CSS text for line tracking.
      const cssRaw = source.slice(pos, endStart);
      const newlines = (cssRaw.match(/\n/g) || []).length;
      line += newlines;
      pos = endStart;
      col = 1;
      // Skip whitespace before END.
      while (pos < source.length && source[pos] === ' ') { pos++; col++; }
      // Emit END token.
      tokens.push({ type: 'KEYWORD', value: 'END', line, column: col, offset: pos });
      pos += 3;
      col += 3;
      // If END is followed by STYLE (i.e. "END STYLE"), skip past STYLE too so the parser
      // doesn't see a second STYLE keyword and parse an empty style block.
      const rest2 = source.slice(pos);
      const styleAfter = rest2.match(/^\s+STYLE\b/i);
      if (styleAfter) {
        pos += styleAfter[0].length;
        col += styleAfter[0].length;
      }
    } else {
      pos = source.length;
    }
    return true;
  };

  while (pos < source.length) {
    const ch = source[pos];

    // Check for STYLE block before any other tokenization (CSS content has invalid chars).
    if (checkStyleBlock()) continue;

    if (ch === '\n') {
      line++;
      col = 1;
      pos++;
      continue;
    }

    if (ch === '\r') {
      pos++;
      if (source[pos] === '\n') pos++;
      line++;
      col = 1;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      pos++;
      col++;
      continue;
    }

    if (source.slice(pos, pos + 2) === '//') {
      const end = source.indexOf('\n', pos);
      pos = end === -1 ? source.length : end;
      col = 1;
      continue;
    }

    if (source.slice(pos, pos + 2) === '/*') {
      const end = source.indexOf('*/', pos + 2);
      if (end === -1) {
        errors.push({ message: 'Unterminated block comment', line, column: col, offset: pos });
        pos = source.length;
      } else {
        const comment = source.slice(pos, end + 2);
        const newlines = (comment.match(/\n/g) || []).length;
        line += newlines;
        pos = end + 2;
        col = 1;
      }
      continue;
    }

    if (ch === '"') {
      const start = pos;
      const startLine = line;
      const startCol = col;
      pos++;
      let value = '';
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\' && pos + 1 < source.length && source[pos + 1] === '"') {
          value += '"';
          pos += 2;
        } else {
          value += source[pos];
          pos += 1;
        }
        col++;
      }
      if (pos >= source.length) {
        errors.push({ message: 'Unterminated string', line: startLine, column: startCol, offset: start });
      } else {
        pos++;
        col++;
      }
      tokens.push({ type: 'STRING', value, line: startLine, column: startCol, offset: start });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = pos;
      const startLine = line;
      const startCol = col;
      let num = '';
      while (pos < source.length && /[0-9]/.test(source[pos])) {
        num += source[pos];
        pos++;
        col++;
      }
      if (pos < source.length && source[pos] === '.') {
        num += '.';
        pos++;
        col++;
        while (pos < source.length && /[0-9]/.test(source[pos])) {
          num += source[pos];
          pos++;
          col++;
        }
      }

      const rest = source.slice(pos);
      const durationMatch = rest.match(/^(ms|cycles|cycle|cyc|s(?![a-zA-Z])|m(?![a-zA-Z]))/);
      if (durationMatch) {
        pos += durationMatch[0].length;
        col += durationMatch[0].length;
        tokens.push({ type: 'DURATION', value: num + durationMatch[0], line: startLine, column: startCol, offset: start });
      } else {
        tokens.push({ type: 'NUMBER', value: num, line: startLine, column: startCol, offset: start });
      }
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos;
      const startLine = line;
      const startCol = col;
      let ident = '';
      while (pos < source.length && /[a-zA-Z0-9_]/.test(source[pos])) {
        ident += source[pos];
        pos++;
        col++;
      }
      const lower = ident.toLowerCase();
      if (KEYWORDS.has(lower)) {
        if (lower === 'true' || lower === 'false') {
          tokens.push({ type: 'KEYWORD', value: ident.toLowerCase(), line: startLine, column: startCol, offset: start });
        } else {
          tokens.push({ type: 'KEYWORD', value: ident.toUpperCase(), line: startLine, column: startCol, offset: start });
        }
      } else if (/^[A-Z]/.test(ident) && /^[A-Z0-9_]+$/.test(ident)) {
        tokens.push({ type: 'SYMBOL_NAME', value: ident, line: startLine, column: startCol, offset: start });
      } else {
        tokens.push({ type: 'IDENT', value: ident, line: startLine, column: startCol, offset: start });
      }
      continue;
    }

    if ('=.()#{},[]'.includes(ch)) {
      tokens.push({ type: 'OP', value: ch, line, column: col, offset: pos });
      pos++;
      col++;
      continue;
    }

    errors.push({ message: `Unexpected character: '${ch}'`, line, column: col, offset: pos });
    pos++;
    col++;
  }

  tokens.push({ type: 'EOF', value: '', line, column: col, offset: pos });
  return { tokens, errors };
}

class Parser {
  private tokens: Token[];
  private pos: number;
  public errors: ParseError[];
  private source: string;

  constructor(tokens: Token[], errors: ParseError[], source: string) {
    this.tokens = tokens;
    this.pos = 0;
    this.errors = [...errors];
    this.source = source;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private expect(type: string, value?: string): Token | null {
    const token = this.peek();
    if (value !== undefined) {
      if (token.type === type && (token.value === value || token.value.toUpperCase() === value.toUpperCase())) {
        return this.advance();
      }
    } else {
      if (token.type === type) {
        return this.advance();
      }
    }
    this.errors.push({
      message: `Expected ${value ?? type} but got '${token.value}' (${token.type})`,
      line: token.line,
      column: token.column,
      offset: token.offset,
    });
    return null;
  }

  private match(type: string, value?: string): Token | null {
    const token = this.peek();
    if (value !== undefined) {
      if (token.type === type && (token.value === value || token.value.toUpperCase() === value.toUpperCase())) {
        return this.advance();
      }
    } else {
      if (token.type === type) {
        return this.advance();
      }
    }
    return null;
  }

  private isKeyword(kw: string): boolean {
    const token = this.peek();
    return token.type === 'KEYWORD' && token.value.toUpperCase() === kw.toUpperCase();
  }

  parseDiagram(): Diagram {
    const outputs: DiagramOutput[] = [];
    const objects: ObjectDecl[] = [];
    const portMeta: PortMeta[] = [];
    const attributes: AttributeDecl[] = [];
    const connections: ConnectDecl[] = [];
    const styles: StyleDecl[] = [];
    const options: OptionDecl[] = [];

    while (this.peek().type !== 'EOF') {
      if (this.isKeyword('CONNECT')) {
        this.advance();
        const conn = this.parseConnect();
        if (conn) connections.push(conn);
      } else if (this.isKeyword('OPTION')) {
        this.advance();
        const nameToken = this.peek();
        const name = this.advance()?.value ?? '';
        this.expect('OP', '=');
        // Accumulate every token on the value's line, so list/bracket values work too —
        // e.g. `COMPACTNESS = 70,70` or `COMPACTNESS = [60,60]`.
        const valueToken = this.peek();
        let value = this.advance()?.value ?? '';
        while (this.peek() && this.peek()!.type !== 'EOF' && this.peek()!.line === valueToken?.line) {
          value += this.advance()!.value;
        }
        options.push({ name, value, pos: { line: nameToken.line, column: nameToken.column, offset: nameToken.offset } });
      } else if (this.isKeyword('STYLE')) {
        this.advance();
        // The tokenizer emitted the CSS body as a single STRING token (raw text between STYLE
        // and END). If no STRING follows (empty STYLE block), push empty CSS.
        const cssToken = this.peek();
        if (cssToken.type === 'STRING') {
          styles.push({ css: this.advance()!.value });
        } else {
          styles.push({ css: '' });
        }
        // Consume the END keyword that closes the STYLE block.
        this.match('KEYWORD', 'END');
      } else if (this.isKeyword('STYLESHEET')) {
        this.advance();
        this.expect('STRING');
      } else if (this.isKeyword('IMPORT')) {
        this.advance();
        this.match('KEYWORD', 'TEMPLATE');
        this.expect('STRING');
        this.match('KEYWORD', 'AS');
        this.advance();
      } else if (this.isKeyword('SYMBOL')) {
        this.advance();
        while (this.peek().type !== 'EOF' && !this.isKeyword('END')) {
          this.advance();
        }
        this.match('KEYWORD', 'END');
      } else {
        const la1 = this.peek();
        const la2 = this.peekAt(1);
        const la3 = this.peekAt(2);

        if (la2 && la2.value === '#') {
          const obj = this.parseObjectDecl();
          if (obj) objects.push(obj);
        } else if (la2 && la2.value === '.' && la3) {
          const propName = la3.value;
          if (propName === 'Name' || propName === 'Description' || propName === 'Style' || propName.toUpperCase() === 'OUT') {
            const meta = this.parsePortMeta();
            if (meta) portMeta.push(meta);
          } else {
            const attr = this.parseAttributeOrPort();
            if (attr) attributes.push(attr as AttributeDecl);
          }
        } else if (la2 && la2.value === '=' && la1.type !== 'EOF') {
          const expr = this.parseExpression();
          if (expr) outputs.push(expr);
        } else {
          this.advance();
        }
      }
    }

    return { outputs, objects, portMeta, attributes, connections, styles, options };
  }

  private parsePortMeta(): PortMeta | null {
    const nameToken = this.peek();
    const identifier = this.advance()?.value ?? '';
    this.expect('OP', '.');
    const propName = this.advance()?.value ?? '';
    this.expect('OP', '=');
    const value = this.peek().type === 'STRING' ? this.advance()?.value ?? '' : this.advance()?.value ?? '';

    let property: 'Name' | 'Description' | 'Style' | 'Out' = 'Name';
    if (propName === 'Description') property = 'Description';
    else if (propName === 'Style') property = 'Style';
    else if (propName.toUpperCase() === 'OUT') property = 'Out';

    return {
      identifier,
      property,
      value,
      pos: { line: nameToken.line, column: nameToken.column, offset: nameToken.offset },
    };
  }

  private parseExpression(): DiagramOutput | null {
    const nameToken = this.peek();
    const name = this.advance()?.value ?? '';
    if (!this.expect('OP', '=')) return null;
    const expression = this.parseOrExpr();
    return { name, expression, pos: { line: nameToken.line, column: nameToken.column, offset: nameToken.offset } };
  }

  private parseOrExpr(): LogicNode {
    let left = this.parseAndExpr();
    while (this.isKeyword('OR')) {
      this.advance();
      const right = this.parseAndExpr();
      left = { kind: 'gate', gateType: 'OR', inputs: [left, right] } as GateNode;
    }
    return left;
  }

  private parseAndExpr(): LogicNode {
    let left = this.parseNotExpr();
    while (this.isKeyword('AND')) {
      this.advance();
      const right = this.parseNotExpr();
      left = { kind: 'gate', gateType: 'AND', inputs: [left, right] } as GateNode;
    }
    return left;
  }

  private parseNotExpr(): LogicNode {
    if (this.isKeyword('NOT') && this.peekAt(1).value === '#') {
      // NOT#ID(A) — function-call form with an instance id. Falls through to parsePrimary's
      // AND/OR/NOT#ID handling, but intercept here so parseNotExpr doesn't consume the NOT.
      return this.parsePrimary();
    }
    if (this.isKeyword('NOT')) {
      this.advance();
      const inner = this.parseNotExpr();
      return { kind: 'gate', gateType: 'NOT', inputs: [inner] } as GateNode;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): LogicNode {
    if (this.match('OP', '(')) {
      const expr = this.parseOrExpr();
      this.expect('OP', ')');
      return expr;
    }

    const token = this.peek();

    // AND#ID(...) / OR#ID(...) / NOT#ID(...) — function-call form with an instance id so the
    // gate can carry .Name / .Description without the pass-through-intermediate trick.
    if (token.type === 'KEYWORD' && (token.value === 'AND' || token.value === 'OR' || token.value === 'NOT')
        && this.peekAt(1).value === '#') {
      const gateType = this.advance()!.value as GateType;
      this.advance(); // '#'
      const id = this.advance()?.value ?? undefined;
      this.expect('OP', '(');
      const inputs: LogicNode[] = [];
      if (this.peek().value !== ')') {
        do { inputs.push(this.parseOrExpr()); } while (this.match('OP', ','));
      }
      this.expect('OP', ')');
      return { kind: 'gate', gateType, id, inputs } as GateNode;
    }

    if (token.type === 'SYMBOL_NAME') {
      const symbolName = this.advance()!.value;
      // Optional instance id is part of the name: BLOCK#id(...) or SYMBOL_NAME#ID.
      const id = this.match('OP', '#') ? this.advance()?.value : undefined;
      // A known block type followed by '(' is a function-block call.
      if (BLOCK_TYPES.has(symbolName as BlockType) && this.peek().value === '(') {
        return this.parseBlockCall(symbolName as BlockType, id);
      }
      const portName = this.match('OP', '.') ? this.advance()?.value : undefined;
      if (id !== undefined || portName !== undefined) {
        return { kind: 'symbolRef', symbolName, id, portName } as SymbolRefNode;
      }
      return { kind: 'port', name: symbolName } as PortNode;
    }

    if (token.type === 'IDENT') {
      const name = this.advance()!.value;
      return { kind: 'port', name } as PortNode;
    }

    this.errors.push({
      message: `Unexpected token: '${token.value}' (${token.type})`,
      line: token.line,
      column: token.column,
      offset: token.offset,
    });
    this.advance();
    return { kind: 'port', name: '__error__' } as PortNode;
  }

  // Parse a SEL function-block call: BLOCK#id( arg, arg, NAME=value, ... ).port
  // Arguments are signal expressions; durations/numbers are positional settings (PU then DO
  // for a timer); `NAME=value` items are named settings (PU, DO, DOMINANT, ...).
  private parseBlockCall(blockType: BlockType, id?: string): BlockNode {
    this.expect('OP', '(');
    const inputs: LogicNode[] = [];
    const inputLabels: (string | undefined)[] = [];
    const params: Record<string, string> = {};
    let posNum = 0;
    if (this.peek().value !== ')') {
      do {
        const t = this.peek();
        const next = this.peekAt(1);
        if ((t.type === 'IDENT' || t.type === 'SYMBOL_NAME') && next.value === '=') {
          const key = this.advance()!.value;
          this.advance(); // '='
          if (blockType === 'FB') {
            // A generic block's named argument is a labelled input port, not a setting.
            inputs.push(this.parseOrExpr());
            inputLabels.push(key);
          } else {
            params[key.toUpperCase()] = this.advance()?.value ?? '';
          }
        } else if ((t.type === 'DURATION' || t.type === 'NUMBER') && blockType !== 'FB') {
          const v = this.advance()!.value;
          if (blockType === 'TIMER') params[posNum === 0 ? 'PU' : 'DO'] = v;
          else params[`P${posNum}`] = v;
          posNum++;
        } else {
          inputs.push(this.parseOrExpr());
          inputLabels.push(undefined);
        }
      } while (this.match('OP', ','));
    }
    this.expect('OP', ')');
    const port = this.match('OP', '.') ? this.advance()?.value : undefined;
    return { kind: 'block', blockType, id, inputs, inputLabels, params, port };
  }

  private parseObjectDecl(): ObjectDecl | null {
    const nameToken = this.peek();
    const symbolName = this.advance()?.value ?? '';
    let id: string | undefined;
    if (this.match('OP', '#')) {
      id = this.advance()?.value;
    }
    return { symbolName, id, pos: { line: nameToken.line, column: nameToken.column, offset: nameToken.offset } };
  }

  private parseAttributeOrPort(): AttributeDecl | null {
    const nameToken = this.peek();
    const objRef = this.advance()?.value ?? '';
    let id: string | undefined;

    if (this.peek().value === '#') {
      this.advance();
      id = this.advance()?.value;
    }

    this.expect('OP', '.');
    const attrName = this.advance()?.value ?? '';

    this.expect('OP', '=');

    let value = '';
    const valToken = this.peek();
    if (valToken.type === 'STRING') {
      value = this.advance()?.value ?? '';
    } else if (valToken.type === 'DURATION' || valToken.type === 'NUMBER' || valToken.type === 'IDENT') {
      value = this.advance()?.value ?? '';
    } else if (valToken.type === 'KEYWORD' && (valToken.value === 'TRUE' || valToken.value === 'FALSE')) {
      value = this.advance()?.value ?? '';
    } else {
      const rhs = this.parseOrExpr();
      value = rhs !== null ? '(expression)' : '';
    }

    return {
      objectRef: objRef,
      id,
      attributeName: attrName,
      value,
      pos: { line: nameToken.line, column: nameToken.column, offset: nameToken.offset },
    };
  }

  private parseConnect(): ConnectDecl | null {
    const fromObj = this.advance()?.value ?? '';
    let fromId: string | undefined;
    if (this.match('OP', '#')) {
      fromId = this.advance()?.value;
    }
    this.expect('OP', '.');
    const fromPort = this.advance()?.value ?? '';

    const toObj = this.advance()?.value ?? '';
    let toId: string | undefined;
    if (this.match('OP', '#')) {
      toId = this.advance()?.value;
    }
    this.expect('OP', '.');
    const toPort = this.advance()?.value ?? '';

    return { fromObject: fromObj, fromId, fromPort, toObject: toObj, toId, toPort };
  }

  private parseStyleBlock(): string {
    // Extract raw CSS source between STYLE and END STYLE, bypassing the tokenizer (which
    // mangles CSS selectors like #G1, .ldl-fill, { fill: #fff3cd; } into individual tokens).
    // The STYLE keyword has already been consumed; find the next END keyword and extract
    // everything in the source between the end of this line and the END line.
    const styleToken = this.tokens[Math.max(0, this.pos - 1)];
    const startOffset = styleToken.offset + styleToken.value.length;
    // Find the end of the STYLE line so CSS starts on the next line.
    const lineEnd = this.source.indexOf('\n', startOffset);
    const cssStart = lineEnd === -1 ? this.source.length : lineEnd + 1;
    // Find the next standalone END keyword (on its own line, case-insensitive).
    const endMatch = this.source.slice(cssStart).match(/\n\s*END\s*(\n|$)/i);
    let cssEnd: number;
    if (endMatch) {
      cssEnd = cssStart + endMatch.index!;
    } else {
      cssEnd = this.source.length;
    }
    const css = this.source.slice(cssStart, cssEnd).trim();
    // Skip tokens until past the END keyword that closes the STYLE block.
    while (this.peek().type !== 'EOF' && !this.isKeyword('END')) {
      this.advance();
    }
    this.match('KEYWORD', 'END');
    return css;
  }
}

export function parse(source: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(source);

  if (lexErrors.length > 0) {
    return {
      diagram: { outputs: [], objects: [], portMeta: [], attributes: [], connections: [], styles: [], options: [] },
      errors: lexErrors,
    };
  }

  const parser = new Parser(tokens, lexErrors, source);
  const diagram = parser.parseDiagram();

  return {
    diagram,
    errors: parser.errors,
  };
}