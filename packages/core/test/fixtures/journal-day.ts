// A made-up, messy work day as journal events, for what the real data doesn't
// have yet: terminals, pages read, notes, an investigation, research without
// commits, an unfinished branch, a second project, noise (a "hi" session in a
// temp folder, a music video, a weather question). Times are local, on `day`.
import type { NewJournalEvent } from "../../src/journal/store.ts";
import type { JournalData } from "@cmd/protocol";

const H = "/Users/sam";
const SHOP = `${H}/src/shopfront`;
const DOTS = `${H}/src/dotfiles`;

export function syntheticDay(day: string): NewJournalEvent[] {
  const t = (hm: string) => new Date(`${day}T${hm}:00`).getTime();
  const out: NewJournalEvent[] = [];
  let n = 0;
  const ev = (at: string, until: string | null, data: JournalData, text: string, o: { repo?: string | null; cwd?: string | null; thread?: string | null } = {}) =>
    out.push({ at: t(at), until: until ? t(until) : null, kind: data.kind, key: `syn:${n++}`, spaceId: o.repo === DOTS || o.cwd?.startsWith(DOTS) ? null : "shop", repo: o.repo === undefined ? SHOP : o.repo, cwd: o.cwd === undefined ? SHOP : o.cwd, thread: o.thread ?? null, text, data, source: "backfill" });
  const cmd = (at: string, until: string, command: string, exitCode: number | null, pane = "p1", cwd = SHOP) =>
    ev(at, until, { kind: "command", command, exitCode, paneId: pane }, command, { cwd, repo: cwd.startsWith(SHOP) ? SHOP : cwd.startsWith(DOTS) ? DOTS : null, thread: `pane:${pane}` });
  const page = (at: string, title: string, url: string, win = "w1") => ev(at, null, { kind: "browser.visit", url, title, windowId: win }, title, { cwd: null, thread: `window:${win}` });
  const session = (id: string, from: string, to: string, title: string, first: string, cwd = SHOP, repo: string | null = SHOP) =>
    ev(from, to, { kind: "agent.session", agent: "claude", sessionId: id, title, firstPrompt: first, branch: "main" }, title, { cwd, repo, thread: `session:${id}` });
  let turnN = 0;
  const turn = (id: string, from: string, to: string, prompt: string, o: { final?: string; files?: string[]; commands?: string[]; outcome?: string; cwd?: string; repo?: string | null } = {}) =>
    ev(
      from,
      to,
      { kind: "agent.turn", agent: "claude", sessionId: id, agentId: `a-${id}`, prompt, auto: false, followUps: [], final: o.final ?? null, outcome: o.outcome ?? "done", error: null, files: o.files ?? [], commands: o.commands ?? [], tools: 6 },
      prompt.slice(0, 120),
      { cwd: o.cwd ?? SHOP, repo: o.repo === undefined ? SHOP : o.repo, thread: `session:${id}` },
    );
  const commit = (at: string, hash: string, subject: string, branch: string, worktree: string | null) =>
    ev(at, null, { kind: "git.commit", hash, subject, branch, worktree }, subject, { cwd: worktree ?? SHOP, thread: `branch:${SHOP}#${branch}` });
  const FTS = `${H}/src/shopfront-fts-rebuild`;
  const BTN = `${H}/src/shopfront-checkout-btn`;

  // Morning: the dev server, mail and an issue about search.
  cmd("08:52", "08:52", "cd ~/src/shopfront", 0);
  cmd("08:52", "08:53", "git pull", 0);
  cmd("08:53", "09:41", "pnpm dev", 130);
  page("09:01", "Inbox (3) - sam@shopfront.dev - Mail", "https://mail.google.com/mail/u/0/#inbox");
  page("09:04", "Search returns nothing after the app crashed · Issue #412 · shopfront/shopfront", "https://github.com/shopfront/shopfront/issues/412");
  page("09:06", "SqliteError: database disk image is malformed — search-worker · Sentry", "https://shopfront.sentry.io/issues/58122/");
  ev("09:10", null, { kind: "note", by: "user", agentSession: null }, "search broken for lena since yesterdays crash, sentry says malformed db", { thread: null });

  // The investigation: an agent, a terminal poking the database, the docs.
  session("s-fts", "09:12", "10:52", "Search index corruption after crash", "search shows nothing since the app crashed yesterday, sentry attached");
  turn("s-fts", "09:12", "09:19", "search shows nothing since the app crashed yesterday <pasted_content id=\"1\">SqliteError: database disk image is malformed\n    at SearchWorker.query (search/worker.ts:88)</pasted_content> can you look", { final: "The error comes from the FTS5 table `search_fts`, not the main tables: `PRAGMA integrity_check` on a copy reports `malformed inverted index for FTS5 table main.search_fts`. The worker writes the index in batches outside a transaction, so a crash mid-batch leaves it half written.", commands: ["sqlite3 /tmp/shop-copy.db 'PRAGMA integrity_check'", "rg -n 'search_fts' src/search"] });
  cmd("09:15", "09:15", "cp ~/Library/Application\\ Support/Shopfront/shop.db /tmp/shop-broken.db", 0, "p2");
  cmd("09:15", "09:16", "sqlite3 /tmp/shop-broken.db 'PRAGMA integrity_check'", 1, "p2");
  cmd("09:17", "09:17", "ls /tmp", 0, "p2");
  cmd("09:21", "09:21", "sqlite3 /tmp/shop-broken.db \"INSERT INTO search_fts(search_fts) VALUES('rebuild')\"", 0, "p2");
  cmd("09:21", "09:22", "sqlite3 /tmp/shop-broken.db 'PRAGMA integrity_check'", 0, "p2");
  page("09:24", "SQLite FTS5 Extension", "https://www.sqlite.org/fts5.html", "w2");
  page("09:27", "How To Corrupt An SQLite Database File", "https://www.sqlite.org/howtocorrupt.html", "w2");
  page("09:31", "Write-Ahead Logging", "https://www.sqlite.org/wal.html", "w2");
  page("09:33", "fts5 malformed inverted index after power loss - Stack Overflow", "https://stackoverflow.com/questions/7712201", "w2");
  turn("s-fts", "09:26", "09:38", "ok so its the fts table? why would that happen if we use WAL", { final: "WAL protects each transaction, but the worker commits every 50 rows in separate transactions and the FTS5 'merge' runs between them; a crash between leaves segments without their index. Wrapping the batch and the merge in one transaction fixes it; a rebuild repairs existing databases." });
  turn("s-fts", "09:39", "10:24", "lets add a rebuild on open when integrity fails, and wrap the batch in a transaction. worktree pls", { files: [`${FTS}/src/search/worker.ts`, `${FTS}/src/search/open.ts`], commands: [`git worktree add ${FTS} -b fts-rebuild main`, "pnpm vitest run search"], final: "Done in fts-rebuild: one transaction per batch, and `openIndex` runs a quick check and rebuilds the FTS table when it fails (about 2 s on Lena's 80 MB database)." });
  ev("09:40", null, { kind: "git.branch", branch: "fts-rebuild", from: "main", worktree: FTS }, "Created branch fts-rebuild from main", { cwd: FTS, thread: `branch:${SHOP}#fts-rebuild` });
  cmd("10:02", "10:02", "pnpm vitest run search", 1, "p3", FTS);
  cmd("10:05", "10:05", "pnpm vitest run search", 0, "p3", FTS);
  commit("10:20", "a1f3c9e", "Search: rebuild the FTS index when the integrity check fails", "fts-rebuild", FTS);
  turn("s-fts", "10:25", "10:41", "and write a test that simulates a crash mid write", { files: [`${FTS}/test/search-crash.test.ts`], commands: ["pnpm vitest run search-crash"] });
  commit("10:35", "b77e021", "Test: a crash mid-write leaves an index that rebuilds", "fts-rebuild", FTS);
  turn("s-fts", "10:48", "10:52", "lets merge", { final: "Merged fts-rebuild into main (fast-forward), removed the worktree. Not released yet." , commands: ["git merge --ff-only fts-rebuild"] });
  ev("10:50", null, { kind: "git.merge", branch: "fts-rebuild", into: "main", fastForward: true, hash: "b77e021", worktree: SHOP }, "Merged fts-rebuild into main", { thread: `branch:${SHOP}#fts-rebuild` });

  // In parallel: a small UI fix by a second agent.
  session("s-btn", "09:50", "10:32", "Checkout button misaligned on mobile", "the checkout button is misaligned on mobile [Image #1]");
  turn("s-btn", "09:50", "10:01", "the checkout button is misaligned on mobile [Image #1]", { files: [`${BTN}/src/checkout/Summary.tsx`, `${BTN}/src/checkout/summary.css`], commands: [`git worktree add ${BTN} -b checkout-btn main`] });
  turn("s-btn", "10:03", "10:12", "use the kit's Button instead of the custom one", { files: [`${BTN}/src/checkout/Summary.tsx`] });
  commit("10:10", "c0de551", "Checkout: the kit's Button, full width on phones", "checkout-btn", BTN);
  turn("s-btn", "10:29", "10:32", "lets merge", { commands: ["git merge --ff-only checkout-btn"] });
  ev("10:31", null, { kind: "git.merge", branch: "checkout-btn", into: "main", fastForward: true, hash: "c0de551", worktree: SHOP }, "Merged checkout-btn into main", { thread: `branch:${SHOP}#checkout-btn` });

  // Noise.
  session("s-hi", "10:00", "10:00", "", "hi", "/private/tmp/scratch", null);
  turn("s-hi", "10:00", "10:00", "hi", { cwd: "/private/tmp/scratch", repo: null });
  page("10:01", "lofi hip hop radio 📚 beats to relax/study to - YouTube", "https://www.youtube.com/watch?v=jfKfPfyJRdk", "w3");
  session("s-weather", "11:02", "11:03", "Berlin weather", "whats the weather in berlin tomorrow", H, null);
  turn("s-weather", "11:02", "11:03", "whats the weather in berlin tomorrow", { cwd: H, repo: null });

  // After lunch: a release.
  session("s-rel", "13:31", "13:44", "Release 2.3.0", "lets release");
  turn("s-rel", "13:31", "13:44", "lets release", { commands: ["pnpm changeset version", "pnpm release 2.3.0"], files: [`${SHOP}/CHANGELOG.md`, `${SHOP}/package.json`], final: "v2.3.0 is tagged and the deploy finished: the search fix and the checkout button are live." });
  commit("13:36", "d00d2a1", "Changelog for v2.3.0", "main", SHOP);
  commit("13:40", "e11e3b0", "Release v2.3.0", "main", SHOP);
  ev("13:41", null, { kind: "git.tag", tag: "v2.3.0", hash: "e11e3b0" }, "Tagged v2.3.0", { thread: `release:${SHOP}#v2.3.0` });
  cmd("13:45", "13:46", "curl -sI https://shopfront.dev | head -1", 0, "p1");

  // Research without code: payments.
  session("s-pay", "14:02", "16:24", "Stripe Checkout vs Adyen", "I want to explore moving payments to Stripe Checkout");
  turn("s-pay", "14:02", "14:30", "I want to explore moving payments to Stripe Checkout, compare with our current Adyen drop-in setup. fees, 3DS, refunds, what changes for us", { final: "Fees are close for EU cards (1.5% + €0.25 vs Adyen's interchange++), Stripe Checkout handles 3DS2 and wallets without our code, refunds stay API-driven. We'd drop ~600 lines of drop-in glue; the risk is webhooks during the switch." });
  page("14:05", "Stripe Checkout | Stripe Documentation", "https://docs.stripe.com/payments/checkout", "w4");
  page("14:09", "Pricing & Fees | Stripe", "https://stripe.com/pricing", "w4");
  page("14:14", "Drop-in integration | Adyen Docs", "https://docs.adyen.com/online-payments/build-your-integration/sessions-flow", "w4");
  page("14:20", "3D Secure 2 | Stripe Documentation", "https://docs.stripe.com/payments/3d-secure", "w4");
  turn("s-pay", "15:10", "16:15", "write that up as a plan in docs/payments.md, with a migration in phases", { files: [`${SHOP}/docs/payments.md`], final: "docs/payments.md: recommendation (Stripe Checkout), three phases (new customers behind a flag, migrate saved cards, switch off Adyen), open questions for finance." });
  ev("16:16", null, { kind: "file.open", path: `${SHOP}/docs/payments.md`, windowKind: "markdown", windowId: "w5" }, "docs/payments.md", {});
  commit("16:20", "f00ba12", "docs: payments, a plan to move to Stripe Checkout", "main", SHOP);
  ev("16:24", null, { kind: "note", by: "agent", agentSession: "s-pay" }, "Recommended Stripe Checkout; plan in docs/payments.md, finance to confirm fees", {});

  // Late: a flaky test, not solved.
  session("s-flaky", "16:40", "17:35", "Flaky cart e2e on CI", "flaky e2e on CI again, look at the last pipeline");
  turn("s-flaky", "16:40", "17:05", "flaky e2e on CI again, look at the last pipeline", { commands: ["gh run list --limit 5", "gh run view 8812 --log-failed"], final: "cart.spec.ts fails 1 in ~6 runs on CI: the total is read before the price request settles. I couldn't make it fail locally in 40 runs." });
  cmd("16:50", "16:58", "for i in $(seq 40); do pnpm playwright test cart.spec.ts || break; done", 0, "p4");
  turn("s-flaky", "17:08", "17:35", "add a wait for the price and retry once, branch it, dont merge yet", { files: [`${H}/src/shopfront-e2e-retry/e2e/cart.spec.ts`], commands: [`git worktree add ${H}/src/shopfront-e2e-retry -b e2e-retry main`] });
  ev("17:09", null, { kind: "git.branch", branch: "e2e-retry", from: "main", worktree: `${H}/src/shopfront-e2e-retry` }, "Created branch e2e-retry from main", { cwd: `${H}/src/shopfront-e2e-retry`, thread: `branch:${SHOP}#e2e-retry` });
  commit("17:30", "0ddba11", "e2e: wait for the price before reading the cart total", "e2e-retry", `${H}/src/shopfront-e2e-retry`);

  // Evening: the other project.
  cmd("18:10", "18:14", "brew upgrade", 0, "p5", DOTS);
  cmd("18:15", "18:21", "nvim zsh/prompt.zsh", 0, "p5", DOTS);
  cmd("18:21", "18:21", "time zsh -i -c exit", 0, "p5", DOTS);
  ev("18:24", null, { kind: "git.commit", hash: "1234abc", subject: "zsh: lazy-load nvm, prompt in 40 ms", branch: "main", worktree: DOTS }, "zsh: lazy-load nvm, prompt in 40 ms", { repo: DOTS, cwd: DOTS, thread: `branch:${DOTS}#main` });
  return out;
}
