// Acting on the page in a browser window for browser.act (core windows/pages.ts; the tools'
// page tool, docs/51): one script run in the page that finds the element a CSS selector means,
// describes it, tells a password, card or code field, and either outlines it (a dry run, while the
// person decides) or acts on it: click, fill, select, submit, press. DOM events, not real input:
// values are set the way frameworks notice (the native setter, then input and change).

import type { PageAction, PageActed } from "@cmd/protocol";

export interface PageActQuery {
  action: PageAction;
  selector: string;
  index?: number;
  value?: string;
  dry?: boolean;
}

/** The script for one action; its value is a PageActed (or it throws with a message the model can act on). */
export function actScript(q: PageActQuery): string {
  return `(${inPage.toString()})(${JSON.stringify(q)})`;
}

/** Runs in the page: no imports, no closures over this module. */
function inPage(q: PageActQuery): PageActed {
  const MARK = "data-cmd-acting";
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  let all: Element[];
  try {
    all = [...document.querySelectorAll(q.selector)];
  } catch {
    throw new Error(`"${q.selector}" isn't a CSS selector`);
  }
  if (!all.length) throw new Error(`nothing matches "${q.selector}": read the page again`);
  if (all.length > 1 && !q.index) throw new Error(`"${q.selector}" matches ${all.length} elements: give index (1 to ${all.length}) or a narrower selector`);
  const el = all[(q.index ?? 1) - 1] as HTMLElement | undefined;
  if (!el) throw new Error(`"${q.selector}" matches ${all.length}, not ${q.index}`);

  const input = el instanceof HTMLInputElement ? el : null;
  const label =
    el.getAttribute("aria-label") ||
    (input?.labels?.[0] ? squash(input.labels[0].textContent ?? "") : "") ||
    el.getAttribute("placeholder") ||
    squash(el.innerText ?? el.textContent ?? "").slice(0, 80) ||
    el.getAttribute("name") ||
    el.getAttribute("title") ||
    "";
  const tag = el.tagName.toLowerCase() + (input ? ` type=${input.type}` : "");
  const element = `<${tag}>${label ? ` ${label}` : ""}`;
  const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  const sensitive =
    input?.type === "password" || /cc-|one-time-code|current-password|new-password/.test(auto) || /pass(word)?|cvc|cvv|card.?num|otp|2fa|totp|pin\b/i.test(`${el.getAttribute("name") ?? ""} ${el.id}`);
  const page = { url: location.href, title: document.title, element, ...(sensitive ? { sensitive: true } : {}) };

  // Outlined while the person decides, so they see what is meant; cleared by the action or after a while.
  const outline = (ms: number) => {
    for (const x of document.querySelectorAll(`[${MARK}]`)) {
      (x as HTMLElement).style.outline = x.getAttribute(MARK) ?? "";
      x.removeAttribute(MARK);
    }
    el.setAttribute(MARK, el.style.outline);
    el.style.outline = "2px solid #0a84ff";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      if (!el.hasAttribute(MARK)) return;
      el.style.outline = el.getAttribute(MARK) ?? "";
      el.removeAttribute(MARK);
    }, ms);
  };
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (q.dry) {
    outline(30_000);
    return page;
  }
  if (sensitive && (q.action === "fill" || q.action === "press")) throw new Error("that is a password, card or code field");
  outline(900);

  const setValue = (v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (set && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) set.call(el, v);
    else if (el.isContentEditable) el.textContent = v;
    else throw new Error(`${element} isn't a field to type into`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const form = (el as HTMLInputElement).form ?? el.closest("form");
  const key = (k: string) => {
    for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, bubbles: true, cancelable: true }));
  };

  switch (q.action) {
    case "click":
      el.click();
      break;
    case "fill":
      setValue(q.value ?? "");
      break;
    case "select": {
      if (!(el instanceof HTMLSelectElement)) throw new Error(`${element} isn't a list to choose from`);
      const opt = [...el.options].find((o) => o.value === q.value) ?? [...el.options].find((o) => squash(o.text).toLowerCase() === (q.value ?? "").toLowerCase());
      if (!opt) throw new Error(`no option "${q.value}": ${[...el.options].map((o) => squash(o.text)).slice(0, 20).join(", ")}`);
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      break;
    }
    case "submit":
      if (!form) throw new Error(`${element} isn't in a form: click its button instead`);
      form.requestSubmit();
      break;
    case "press": {
      const k = (q.value ?? "enter").toLowerCase();
      el.focus();
      if (k === "enter") {
        key("Enter");
        if (form && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) form.requestSubmit();
      } else key(k === "escape" ? "Escape" : k === "tab" ? "Tab" : k);
      break;
    }
  }
  return { ...page, url: location.href, title: document.title };
}
