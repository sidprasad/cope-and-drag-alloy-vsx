import * as fs from 'fs';
import * as path from 'path';

/**
 * Sidecar Cope and Drag layout specs.
 *
 * Forge tells Cope and Drag how to lay out an instance by embedding the spec in the instance XML as
 * a `<visualizer cnd="...">` element; CnD reads it via `querySelectorAll('visualizer')` +
 * `getAttribute('cnd')` (see copeanddrag/packages/alloy-instance/src/xml.ts). Alloy's own XML has no
 * such element, so we add it ourselves: a model `foo.als` pairs with a sidecar `foo.cnd` (plain
 * YAML, the CnD spec language). When present, we splice it into every instance's XML before handing
 * it to CnD — no change to Alloy or the bridge required.
 */

/** Path of the sidecar spec for an Alloy model: `/x/foo.als` -> `/x/foo.cnd`. */
export function cndSidecarPath(alsPath: string): string {
  const dir = path.dirname(alsPath);
  const base = path.basename(alsPath, path.extname(alsPath));
  return path.join(dir, base + '.cnd');
}

/** Read the sidecar `.cnd` spec for a model, or undefined if there isn't one (or it's blank). */
export function readCndSpec(alsPath: string): string | undefined {
  try {
    const text = fs.readFileSync(cndSidecarPath(alsPath), 'utf8');
    return text.trim().length ? text : undefined;
  } catch {
    return undefined; // no sidecar / unreadable — CnD falls back to its default layout
  }
}

/**
 * Escape a string for use as an XML attribute value. Newlines and tabs are emitted as numeric
 * character references because XML attribute-value normalization would otherwise collapse literal
 * newlines/tabs to spaces — which would destroy the YAML's structure. CnD's DOM parser decodes
 * these back to real characters on read, so the spec round-trips intact.
 */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

/**
 * Splice a `<visualizer cnd="...">` element into Alloy instance XML so Cope and Drag adopts the
 * spec exactly the way it does for Forge. The element is inserted just before the closing
 * `</alloy>` (Alloy wraps instances in `<alloy>...<instance/>...</alloy>`); as a fallback, a bare
 * `<instance>` document is wrapped in `<alloy>`. CnD finds the element anywhere via querySelectorAll.
 *
 * Returns the XML unchanged when there is no spec.
 */
export function injectVisualizer(xml: string, spec: string | undefined): string {
  if (!spec || !spec.trim().length) return xml;
  const vis = `<visualizer cnd="${escapeXmlAttr(spec)}"></visualizer>`;
  const trimmed = xml.trimEnd();

  const close = trimmed.lastIndexOf('</alloy>');
  if (close >= 0) {
    return trimmed.slice(0, close) + vis + '\n' + trimmed.slice(close) + '\n';
  }

  // No <alloy> wrapper (shouldn't happen with A4SolutionWriter, but be defensive): wrap it, keeping
  // any <?xml ...?> prolog at the very front where it's required to be.
  const m = /^\s*<\?xml[^>]*\?>\s*/.exec(trimmed);
  const prolog = m ? m[0] : '';
  const body = prolog ? trimmed.slice(prolog.length) : trimmed;
  return `${prolog}<alloy>\n${body}\n${vis}\n</alloy>\n`;
}
