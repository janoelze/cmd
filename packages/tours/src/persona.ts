// Kai: the person the tour videos are about. A developer on an ordinary day:
// a trip-planning web app (atlas) as the main work, notes, a few past agent
// sessions in Recent, and, as a small nod, a fizzbuzz repo for Thursday's
// interview. Written into a fixture's home: real git repos with a history by
// Kai, a prompt that says kai@kai-mbp, three weeks of past agent sessions
// (sessions.ts) for Recent and search. Keep it light:
// the app is the star, Kai's day just gives it something real to work on.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Fixture } from "./fixture.ts";
import { SESSIONS } from "./sessions.ts";

export const KAI = { name: "Kai Moreno", user: "kai", host: "kai-mbp", email: "kai@example.com" };

type Files = Record<string, string>;

const ATLAS: Files = {
  "README.md": "# Atlas\n\nPlan a trip with friends: one itinerary, everyone's ideas, no group chat archaeology.\n\n```sh\nnpm install\nnpm run dev     # http://localhost:5173\nnpm test\n```\n\n## Layout\n\n- `src/` the app (Vite + TypeScript)\n- `src/api/` the tiny API\n- `test/` vitest\n",
  "package.json": JSON.stringify({ name: "atlas", private: true, type: "module", scripts: { dev: "vite", build: "vite build", test: "vitest" } }, null, 2) + "\n",
  "index.html": '<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Atlas</title></head>\n  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>\n</html>\n',
  "src/main.ts": 'import { renderTrip } from "./trip.ts";\n\nrenderTrip(document.querySelector("#app")!);\n',
  "src/trip.ts": "export interface Stop {\n  city: string;\n  nights: number;\n}\n\nexport const nights = (stops: Stop[]) => stops.reduce((n, s) => n + s.nights, 0);\n\nexport function renderTrip(el: Element) {\n  el.textContent = \"Lisbon → Porto → Madrid\";\n}\n",
  "src/api/trips.ts": "export async function listTrips() {\n  return [{ id: 1, name: \"Iberia in May\" }];\n}\n",
  "src/styles.css": ":root { color-scheme: light dark; font: 16px system-ui; }\n",
  "CLAUDE.md": "# Atlas\n\n- TypeScript, Vite, vitest. Keep functions small; a test with every change.\n- In commands and messages, use paths relative to the repo root.\n",
  "test/trip.test.ts": 'import { expect, it } from "vitest";\nimport { nights } from "../src/trip.ts";\n\nit("adds up the nights", () => {\n  expect(nights([{ city: "Lisbon", nights: 3 }, { city: "Porto", nights: 2 }])).toBe(5);\n});\n',
};

const FIZZBUZZ: Files = {
  "README.md": "# fizzbuzz\n\nFor Thursday's interview. Probably overprepared.\n",
  "fizzbuzz.ts": "const n = Number(process.argv[2] ?? 100);\nfor (let i = 1; i <= n; i++) console.log(i % 15 === 0 ? \"FizzBuzz\" : i % 3 === 0 ? \"Fizz\" : i % 5 === 0 ? \"Buzz\" : String(i));\n",
};

const SITE: Files = {
  "README.md": "# atlas-site\n\nThe landing page for Atlas. `npm run dev`, deployed on merge.\n",
  "index.html": '<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Atlas: plan a trip together</title></head>\n  <body><h1>Plan a trip together</h1></body>\n</html>\n',
  "pricing.html": "<!doctype html>\n<title>Atlas pricing</title>\n<h1>Free, Plus, Group</h1>\n",
  "changelog.md": "# Changelog\n\n## 1.4\n\n- Offline itineraries\n- Split costs\n- German and Portuguese\n- A faster trip page\n",
  "styles.css": "body { font: 18px/1.5 system-ui; }\n",
};

const NOTES: Files = {
  "standup.md": "# Standup\n\n## Yesterday\n\n- Trip sharing links\n\n## Today\n\n- Fix the date picker on mobile\n- Review Leo's PR\n",
  "todo.md": "- [x] Book Lisbon flights\n- [ ] Date picker on mobile\n- [ ] Prep for Thursday (fizzbuzz, obviously)\n",
};

/** Commits as Kai, days ago (fixed hours, so the history reads the same every run). */
const HISTORY: Record<string, [number, string][]> = {
  "src/atlas": [
    [9, "Scaffold Atlas: Vite + TypeScript"],
    [6, "Trips API: list trips"],
    [4, "Count nights per trip"],
    [2, "Share a trip with a link"],
    [1, "Styles: follow the system's dark mode"],
  ],
  "src/atlas-site": [
    [8, "Landing page"],
    [6, "Pricing: three plans"],
    [3, "Changelog for 1.4"],
  ],
  "src/fizzbuzz": [
    [3, "fizzbuzz"],
    [1, "Take n from the command line"],
  ],
};

/** A UUID-shaped id from a name, the same every run. */
function uuidFor(name: string): string {
  const h = createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function write(root: string, files: Files) {
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** A repo whose history is Kai's: each commit adds the files in turn, the last one the rest. */
function repo(dir: string, files: Files, history: [number, string][]) {
  write(dir, files);
  const env = { ...process.env, GIT_AUTHOR_NAME: KAI.name, GIT_AUTHOR_EMAIL: KAI.email, GIT_COMMITTER_NAME: KAI.name, GIT_COMMITTER_EMAIL: KAI.email };
  const git = (args: string[], date?: string) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env });
  git(["init", "-q", "-b", "main"]);
  const names = Object.keys(files);
  const per = Math.max(1, Math.ceil(names.length / history.length));
  history.forEach(([daysAgo, message], i) => {
    const batch = i === history.length - 1 ? names.slice(i * per) : names.slice(i * per, (i + 1) * per);
    if (batch.length) git(["add", ...batch]);
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    d.setHours(10 + i, 12 + i * 7, 0, 0);
    git(["commit", "-q", "--allow-empty", "-m", message], d.toISOString());
  });
}

/** Writes Kai into a fixture: prompt, repos, notes, past sessions. */
export function applyKai(f: Fixture) {
  fs.writeFileSync(path.join(f.home, ".zshrc"), `PROMPT='%F{green}${KAI.user}@${KAI.host}%f %F{blue}%~%f %F{magenta}❯%f '\nunsetopt PROMPT_SP\n`);
  fs.writeFileSync(path.join(f.home, ".gitconfig"), `[user]\n\tname = ${KAI.name}\n\temail = ${KAI.email}\n[init]\n\tdefaultBranch = main\n`);
  repo(path.join(f.home, "src/atlas"), ATLAS, HISTORY["src/atlas"]!);
  repo(path.join(f.home, "src/fizzbuzz"), FIZZBUZZ, HISTORY["src/fizzbuzz"]!);
  repo(path.join(f.home, "src/atlas-site"), SITE, HISTORY["src/atlas-site"]!);
  write(path.join(f.home, "notes"), NOTES);

  const projects = path.join(f.transcripts, ".claude", "projects");
  SESSIONS.forEach((ses, i) => {
    const cwd = path.join(f.home, ses.folder);
    const dir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    // A real-looking session id (a UUID, stable per session): "kai-session-04" in a tooltip gives the fixture away.
    const id = uuidFor(`kai-${i}-${ses.title}`);
    const started = Date.now() - ses.hoursAgo * 3_600_000;
    // Turns a few minutes apart, as a conversation goes.
    const at = (n: number) => new Date(started + n * 4 * 60_000).toISOString();
    const lines: object[] = ses.turns.map((text, n) =>
      n % 2 === 0
        ? { type: "user", sessionId: id, cwd, gitBranch: ses.branch ?? "main", timestamp: at(n), message: { role: "user", content: text } }
        : { type: "assistant", sessionId: id, cwd, timestamp: at(n), message: { role: "assistant", content: [{ type: "text", text }] } },
    );
    lines.push({ type: "ai-title", aiTitle: ses.title });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    const last = new Date(started + (ses.turns.length - 1) * 4 * 60_000);
    fs.utimesSync(file, last, last);
  });
}
