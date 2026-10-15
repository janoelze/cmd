// @cmd/widget-api/testing (docs/56, "Developer ergonomics"): test a widget as data, with
// no browser, Electron or Deno. `createHost` is a fake core with fixture data, `render`
// runs the widget against it through the real runtime and wire messages, and returns the
// tree with finders, `press`/`change`, and matchers that vitest gets on import.
//
//   const host = createHost({ agents: [fixtures.agent({ name: "Tours", state: "waiting" })] });
//   const tree = await render(<Widget />, host);
//   expect(tree).toHaveSection("Waiting for you", { count: 1 });
//   await tree.press(tree.rows()[0]);
//   expect(host.calls).toEqual([["windows.select", "w-tours"]]);
//
// One widget runs at a time: `cmd.*` talks to the last one rendered.

import { expect } from "vitest";
import { run, type WidgetModule } from "./runtime.ts";
import { createHost, type FakeHost } from "./testing/host.ts";
import { Mirror, RenderedTree, matchers, type WidgetMatchers } from "./testing/tree.ts";

export { createHost, type FakeHost, type HostData, type FetchFixture, type AiFixture, type RunFixture } from "./testing/host.ts";
export { fixtures, WORKSPACE_ID } from "./testing/fixtures.ts";
/** A window's config as the core gives it: the fields' defaults under the values set, never a secret (for a harness that reads package.json). */
export { configValues } from "@cmd/protocol";
export { RenderedTree, matchers, textOf, titleOf, type Node, type Element, type WidgetMatchers } from "./testing/tree.ts";

expect.extend(matchers);

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends WidgetMatchers<R> {}
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Renders a widget (an element, a component or defineWidget's result) against a fake
 * host and waits until it is idle: subscriptions answered, effects run, patches applied.
 * @since 1.0
 */
export async function render(widget: WidgetModule, host: FakeHost = createHost()): Promise<RenderedTree> {
  const mirror = new Mirror();
  const transport = host.transport;
  const watched = {
    send: (m: Parameters<typeof transport.send>[0]) => {
      mirror.apply(m);
      transport.send(m);
    },
    listen: transport.listen,
  };
  let count = () => host.messages.length;
  const settle = async () => {
    // Quiet for two rounds of the event loop: nothing in flight, nothing new sent.
    let quiet = 0;
    for (let i = 0; i < 500 && quiet < 2; i++) {
      const before = count();
      await tick();
      quiet = host.inFlight === 0 && count() === before ? quiet + 1 : 0;
    }
  };
  const running = run(watched, widget, { package: "test", version: "0.0.0", widget: "test" });
  await settle();
  const r = await running;
  count = () => host.messages.length + r.connection.busy;
  await settle();
  return new RenderedTree(host, mirror, settle, () => r.stop());
}
