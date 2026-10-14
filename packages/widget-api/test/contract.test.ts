// @cmd/widget-api against the protocol's API 1: every verb of API_VERBS is in the `cmd`
// object (by type and at run time, sending its own name), every element of API_ELEMENTS
// is exported with exactly the spec's props and events, the versions agree, and every
// export, verb and prop has JSDoc (the README reference is generated from it).

import path from "node:path";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { API_ELEMENTS, API_VERBS, WIDGET_API, WIDGET_API_MINOR, type ApiElement, type ApiMethods, type ApiVerb } from "@cmd/protocol/widget-tree";
import * as api from "@cmd/widget-api";
import { createHost, render } from "@cmd/widget-api/testing";
import { verbs } from "../src/cmd.ts";
import type { ElementProps } from "../src/elements.ts";

type Cmd = typeof api.cmd;
/** `cmd.agents.list` for "agents.list". */
type CmdVerb<V extends string> = V extends `${infer N extends keyof Cmd}.${infer M}` ? (M extends keyof Cmd[N] ? Cmd[N][M] : never) : never;
type Signature<V extends ApiVerb> = (...args: ApiMethods[V]["params"]) => Promise<ApiMethods[V]["result"]>;
type EveryVerbTyped = { [V in ApiVerb]: CmdVerb<V> extends Signature<V> ? true : V };

type Spec<E extends ApiElement> = (typeof API_ELEMENTS)[E];
type SpecKeys<E extends ApiElement> = keyof Spec<E>["props"] | Spec<E>["events"][number];
type PropKeys<E extends ApiElement> = Exclude<keyof ElementProps[E], "children" | "key">;
/** Per element: true when its props type has exactly the spec's props and events. */
type ElementsMatch = { [E in ApiElement]: [PropKeys<E>] extends [SpecKeys<E>] ? ([SpecKeys<E>] extends [PropKeys<E>] ? true : ["missing in elements.ts", E, Exclude<SpecKeys<E>, PropKeys<E>>]) : ["not in the spec", E, Exclude<PropKeys<E>, SpecKeys<E>>] };
/** Per element: a children prop exactly when the spec takes children. */
type ChildrenMatch = { [E in ApiElement]: ("children" extends keyof ElementProps[E] ? true : false) extends (Spec<E>["children"] extends "none" ? false : true) ? true : ["children", E] };

describe("verbs", () => {
  it("every verb of the protocol is in cmd, with its signature (tsc)", () => {
    expectTypeOf<keyof typeof verbs>().toEqualTypeOf<ApiVerb>();
    expectTypeOf<EveryVerbTyped>().toEqualTypeOf<{ [V in ApiVerb]: true }>();
  });

  it("every verb is cmd.<namespace>.<name> and sends a call with its own name", async () => {
    const host = createHost();
    await render(() => null, host);
    for (const v of API_VERBS) {
      const [ns, name] = v.split(".") as [keyof Cmd, string];
      const fn = (api.cmd[ns] as Record<string, unknown>)[name];
      expect(typeof fn, v).toBe("function");
      await (fn as (...a: unknown[]) => Promise<unknown>)("x", 1).catch(() => {});
    }
    expect(host.requests.map((r) => r[0])).toEqual([...API_VERBS]);
  });
});

describe("elements", () => {
  it("each element's props and events are the spec's (tsc)", () => {
    expectTypeOf<ElementsMatch>().toEqualTypeOf<{ [E in ApiElement]: true }>();
    expectTypeOf<ChildrenMatch>().toEqualTypeOf<{ [E in ApiElement]: true }>();
  });

  it("every element of the allow-list is exported as its own tag", () => {
    for (const name of Object.keys(API_ELEMENTS)) expect((api as Record<string, unknown>)[name], name).toBe(name);
  });
});

it("the package speaks the protocol's API version", () => {
  expect([api.WIDGET_API, api.WIDGET_API_MINOR]).toEqual([WIDGET_API, WIDGET_API_MINOR]);
});

describe("docs", () => {
  const root = path.join(import.meta.dirname, "..");
  const program = ts.createProgram([path.join(root, "src/index.ts")], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.ReactJSX, allowImportingTsExtensions: true, noEmit: true, strict: true, types: ["node"] });
  const checker = program.getTypeChecker();
  const index = checker.getSymbolAtLocation(program.getSourceFile(path.join(root, "src/index.ts"))!)!;
  const doc = (s: ts.Symbol) => ts.displayPartsToString(s.getDocumentationComment(checker)).trim();
  const exported = checker.getExportsOfModule(index).map((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s));

  it("every export of @cmd/widget-api has JSDoc", () => {
    // Types re-exported from the protocol carry its docs; the rest are ours.
    const missing = exported.filter((s) => !doc(s) && !s.declarations?.some((d) => d.getSourceFile().fileName.includes("protocol"))).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it("every namespace and verb of cmd has JSDoc with @since", () => {
    const cmd = exported.find((s) => s.name === "cmd")!;
    const missing: string[] = [];
    for (const ns of checker.getTypeOfSymbol(cmd).getProperties()) {
      if (!doc(ns) || !ns.getJsDocTags(checker).some((t) => t.name === "since")) missing.push(ns.name);
      if (ns.name === "fmt") continue;
      for (const m of checker.getTypeOfSymbol(ns).getProperties()) if (!doc(m) || !m.getJsDocTags(checker).some((t) => t.name === "since")) missing.push(`${ns.name}.${m.name}`);
    }
    expect(missing).toEqual([]);
  });

  it("every prop of every element has JSDoc", () => {
    const missing: string[] = [];
    for (const name of Object.keys(API_ELEMENTS)) {
      const props = exported.find((s) => s.name === `${name}Props`);
      if (!props) continue; // ToolbarSpacer takes none
      for (const p of checker.getDeclaredTypeOfSymbol(props).getProperties()) if (!doc(p)) missing.push(`${name}.${p.name}`);
    }
    expect(missing).toEqual([]);
  });
});
