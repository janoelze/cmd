// Bassdrive's widget process against the fake host: the station in the title bar.

import { expect, it } from "vitest";
import { render, createHost } from "@cmd/widget-api/testing";
import Radio from "./radio.tsx";

it("names the station in the title bar", async () => {
  const tree = await render(<Radio />, createHost());
  expect(tree.find("Window").props.status).toBe("24/7 drum & bass");
});
