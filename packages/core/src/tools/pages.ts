// Acting on a browser page (docs/54, docs/51): click, fill a field, pick an option, submit a
// form, press a key. Pages are the most untrusted thing it reads, so every action asks first,
// showing the site, the element as the page describes it and exactly what it would type; a
// password, card or one-time-code field is refused outright. Before asking, a dry run finds the
// element and outlines it on the page, so the person sees what is meant.

import type { PageAction } from "@cmd/protocol";
import { ref, schema, str, windowOf, type ToolContext, type Input, type Tool } from "./kit.ts";

const ACTIONS: PageAction[] = ["click", "fill", "select", "submit", "press"];

const host = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

async function target(i: Input, b: ToolContext) {
  const w = await windowOf(b, i.ref);
  if (w.kind !== "browser") throw new Error(`${String(i.ref)} is not a browser window`);
  const action = str(i.do) as PageAction;
  if (!ACTIONS.includes(action)) throw new Error(`do is ${ACTIONS.join(", ")}`);
  const selector = str(i.css)?.trim();
  if (!selector) throw new Error("give the element's CSS selector (read the page with css to find it)");
  const value = action === "press" ? (str(i.key) ?? "enter") : str(i.value);
  if ((action === "fill" || action === "select") && value === undefined) throw new Error(`${action} needs a value`);
  return { w, action, selector, index: typeof i.index === "number" ? i.index : undefined, value };
}

const pageTool: Tool = {
  acts: true,
  spec: {
    name: "page",
    explores: false,
    description:
      "Act on a browser window's page: `click` an element, `fill` a field with `value`, `select` an option by its value or text, `submit` the element's form, or `press` a key (enter, escape, tab) on it. Find the element first with read (css, xpath) and give its CSS selector, plus `index` (from 1) when several match. Every action asks the person first. Never for passwords, card numbers or codes: ask the person to enter those. Afterwards, read the page again to see what happened.",
    schema: schema(
      {
        ref,
        do: { type: "string", enum: ACTIONS },
        css: { type: "string", description: "The element's CSS selector." },
        index: { type: "number", description: "Which match, from 1, when the selector matches several." },
        value: { type: "string", description: "fill: the text; select: the option's value or text." },
        key: { type: "string", enum: ["enter", "escape", "tab"], description: "press: the key." },
      },
      ["ref", "do", "css"],
    ),
  },
  target: (i, b) => b.refs.id(i.ref),
  async confirm(i, b) {
    const t = await target(i, b);
    const found = await b.call("browser.act", { id: t.w.id, action: t.action, selector: t.selector, index: t.index, value: t.value, dry: true });
    if (found.sensitive) throw new Error(`refused: ${found.element} is a password, card or code field. Ask the person to fill it in themselves.`);
    const verb = { click: "Click", fill: "Type into", select: "Choose in", submit: "Submit the form of", press: `Press ${t.value} in` }[t.action];
    const noun = { click: "clicks", fill: "typing", select: "choosing in lists", submit: "submitting forms", press: "key presses" }[t.action];
    const site = host(found.url);
    return {
      title: `${verb} ${found.element.replace(/^<[^>]*>\s*/, "").slice(0, 60) || found.element} on ${site}`,
      exact: [found.element, t.action === "fill" || t.action === "select" ? `→ ${t.value}` : ""].filter(Boolean).join("\n"),
      rule: { key: `page:${site}:${t.action}`, label: `${noun} on ${site}` },
    };
  },
  async run(i, b) {
    const t = await target(i, b);
    const after = await b.call("browser.act", { id: t.w.id, action: t.action, selector: t.selector, index: t.index, value: t.value });
    return `Done: ${t.action} ${after.element}. The page is now “${after.title}” (${after.url}); read it to see what happened.`;
  },
};

export const PAGE_TOOLS: Tool[] = [pageTool];
