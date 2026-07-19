// Browser-only helpers that rasterise a rendered SVG string (from `renderDiagram`) to a PNG or PDF.
// They use the DOM (`DOMParser`, `Image`, `<canvas>`), so they only run in a browser; in Node use
// `renderDiagram` for SVG and rasterise with your own toolchain (e.g. resvg, sharp, puppeteer).

function svgViewBox(svg: string): { el: SVGElement; w: number; h: number } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.documentElement as unknown as SVGElement;
  const vb = el.getAttribute('viewBox')?.split(/\s+/).map(Number) ?? [0, 0, 800, 400];
  return { el, w: vb[2], h: vb[3] };
}

// Draw the SVG onto a white canvas at `scale`× its intrinsic size. Resolves the canvas once painted.
function svgToCanvas(svg: string, scale: number): Promise<HTMLCanvasElement> {
  const { el, w, h } = svgViewBox(svg);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const data = new XMLSerializer().serializeToString(el);
  const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data)));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); resolve(canvas); };
    img.onerror = () => reject(new Error('Failed to rasterise SVG'));
    img.src = src;
  });
}

/**
 * Rasterise an SVG string to a PNG Blob at `scale`× the diagram's intrinsic pixel size (default 2×).
 * Browser only.
 */
export async function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const canvas = await svgToCanvas(svg, scale);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))), 'image/png'));
}

/**
 * Rasterise an SVG string into a single-page PDF Blob sized to the diagram (orientation follows the
 * aspect ratio). Loads `jspdf` on demand. Browser only.
 */
export async function svgToPdfBlob(svg: string, scale = 2): Promise<Blob> {
  const { w, h } = svgViewBox(svg);
  const canvas = await svgToCanvas(svg, scale);
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'px', format: [w, h] });
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h);
  return pdf.output('blob');
}
