import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';

interface LdlState {
  afterDot: boolean;
}

const ldlStreamParser: StreamParser<LdlState> = {
  name: 'ldl',
  blankLine: () => {},
  startState: () => ({ afterDot: false }),
  token(stream: any, state: LdlState) {
    if (stream.eatSpace()) {
      return null;
    }

    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }

    if (state.afterDot) {
      state.afterDot = false;
      if (stream.match(/^(?:Name|Description)\b/)) {
        return 'propertyName';
      }
    }

    if (stream.match(/\./)) {
      state.afterDot = true;
      return 'punctuation';
    }

    if (stream.match(/^[A-Z][A-Z0-9_]*\b/)) {
      return 'typeName';
    }

    if (stream.match(/^(?:AND|OR|NOT|NAND|NOR|XOR|XNOR)\b/i)) {
      return 'keyword';
    }

    if (stream.match(/^(?:SYMBOL|END|PORT|INPUT|OUTPUT|BIDI|ATTRIBUTE|IMPORT|TEMPLATE|CONNECT|STYLE|STYLESHEET|LINK|AS)\b/i)) {
      return 'keyword';
    }

    if (stream.match(/^(?:TRUE|FALSE)\b/i)) {
      return 'keyword';
    }

    if (stream.match(/^"([^"]*)"/)) {
      return 'string';
    }

    if (stream.match(/^\d+(\.\d+)?\s*(ms|s(?![a-zA-Z])|m(?![a-zA-Z]))\b/)) {
      return 'number';
    }

    if (stream.match(/^\d+(\.\d+)?\b/)) {
      return 'number';
    }

    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*\b/)) {
      return 'variableName';
    }

    if (stream.match(/^[=()#{}]/)) {
      return 'punctuation';
    }

    stream.next();
    return null;
  },
};

export function ldlLanguage(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(ldlStreamParser));
}