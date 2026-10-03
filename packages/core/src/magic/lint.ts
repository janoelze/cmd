// Static checks on a widget body, for the prompt lab's metrics and (later) the
// app's repair loop: things the prompt forbids that are cheap to detect.

export interface LintResult {
  /** Literal colours (#hex, rgb(), hsl(), named-ish) outside var(). */
  literalColors: string[];
  externalResources: string[];
  /** Comments in the body (wasted tokens). */
  comments: number;
  /** Not in the style → markup → script order. */
  outOfOrder: boolean;
  bytes: number;
}

export function lintBody(body: string): LintResult {
  // A hex colour sits after ":" (CSS) or inside a quote/paren (JS, attributes); "#id" selectors don't.
  const hex = [...body.matchAll(/(?::\s*|["'`(,]\s*)(#[0-9a-fA-F]{3,8})\b/g)].map((m) => m[1]!);
  const fns = [...body.matchAll(/\b(?:rgba?|hsla?|oklch|lab|lch)\(/g)].map((m) => m[0]);
  const literalColors = [...hex, ...fns];
  const externalResources = [...body.matchAll(/\b(?:src|href)\s*=\s*["']?(https?:\/\/[^"' >]+)/g), ...body.matchAll(/@import\s+url\(["']?(https?:[^)"']+)/g)].map((m) => m[1]!);
  const comments = (body.match(/<!--[\s\S]*?-->/g)?.length ?? 0) + (body.match(/\/\*[\s\S]*?\*\//g)?.length ?? 0);
  const iStyle = body.indexOf("<style");
  const iScript = body.indexOf("<script");
  const lastStyle = body.lastIndexOf("<style");
  const lastTagBeforeScript = iScript < 0 ? -1 : body.slice(body.lastIndexOf("</script>") + 9).search(/<[a-z]/i);
  const outOfOrder = (iStyle > 0 && body.slice(0, iStyle).trim().length > 0) || (iScript >= 0 && lastStyle > iScript) || lastTagBeforeScript >= 0;
  return { literalColors: [...new Set(literalColors)], externalResources, comments, outOfOrder, bytes: Buffer.byteLength(body) };
}
