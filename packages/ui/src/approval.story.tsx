// The approval sheet (docs/55) in every case cmd asks: an agent typing into a terminal, opening a
// website, filling in a page, messaging another agent, a risky action, the Operator's edit, a web
// page wanting the camera, and a device pairing. Return allows, Esc denies.
import { ApprovalSheet } from "./approval.tsx";
import { Diff } from "./layout.tsx";

const noop = () => {};
const scopes = (where: string) => [
  { value: "once", label: "Once" },
  { value: "session", label: "This session" },
  { value: "always", label: `Always in “${where}”` },
];

/** An agent wants to type a command into another terminal; a second ask waits behind it. */
export const Terminal = () => (
  <ApprovalSheet
    who={{ icon: "terminal", name: "Claude “Bug hunt”", context: "demo" }}
    title="Type in the terminal “tests”"
    why="Re-running the failing test to see the error"
    exact={"pnpm vitest run src/math.test.ts  ⏎"}
    scopes={scopes("demo")}
    position={{ index: 1, count: 2 }}
    onAnswer={noop}
  />
);

/** Opening a website (pages on this Mac never ask): remembered per site. */
export const Website = () => (
  <ApprovalSheet
    who={{ icon: "terminal", name: "Codex", context: "demo" }}
    title="Open github.com"
    why="Reading the library's release notes"
    exact="https://github.com/vitest-dev/vitest/releases/tag/v4.1.0"
    scopes={[
      { value: "once", label: "Once" },
      { value: "session", label: "This session" },
      { value: "always", label: "Always for github.com" },
    ]}
    onAnswer={noop}
  />
);

/** Acting on a web page: the element as the page describes it, and what would go in. */
export const PageFill = () => (
  <ApprovalSheet
    who={{ icon: "terminal", name: "Claude “Checkout”", context: "shop" }}
    title="Fill “Search” on staging.example.com"
    why="Checking the search finds the new product"
    exact={'<input type=search name="q"> Search\n→ red running shoes'}
    scopes={[
      { value: "once", label: "Once" },
      { value: "session", label: "This session" },
      { value: "always", label: "Always on this site" },
    ]}
    onAnswer={noop}
  />
);

/** A message to another agent: typing into its terminal, the same category as a command. */
export const Message = () => (
  <ApprovalSheet
    who={{ icon: "terminal", name: "Claude “Bug hunt”", context: "demo" }}
    title="Send a message to Codex “Tests”"
    why="Telling it which file changed"
    exact={"src/math.ts changed: add() now takes three numbers. Update the tests.  ⏎"}
    scopes={scopes("demo")}
    onAnswer={noop}
  />
);

/** A risky Workspace Action (a deploy): it asks every time, never offers Always, and Allow is the danger button. */
export const Risky = () => (
  <ApprovalSheet
    who={{ icon: "terminal", name: "Claude “Release”", context: "shop" }}
    title="Run “deploy”, which is risky"
    why="Shipping the fix to production"
    exact="wrangler deploy --env production"
    scopes={[
      { value: "once", label: "Once" },
      { value: "session", label: "This session" },
    ]}
    allow="Run"
    danger
    onAnswer={noop}
  />
);

/** The Operator editing a file: the diff is what would happen. */
export const Edit = () => (
  <ApprovalSheet
    who={{ icon: "brain", name: "Operator", context: "demo" }}
    title="Edit vite.config.ts"
    why="Moving the dev server to port 5180"
    exact={<Diff lines={["@@ line 4", "  server: {", "-    port: 5173,", "+    port: 5180,", "  },"]} />}
    scopes={scopes("demo")}
    onAnswer={noop}
  />
);

/** A page in a browser window wants the camera and microphone: remembered for the site. */
export const Camera = () => (
  <ApprovalSheet
    who={{ icon: "globe", name: "meet.google.com", context: "a browser window in demo" }}
    title="Use your camera and microphone"
    scopes={[
      { value: "always", label: "Always for this site" },
      { value: "once", label: "Only this time" },
    ]}
    deny="Don't Allow"
    askWhy={false}
    onAnswer={noop}
  />
);

/** A device asking to pair: how much it may do is the choice, and the ask runs out. */
export const Pairing = () => (
  <ApprovalSheet
    who={{ icon: "iphone", name: "Jan's iPhone", context: "Remote Access" }}
    title="Allow this device to use cmd?"
    exact="maple · river · lantern · seven"
    scopes={[
      { value: "control", label: "Control" },
      { value: "view", label: "View only" },
    ]}
    deny="Don't Allow"
    expiresAt={Date.now() + 299_000}
    askWhy={false}
    onAnswer={noop}
  />
);

/** A plain yes or no: no scopes. */
export const Plain = () => <ApprovalSheet who={{ icon: "terminal", name: "Claude", context: "demo" }} title="Stop Codex “Tests”" why="It is stuck in a loop" exact="codex “Tests”: working for 42m · running pnpm test --watch" onAnswer={noop} />;
