// configValues (widget-package.ts): a window's config as its widget gets it: each field's
// default under the person's value, null or missing as unset, never a secret, nothing undeclared.

import { describe, expect, it } from "vitest";
import { configValues, type WidgetConfigField } from "../src/widget-package.ts";

const FIELDS: WidgetConfigField[] = [
  { key: "repo", title: "Repository", type: "string", default: "cmd" },
  { key: "every", title: "Every", type: "number", default: 5 },
  { key: "quiet", title: "Quiet", type: "boolean" },
  { key: "token", title: "Token", type: "string", secret: true, host: "api.github.com", default: "nope" },
];

describe("configValues", () => {
  it("puts the person's values over the defaults, never a secret nor an undeclared key", () => {
    expect(configValues(FIELDS, { repo: "other", token: "ghp_secret", stray: 1 })).toEqual({ repo: "other", every: 5 });
  });

  it("takes null or a missing value as unset, and false and 0 as values", () => {
    expect(configValues(FIELDS, { repo: null, every: 0, quiet: false })).toEqual({ repo: "cmd", every: 0, quiet: false });
    expect(configValues(FIELDS, undefined)).toEqual({ repo: "cmd", every: 5 });
    expect(configValues(undefined, { repo: "x" })).toEqual({});
  });
});
