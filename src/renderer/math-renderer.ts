export interface MathSegment {
  type: 'plain' | 'math';
  text: string;
}

export interface MathRenderResult {
  svg: string;
  width: number;
  height: number;
  baselineOffset: number;
}

import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/util/asyncLoad/esm.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const texInput = new TeX({ packages: ['base', 'ams'] });
const svgOutput = new SVG({ fontCache: 'local', linebreaks: { inline: false } });
const doc = mathjax.document('', { InputJax: texInput, OutputJax: svgOutput });

function getExInPx(fontSize: number): number {
  return fontSize * 0.5;
}

function setSvgPixelSize(svg: any, widthPx: number, heightPx: number): void {
  adaptor.setAttribute(svg, 'width', `${widthPx}px`);
  adaptor.setAttribute(svg, 'height', `${heightPx}px`);
  adaptor.removeAttribute(svg, 'style');
}

export function renderMath(tex: string, fontSize: number): MathRenderResult | null {
  try {
    const node = doc.convert(tex, { display: false });
    const svgEl = adaptor.firstChild(node) as any;
    if (!svgEl) return null;

    const widthEx = parseFloat(adaptor.getAttribute(svgEl, 'width') || '0');
    const heightEx = parseFloat(adaptor.getAttribute(svgEl, 'height') || '0');

    const exPx = getExInPx(fontSize);
    const width = Math.max(widthEx * exPx, 10);
    const height = Math.max(heightEx * exPx, fontSize * 0.8);

    const viewBox = (adaptor.getAttribute(svgEl, 'viewBox') || '0 0 0 0').split(' ').map(Number);
    const baselineOffset = viewBox[3] > 0 ? height * (-viewBox[1] / viewBox[3]) : 0;

    setSvgPixelSize(svgEl, width, height);
    const svgStr = adaptor.outerHTML(svgEl);

    return { svg: svgStr, width, height, baselineOffset };
  } catch (e) {
    console.error('MathJax conversion failed:', e);
    return null;
  }
}

export function splitIntoSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let currentPlain = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === '$') {
      currentPlain += '$';
      i += 2;
      continue;
    }

    if (text[i] === '$') {
      const start = i + 1;
      let end = text.indexOf('$', start);
      if (end === -1) {
        currentPlain += text.slice(i);
        break;
      }

      if (currentPlain.length > 0) {
        segments.push({ type: 'plain', text: currentPlain });
        currentPlain = '';
      }

      segments.push({ type: 'math', text: text.slice(start, end) });
      i = end + 1;
      continue;
    }

    currentPlain += text[i];
    i++;
  }

  if (currentPlain.length > 0) {
    segments.push({ type: 'plain', text: currentPlain });
  }

  return segments;
}

export function hasMathContent(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && text[i + 1] === '$') {
      i += 2;
      continue;
    }
    if (text[i] === '$') {
      const end = text.indexOf('$', i + 1);
      if (end > i) return true;
    }
    i++;
  }
  return false;
}

// Approximate the advance width of a string in a sans-serif face, in pixels. Per-character
// em factors are calibrated to Helvetica/Arial and kept slightly generous so callers never
// under-estimate (which would let adjacent label segments overlap or clip the viewBox).
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch >= 'A' && ch <= 'Z') em += 0.70;
    else if (ch === 'i' || ch === 'l' || ch === 'j' || ch === 't' || ch === 'f') em += 0.30;
    else if (ch >= 'a' && ch <= 'z') em += 0.52;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else if (ch === ' ') em += 0.30;
    else if (ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === "'" || ch === '|' || ch === '!') em += 0.30;
    else if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}') em += 0.36;
    else if (code > 0x2000) em += 0.62;
    else em += 0.56;
  }
  return em * fontSize;
}
