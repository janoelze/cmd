// @cmd/widget-api/testing against the example widget (examples/v1/agents.tsx): docs/56's
// own test, then the fake host's reads, acts, pushes and the matchers.

import { describe, expect, it, test } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import { Stat, Inline, useData, useCompletion, useTerminalUsage, useStat, useJournal, useWorkspaces, useAppUsage, cmd, defineWidget, View, Text, ApiCallError } from "@cmd/widget-api";
import Widget from "../examples/v1/agents.tsx";

test("waiting agents come first", async () => {
  const host = createHost({ agents: [fixtures.agent({ name: "Tours", state: "waiting" }), fixtures.agent({ name: "Perf", state: "working" })] });
  const tree = await render(<Widget />, host);
  expect(tree).toHaveSection("Waiting for you", { count: 1 });
  expect(tree.rows()[0]).toHaveTitle("Tours");
  await tree.press(tree.rows()[0]!);
  expect(host.calls).toEqual([["windows.select", "w-tours"]]);
});

describe("the example widget", () => {
  it("shows the empty state with no agents", async () => {
    const tree = await render(<Widget />, createHost());
    expect(tree).toShowState("empty", "No agents");
    expect(tree.rows()).toHaveLength(0);
  });

  it("follows the agents live: a push re-renders it as a patch", async () => {
    const host = createHost({ agents: [fixtures.agent({ name: "Perf", state: "working" })] });
    const tree = await render(<Widget />, host);
    expect(tree).not.toHaveSection("Waiting for you");
    const patches = tree.mirror.patches;
    host.set({ agents: [fixtures.agent({ name: "Perf", state: "waiting" })] });
    await tree.idle();
    expect(tree).toHaveSection("Waiting for you", { count: 1 });
    expect(tree.mirror.trees).toBe(1);
    expect(tree.mirror.patches).toBeGreaterThan(patches);
  });

  it("switches scope from the title menu and keeps it in the window's state", async () => {
    const host = createHost({ agents: [fixtures.agent({ name: "Here" }), fixtures.agent({ name: "Elsewhere", workspaceId: "ws-2" })] });
    const tree = await render(<Widget />, host);
    expect(tree).toHaveRow("Here");
    expect(tree).not.toHaveRow("Elsewhere");
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(tree).toHaveRow("Elsewhere");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    expect(host.subscriptions()).toEqual([{ id: expect.any(Number), topic: "agents", query: { scope: "all" } }]);
  });

  it("starts with the stored scope", async () => {
    const host = createHost({ state: { scope: "all" }, agents: [fixtures.agent({ name: "Elsewhere", workspaceId: "ws-2" })] });
    const tree = await render(<Widget />, host);
    expect(tree).toHaveRow("Elsewhere");
  });

  it("says who waits in the title bar", async () => {
    const host = createHost({ agents: [fixtures.agent({ name: "A", state: "waiting" }), fixtures.agent({ name: "B" }), fixtures.agent({ name: "C" })] });
    const tree = await render(<Widget />, host);
    expect(tree.find("Window").props.status).toBe("1 waiting for you · 2 working");
  });
});

describe("the fake host", () => {
  it("serves reads and records only acts", async () => {
    let seen: unknown[] = [];
    function Reads() {
      const { data } = useData(async () => {
        const ws = await cmd.workspace.get();
        const screen = await cmd.terminals.read("t-build", { lines: 1 });
        const stats = await cmd.events.stats({ types: ["command"] });
        await cmd.notify.send({ key: "k", title: "Done" });
        return [ws.name, screen.text, screen.untrusted, stats.total];
      });
      seen = data ?? [];
      return <Text>{String(data?.[0] ?? "")}</Text>;
    }
    const host = createHost({ terminals: [fixtures.pane({ title: "build", screen: "one\ntwo" })], events: [fixtures.event(), fixtures.event({ type: "agent.stop" })] });
    const tree = await render(<Reads />, host);
    expect(seen).toEqual(["app", "two", true, 1]);
    expect(tree.text()).toBe("app");
    expect(host.calls).toEqual([["notify.send", { key: "k", title: "Done" }]]);
  });

  it("refuses a verb the grant lacks, naming the permission, and the widget runs on", async () => {
    let error: unknown = null;
    function Denied() {
      const { data, error: e } = useData(() => cmd.agents.list());
      error = e;
      return <Text>{data ? "data" : "none"}</Text>;
    }
    const tree = await render(<Denied />, createHost({ deny: { "agents.list": "workspace:read" } }));
    expect(error).toBeInstanceOf(ApiCallError);
    expect((error as ApiCallError).permission).toBe("workspace:read");
    expect(tree.text()).toBe("none");
  });

  it("refuses a live hook over a verb the grant lacks, as the core does: the widget's boundary shows it", async () => {
    function Live() {
      const events = cmd.events.use({ scope: "all" });
      return <Text>{String(events.length)}</Text>;
    }
    const tree = await render(<Live />, createHost({ deny: { "events.query": 'workspace: ["all"]' } }));
    expect(tree).toShowState("error", "This widget hit an error");
    expect(tree.text()).toContain('workspace: ["all"]');
  });

  it("pushes events as they happen", async () => {
    function Log() {
      const events = cmd.events.use({ types: ["command"] });
      return <Stat label="Commands" value={events.length} />;
    }
    const host = createHost({ events: [fixtures.event()] });
    const tree = await render(<Log />, host);
    expect(tree).toHaveStat("Commands", 1);
    host.emit(fixtures.event(), fixtures.event({ type: "browser.open" }));
    await tree.idle();
    expect(tree).toHaveStat("Commands", 2);
  });

  it("gives defineWidget the config, live", async () => {
    const W = defineWidget<{ repo: string }>(({ config }) => (
      <View>
        <Inline>
          <Text>{config.repo}</Text>
        </Inline>
      </View>
    ));
    const host = createHost({ config: { repo: "jan/cmd" } });
    const tree = await render(W, host);
    expect(tree.text()).toBe("jan/cmd");
    host.set({ config: { repo: "jan/other" } });
    await tree.idle();
    expect(tree.text()).toBe("jan/other");
  });

  it("fetches through the host, from fixtures, with auth named and never a secret", async () => {
    const url = "https://api.github.com/repos/jan/cmd/actions/runs";
    function Runs() {
      const { data, error } = useData(async () => JSON.parse((await cmd.net.fetch(url, { auth: "token" })).body) as { total_count: number });
      return <Stat label="Runs" value={error ? "error" : (data?.total_count ?? "–")} />;
    }
    const host = createHost({ fetch: { [url]: { body: { total_count: 7 } } } });
    const tree = await render(<Runs />, host);
    expect(tree).toHaveStat("Runs", 7);
    expect(host.calls).toEqual([["net.fetch", url, { auth: "token" }]]);
  });

  it("serves fetches from a function, and fails one without a fixture, naming it", async () => {
    const seen: string[] = [];
    function Two() {
      const a = useData(() => cmd.net.fetch("https://a.example/x"));
      const b = useData(() => cmd.net.fetch("https://b.example/y"));
      seen.push(String(a.data?.status), b.error?.message ?? "");
      return null;
    }
    await render(<Two />, createHost({ fetch: (u) => (u.startsWith("https://a.") ? { status: 201 } : Promise.resolve(undefined as never)) }));
    expect(seen.at(-2)).toBe("201");
    expect(seen.at(-1)).toContain("No fetch fixture for GET https://b.example/y");
  });

  it("names the permission to add when the grant lacks it", async () => {
    let error: ApiCallError | null = null;
    function NoNet() {
      const { error: e } = useData(() => cmd.net.fetch("https://api.github.com/"));
      error = e as ApiCallError | null;
      return null;
    }
    await render(<NoNet />, createHost({ deny: { "net.fetch": 'net: ["api.github.com"]' } }));
    expect(error).toMatchObject({ code: "permission", permission: 'net: ["api.github.com"]' });
  });

  it("completes with the AI from fixtures: useCompletion asks once per request", async () => {
    function Summary({ prompt }: { prompt: string }) {
      const { data, loading } = useCompletion({ prompt, maxTokens: 50 });
      return <Text>{loading ? "…" : data && "text" in data ? data.text : ""}</Text>;
    }
    const host = createHost({ ai: (req) => ({ text: `about ${req.prompt}`, usage: { input: 3, output: 2 } }) });
    const tree = await render(<Summary prompt="CI" />, host);
    expect(tree.text()).toBe("about CI");
    expect(host.calls).toEqual([["ai.complete", { prompt: "CI", maxTokens: 50 }]]);
    const answer = await cmd.ai.complete({ prompt: "x", schema: { type: "object" } });
    expect(answer).toEqual({ text: "about x", usage: { input: 3, output: 2 } });
  });

  it("refuses the AI without its grant, naming it", async () => {
    let error: unknown = null;
    function Ask() {
      error = useCompletion({ prompt: "hi" }).error;
      return null;
    }
    await render(<Ask />, createHost({ ai: { text: "hello" }, deny: { "ai.complete": 'ai: ["complete"]' } }));
    expect(error).toMatchObject({ code: "permission", permission: 'ai: ["complete"]' });
  });

  it("snapshots without ids", async () => {
    const tree = await render(<Stat label="Runs" value={3} onSelect={() => {}} />);
    expect(tree.toJSON()).toEqual([{ type: "Stat", props: { label: "Runs", value: 3, onSelect: "ƒ" }, children: [] }]);
  });
});

describe("cmd.env.has (1.2: elements too)", () => {
  const probe = (names: string[]) => () => <Text>{names.map((n) => `${n}:${cmd.env.has(n)}`).join(" ")}</Text>;
  const names = ["agents.start", "ListRow", "DataGrid", "TimeBars", "Nothing"];

  it("answers for verbs and for the elements this cmd lists", async () => {
    const tree = await render(probe(names), createHost());
    expect(tree.text()).toBe("agents.start:true ListRow:true DataGrid:true TimeBars:true Nothing:false");
  });

  it("on a cmd before 1.2, which lists no elements, answers by its minor", async () => {
    const tree = await render(probe(names), createHost({ env: { api: { major: 1, minor: 1 }, elements: undefined } }));
    expect(tree.text()).toBe("agents.start:true ListRow:true DataGrid:false TimeBars:false Nothing:false");
  });
});

describe("API 1.2's verbs in the fake host", () => {
  it("answers cmd.env.has for them, and an older cmd's list doesn't have them", async () => {
    const probe = () => <Text>{["actions.stop", "clipboard.write", "terminals.usage"].map((n) => `${n}:${cmd.env.has(n)}`).join(" ")}</Text>;
    expect((await render(probe, createHost())).text()).toBe("actions.stop:true clipboard.write:true terminals.usage:true");
    const older = createHost({ env: { api: { major: 1, minor: 1 }, verbs: ["agents.start", "actions.run"], elements: undefined } });
    expect((await render(probe, older)).text()).toBe("actions.stop:false clipboard.write:false terminals.usage:false");
  });

  it("serves the reads from fixtures and useTerminalUsage live", async () => {
    function Usage() {
      const usage = useTerminalUsage();
      return <Text>{usage.map((u) => `${u.id} ${u.cpu}%`).join(", ") || "none"}</Text>;
    }
    const host = createHost({ terminalUsage: [fixtures.usage({ cpu: 3 })], journal: [fixtures.day({ headline: "Shipped" })], playing: fixtures.playing({ title: "Blue" }) });
    const tree = await render(<Usage />, host);
    expect(tree.text()).toBe("t-zsh 3%");
    host.set({ terminalUsage: [fixtures.usage({ cpu: 80 }), fixtures.usage({ id: "t-other", workspaceId: "ws-2" })] });
    await tree.idle();
    expect(tree.text()).toBe("t-zsh 80%"); // the other workspace's isn't this widget's
    expect((await cmd.events.classes()).map((c) => c.class)).toContain("agents");
    expect(await cmd.stats.query({ stat: "agents.time", compare: true })).toMatchObject({ stat: { id: "agents.time" }, total: 28, previous: { total: 14 } });
    expect((await cmd.journal.days())[0]!.headline).toBe("Shipped");
    expect((await cmd.media.get())?.title).toBe("Blue");
  });

  it("records the acts: stop, control, clipboard", async () => {
    const host = createHost({ actions: [{ name: "dev", title: "vite", risky: false }] });
    await render(() => null, host);
    await cmd.actions.stop("dev");
    await cmd.actions.run("dev", { restart: true });
    await cmd.media.control("toggle");
    await cmd.clipboard.write("pnpm dev");
    expect(host.calls).toEqual([["actions.stop", "dev"], ["actions.run", "dev", { restart: true }], ["media.control", "toggle"], ["clipboard.write", "pnpm dev"]]);
    await expect(cmd.actions.stop("nope")).rejects.toThrow(/No action nope/);
  });
});

describe("API 1.3's data in the fake host", () => {
  it("serves useStat, useJournal, useWorkspaces and useAppUsage live, and journal.week", async () => {
    function Data() {
      const runs = useStat({ stat: "commands.runs" });
      const days = useJournal({ count: 2 });
      const spaces = useWorkspaces();
      const app = useAppUsage();
      return <Text>{[runs?.total ?? "-", days.map((d) => `${d.headline} (${d.entries[0]?.project})`).join("; "), spaces.map((w) => w.name).join("+"), app?.app?.cpu ?? "-"].join(" | ")}</Text>;
    }
    const host = createHost({ journal: [fixtures.day({ headline: "Shipped" })], workspaces: [{ id: "ws-1", name: "app" }, { id: "ws-2", name: "docs" }], appUsage: fixtures.appUsage() });
    const tree = await render(<Data />, host);
    expect(tree.text()).toBe("28 | Shipped (app) | app+docs | 3.2");
    host.set({ stats: { "commands.runs": fixtures.stat({ stat: "commands.runs" }, { values: [1, 1] }) }, journal: [fixtures.day({ headline: "Again" })], workspaces: [{ id: "ws-1", name: "app" }], appUsage: fixtures.appUsage({ app: { cpu: 40, memory: 1 } }) });
    await tree.idle();
    expect(tree.text()).toBe("2 | Again (app) | app | 40");
    expect(await cmd.journal.week()).toBeNull();
    host.set({ week: fixtures.week({ headline: "A good week" }) });
    expect((await cmd.journal.week())?.themes).toHaveLength(2);
  });

  it("records agents.select and reruns only a command the log has, in an open terminal at a prompt", async () => {
    const host = createHost({
      terminals: [fixtures.pane({ id: "t-zsh" })],
      events: [fixtures.command({ key: "command:1", terminalId: "t-zsh", exitCode: 0 }), fixtures.command({ key: "command:2", terminalId: "t-gone", exitCode: 1 })],
    });
    await render(() => null, host);
    await cmd.agents.select("a-tours");
    expect(await cmd.terminals.rerun("command:1")).toEqual({ terminalId: "t-zsh" });
    expect(host.calls).toEqual([["agents.select", "a-tours"], ["terminals.rerun", "command:1"]]);
    await expect(cmd.terminals.rerun("command:2")).rejects.toThrow(/terminal is closed/);
    await expect(cmd.terminals.rerun("nope")).rejects.toThrow(/no command under that key/);
    host.emit(fixtures.command({ key: "command:3", terminalId: "t-zsh" }));
    await expect(cmd.terminals.rerun("command:1")).rejects.toThrow(/isn't at a prompt/);
  });
});
