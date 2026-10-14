// The UI Workbench's catalog, read from the sources (docs/48): every component the kit
// exports (packages/ui/src/index.ts) and every component a renderer story sits beside,
// plus the widget packages' stories (packages/widgets/<name>/src/*.story.tsx, docs/56),
// with its props (kind, union values, required, default, doc) from the TypeScript
// checker; every *.story.tsx with its header comment and its exports' doc comments,
// parsed without the checker. Node only: plugin.ts runs it in the Workbench's dev server.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Catalog, ComponentInfo, PropInfo, PropKind, StoryInfo, VariantInfo } from "./types.ts";

export interface CatalogRoots {
  repo: string;
  /** packages/ui/src */
  kit: string;
  /** apps/desktop/src/renderer/src */
  renderer: string;
  /** packages/widgets: the built-in widget packages, whose stories are "widgets/<name>". */
  widgets: string;
}

export function catalogRoots(repo: string): CatalogRoots {
  return { repo, kit: path.join(repo, "packages/ui/src"), renderer: path.join(repo, "apps/desktop/src/renderer/src"), widgets: path.join(repo, "packages/widgets") };
}

/** Props that come from DOM or React types but matter for a component's states (children: only where the implementation takes them by name; an <input> passes them on in ...rest). */
const INHERITED = new Set(["children", "disabled", "placeholder"]);
/** Never worth a control or a row. */
const SKIPPED = new Set(["key", "ref", "className", "style"]);

export function storyFiles(roots: CatalogRoots): string[] {
  const widgets = fs.existsSync(roots.widgets) ? walk(roots.widgets).filter((f) => /[\\/]src[\\/][^\\/]+\.story\.tsx$/.test(f)) : [];
  return [...[roots.kit, roots.renderer].flatMap((dir) => walk(dir).filter((f) => f.endsWith(".story.tsx"))), ...widgets].sort();
}

/** A widget package's story: its package's name, and whether the package has more than this one. */
export function widgetStoryOf(file: string, roots: CatalogRoots): { pkg: string; only: boolean } | null {
  if (!file.startsWith(roots.widgets + path.sep)) return null;
  const pkg = path.relative(roots.widgets, file).split(path.sep)[0]!;
  return { pkg, only: fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".story.tsx")).length === 1 };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** "button.story.tsx" → "button.tsx", if it exists. */
function besideOf(story: string): string | undefined {
  const p = story.replace(/\.story\.tsx$/, ".tsx");
  return fs.existsSync(p) ? p : undefined;
}

/**
 * Parsed source files kept across extractions, by path and mtime, so a change re-reads
 * only what changed (lib.d.ts and React's types are most of the work).
 */
export class SourceCache {
  #files = new Map<string, { mtime: number; sf: ts.SourceFile }>();
  forget(file: string): void {
    this.#files.delete(path.resolve(file));
  }
  host(options: ts.CompilerOptions): ts.CompilerHost {
    const host = ts.createCompilerHost(options, true);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (file, lang, onError, fresh) => {
      const key = path.resolve(file);
      const mtime = fs.statSync(key, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      const hit = this.#files.get(key);
      if (hit && hit.mtime === mtime && !fresh) return hit.sf;
      const sf = read(file, lang, onError, fresh);
      if (sf) this.#files.set(key, { mtime, sf });
      return sf;
    };
    return host;
  }
}

export function extractCatalog(roots: CatalogRoots, cache = new SourceCache()): Catalog {
  const start = performance.now();
  const stories = storyFiles(roots);
  const kitIndex = path.join(roots.kit, "index.ts");
  // A widget package's components are the widget API's elements, not the kit's: nothing to read beside them.
  const beside = stories.map(besideOf).filter((f): f is string => !!f && !f.startsWith(roots.kit) && !f.startsWith(roots.widgets));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node", "vite/client"],
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  const program = ts.createProgram({ rootNames: [kitIndex, ...beside], options, host: cache.host(options) });
  const checker = program.getTypeChecker();
  const rel = (f: string) => path.relative(roots.repo, f);

  const components: ComponentInfo[] = [];
  const read = (file: string, id: (name: string) => string, kit: boolean, only?: (decl: string) => boolean) => {
    const sf = program.getSourceFile(file);
    const mod = sf && checker.getSymbolAtLocation(sf);
    if (!mod) return;
    for (const exp of checker.getExportsOfModule(mod)) {
      const info = component(checker, exp, kit);
      if (!info || (only && !only(info.file))) continue;
      components.push({ ...info, id: id(info.name), file: rel(info.file) });
    }
  };
  read(kitIndex, (n) => `ui/${n}`, true);
  for (const f of beside) {
    const folder = path.relative(roots.renderer, path.dirname(f)).split(path.sep).join("/");
    read(f, (n) => `${folder}/${n}`, false, (decl) => decl === f);
  }

  const byFile = new Map<string, ComponentInfo[]>();
  for (const c of components) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const kitByName = new Map(components.filter((c) => c.kit).map((c) => [c.name.toLowerCase(), c]));
  return { components, stories: stories.map((f) => story(f, roots, byFile, kitByName)), ms: Math.round(performance.now() - start) };
}

// ── components ─────────────────────────────────────────

type Found = Omit<ComponentInfo, "id">;

function component(checker: ts.TypeChecker, exp: ts.Symbol, kit: boolean): Found | undefined {
  const name = exp.getName();
  if (!/^[A-Z]/.test(name) || /^[A-Z0-9_]+$/.test(name)) return undefined;
  const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
  const decl = sym.valueDeclaration;
  if (!decl || !(sym.flags & ts.SymbolFlags.Value)) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(sym, decl);
  // A React context (DialogLayer) renders nothing of its own: not a component to show.
  if (type.getProperty("Provider") && type.getProperty("Consumer")) return undefined;
  const calls = type.getCallSignatures();
  const constructs = type.getConstructSignatures();
  let propsType: ts.Type | undefined;
  if (calls.length) {
    const sig = calls[0]!;
    if (!/Element|ReactNode|ReactPortal/.test(checker.typeToString(sig.getReturnType()))) return undefined;
    const p = sig.getParameters()[0];
    propsType = p && checker.getTypeOfSymbolAtLocation(p, decl);
  } else if (constructs.length) {
    const sig = constructs[0]!;
    if (!sig.getReturnType().getProperty("render")) return undefined;
    const p = sig.getParameters()[0];
    propsType = p && checker.getTypeOfSymbolAtLocation(p, decl);
  } else return undefined;
  const sf = decl.getSourceFile();
  const { defaults, named } = bindingsOf(decl);
  const props: PropInfo[] = [];
  for (const p of propsType ? checker.getPropertiesOfType(propsType) : []) {
    const info = prop(checker, p, defaults, named, decl);
    if (info) props.push(info);
  }
  const doc = text(sym.getDocumentationComment(checker)) ?? headerOf(sf.getFullText());
  return { name, file: sf.fileName, kit, doc, props };
}

function prop(checker: ts.TypeChecker, p: ts.Symbol, defaults: Map<string, string>, named: Set<string>, at: ts.Node): PropInfo | undefined {
  const name = p.getName();
  if (SKIPPED.has(name)) return undefined;
  const decls = p.getDeclarations() ?? [];
  const own = decls.some((d) => !d.getSourceFile().fileName.includes("node_modules"));
  if (!own && (!INHERITED.has(name) || (name === "children" && !named.has(name)))) return undefined;
  const decl = decls[0];
  const declared = decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type ? decl.type.getText() : undefined;
  const t = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, decl ?? at));
  const shown = declared ?? checker.typeToString(t);
  const [kind, found] = kindOf(checker, t, shown);
  // The checker orders a union its own way; the declaration (through aliases) says the author's.
  const written = decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type ? literalsOf(checker, decl.type) : undefined;
  const values = found && written && written.length === found.length && found.every((v) => written.includes(v)) ? written : found;
  const info: PropInfo = { name, kind, type: shown, required: !(p.flags & ts.SymbolFlags.Optional) };
  if (values) info.values = values;
  const d = defaults.get(name);
  if (d !== undefined) info.default = d;
  const doc = text(p.getDocumentationComment(checker));
  if (doc) info.doc = doc;
  return info;
}

function literal(t: ts.Type): string | number | boolean | undefined {
  if (t.isStringLiteral() || t.isNumberLiteral()) return t.value;
  if (t.flags & ts.TypeFlags.BooleanLiteral) return (t as unknown as { intrinsicName: string }).intrinsicName === "true";
  return undefined;
}

function kindOf(checker: ts.TypeChecker, t: ts.Type, shown: string): [PropKind, PropInfo["values"]?] {
  const parts = t.isUnion() ? t.types : [t];
  const lits = parts.map(literal);
  if (lits.every((v) => v !== undefined)) {
    if (lits.every((v) => typeof v === "boolean")) return ["boolean"];
    // `boolean` is true | false in a union: keep the declared order of the rest, false before true.
    return ["union", lits as (string | number | boolean)[]];
  }
  // A list or a record of things (`readonly { title: ReactNode }[]`) is data, whatever it holds.
  if (!t.isUnion() && (checker.isArrayLikeType(t) || (t.flags & ts.TypeFlags.Object && !t.getCallSignatures().length && !/^(ReactNode|ReactElement|JSX\.Element)\b/.test(shown)))) return ["other"];
  if (/\b(ReactNode|ReactElement|JSX\.Element)\b/.test(shown)) return ["node"];
  if (parts.some((p) => p.getCallSignatures().length)) return ["function"];
  if (t.flags & ts.TypeFlags.StringLike) return ["string"];
  if (t.flags & ts.TypeFlags.NumberLike) return ["number"];
  if (t.flags & ts.TypeFlags.BooleanLike) return ["boolean"];
  return ["other"];
}

/** A union's literals as written: `"a" | "b"`, through type aliases (`Tone`) and nested unions. */
function literalsOf(checker: ts.TypeChecker, node: ts.TypeNode, depth = 0): (string | number | boolean)[] | undefined {
  if (depth > 5) return undefined;
  if (ts.isParenthesizedTypeNode(node)) return literalsOf(checker, node.type, depth + 1);
  if (ts.isUnionTypeNode(node)) {
    const all = node.types.map((t) => literalsOf(checker, t, depth + 1));
    return all.every((a) => a) ? all.flat() as (string | number | boolean)[] : undefined;
  }
  if (ts.isLiteralTypeNode(node)) {
    const l = node.literal;
    if (ts.isStringLiteral(l)) return [l.text];
    if (ts.isNumericLiteral(l)) return [Number(l.text)];
    if (l.kind === ts.SyntaxKind.TrueKeyword) return [true];
    if (l.kind === ts.SyntaxKind.FalseKeyword) return [false];
    return undefined;
  }
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return [false, true];
  if (ts.isTypeReferenceNode(node)) {
    let sym = checker.getSymbolAtLocation(node.typeName);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const alias = sym?.declarations?.find(ts.isTypeAliasDeclaration);
    return alias ? literalsOf(checker, alias.type, depth + 1) : undefined;
  }
  return undefined;
}

/** `({ variant = "default", size = "md", children })` in the implementation: the defaults, as written, and every name it takes. */
function bindingsOf(decl: ts.Node): { defaults: Map<string, string>; named: Set<string> } {
  const out = new Map<string, string>();
  const named = new Set<string>();
  let fn: ts.SignatureDeclaration | undefined;
  const find = (n: ts.Node): void => {
    if (fn) return;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) fn = n;
    else ts.forEachChild(n, find);
  };
  if (ts.isFunctionDeclaration(decl)) fn = decl;
  else find(decl);
  const pattern = fn?.parameters[0]?.name;
  if (!pattern || !ts.isObjectBindingPattern(pattern)) return { defaults: out, named };
  for (const el of pattern.elements) {
    if (el.dotDotDotToken) continue;
    const key = el.propertyName ?? el.name;
    if (!ts.isIdentifier(key)) continue;
    named.add(key.text);
    if (el.initializer) out.set(key.text, el.initializer.getText());
  }
  return { defaults: out, named };
}

function text(parts: ts.SymbolDisplayPart[]): string | undefined {
  const s = ts.displayPartsToString(parts).trim();
  return s || undefined;
}

// ── stories ────────────────────────────────────────────


function story(file: string, roots: CatalogRoots, byFile: Map<string, ComponentInfo[]>, kitByName: Map<string, ComponentInfo>): StoryInfo {
  const kit = file.startsWith(roots.kit);
  const inside = path.relative(kit ? roots.kit : roots.renderer, file).split(path.sep).join("/");
  const base = path.basename(file, ".story.tsx");
  const pkg = widgetStoryOf(file, roots);
  // Kit files are named in lower case (button.tsx): their stories' titles aren't.
  const title = kit ? base.replace(/^./, (c) => c.toUpperCase()) : pkg ? pkg.pkg : base;
  const folder = path.posix.dirname(inside);
  // Widget packages' stories (docs/56) are "widgets/…": the package view's, and each package's ("widgets/agents").
  const group = kit ? (folder === "." ? "ui" : `ui/${folder}`) : pkg ? "widgets" : folder === "." ? "app" : folder === "windows/package" ? "widgets" : folder;
  const id = pkg ? (pkg.only ? `widgets/${pkg.pkg}` : `widgets/${pkg.pkg}/${base.toLowerCase()}`) : `${group}/${base.toLowerCase()}`;
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Imported from the kit (@cmd/ui, or a kit file beside a kit story), not a local namesake.
  const fromKit = new Set<string>();
  for (const st of sf.statements)
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && (st.moduleSpecifier.text === "@cmd/ui" || (kit && st.moduleSpecifier.text.startsWith("./"))) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings))
      for (const el of st.importClause.namedBindings.elements) fromKit.add((el.propertyName ?? el.name).text);
  // What a story can show: the components of the file beside it and the kit's it imports, by name.
  const besideFile = besideOf(file);
  const candidates = new Map<string, ComponentInfo>([...(besideFile ? (byFile.get(path.relative(roots.repo, besideFile)) ?? []) : []), ...[...kitByName.values()].filter((c) => fromKit.has(c.name))].map((c) => [c.name, c]));

  // Each top-level declaration's text, so a variant's helpers (a local Win around a FindBar) count as what it renders.
  const decls = new Map<string, string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) decls.set(st.name.text, st.getText());
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, d.getText());
  }
  /** The component names rendered (<Name …>) in a declaration and in the local ones it refers to (a helper, a list of rows), transitively. */
  const rendered = (name: string, seen = new Set<string>(), tags = new Set<string>()): Set<string> => {
    if (seen.has(name)) return tags;
    seen.add(name);
    const text = decls.get(name) ?? "";
    for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) tags.add(m[1]!);
    for (const local of decls.keys()) if (local !== name && new RegExp(`\\b${local}\\b`).test(text)) rendered(local, seen, tags);
    return tags;
  };

  const variants: VariantInfo[] = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    const names = ts.isVariableStatement(st)
      ? st.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : "")).filter(Boolean)
      : ts.isFunctionDeclaration(st) && st.name
        ? [st.name.text]
        : [];
    const doc = docAbove(src, st);
    for (const name of names) {
      if (name === "args") continue;
      const shows = [...rendered(name)].flatMap((n) => (candidates.has(n) ? [candidates.get(n)!.id] : []));
      variants.push({ name, ...(doc ? { doc } : {}), components: shows });
    }
  }
  // What it shows: what its variants render; the file beside it's components first, then the one it is named after.
  const own = new Set((besideFile ? (byFile.get(path.relative(roots.repo, besideFile)) ?? []) : []).map((c) => c.id));
  const named = kitByName.get(base.toLowerCase())?.id;
  const rank = (id: string) => (own.has(id) ? 0 : id === named ? 1 : 2);
  const components = [...new Set(variants.flatMap((v) => v.components ?? []))].sort((a, b) => rank(a) - rank(b));
  const doc = headerOf(src);
  const info: StoryInfo = { id, title, group, file: path.relative(roots.repo, file), variants, components };
  if (doc) info.doc = doc;
  return info;
}

/** The comment at the top of a file (`//` lines or one block), before any code. */
export function headerOf(src: string): string | undefined {
  const ranges = [...(ts.getLeadingCommentRanges(src, 0) ?? [])];
  // A doc comment directly on the first declaration is that declaration's, not the file's.
  const last = ranges.at(-1);
  if (last && src.startsWith("/**", last.pos) && !/\n\s*\n/.test(src.slice(last.end, last.end + 3))) ranges.pop();
  const s = ranges.map((r) => clean(src.slice(r.pos, r.end))).join("\n").trim();
  return s ? paragraphs(s) : undefined;
}

/** The doc comment (or `//` lines) directly above a statement. */
function docAbove(src: string, node: ts.Node): string | undefined {
  const ranges = ts.getLeadingCommentRanges(src, node.getFullStart()) ?? [];
  const last = ranges.at(-1);
  if (!last) return undefined;
  // Only if nothing but whitespace (one line break) is between it and the statement.
  const gap = src.slice(last.end, node.getStart());
  if ((gap.match(/\n/g) ?? []).length > 1) return undefined;
  const c = src.slice(last.pos, last.end);
  if (c.startsWith("//")) {
    // Contiguous // lines.
    const block: string[] = [];
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i]!;
      const s = src.slice(r.pos, r.end);
      if (!s.startsWith("//")) break;
      if (i < ranges.length - 1 && (src.slice(r.end, ranges[i + 1]!.pos).match(/\n/g) ?? []).length > 1) break;
      block.unshift(clean(s));
    }
    return paragraphs(block.join("\n")) || undefined;
  }
  return paragraphs(clean(c)) || undefined;
}

function clean(c: string): string {
  if (c.startsWith("//")) return c.replace(/^\/\/ ?/, "");
  return c
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/** Hard-wrapped lines joined into paragraphs (a blank line ends one). */
function paragraphs(s: string): string {
  return s
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}
