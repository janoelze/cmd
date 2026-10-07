// Kai's past agent sessions: three weeks of ordinary work on atlas (the app),
// atlas-site (its landing page), notes, and one or two on the interview
// fizzbuzz. Written as short real-looking exchanges so search hits and their
// snippets read like a person's history, not test data. persona.ts writes them
// as Claude Code transcripts (Recent, sidebar search, the palette's ?search).

export interface PastSession {
  title: string;
  /** Under Kai's home. */
  folder: string;
  hoursAgo: number;
  branch?: string;
  /** Alternating: Kai, the agent, Kai, … */
  turns: string[];
}

export const SESSIONS: PastSession[] = [
  {
    title: "Why is the date picker off by one on iOS",
    folder: "src/atlas",
    hoursAgo: 3,
    branch: "fix/date-picker-ios",
    turns: [
      "the date picker shows the wrong day on iOS Safari, find out why",
      "It's the time zone: `new Date('2026-05-12')` parses as UTC midnight, and Safari renders it in local time, which is the 11th in the Americas. I changed `parseDay` to build the date from its parts, so it stays the 12th everywhere, and added a test that runs with TZ=America/Los_Angeles.",
      "does Chrome do the same?",
      "Yes, the parsing is the same everywhere; Chrome's picker just hides it on desktop. The fix covers both.",
    ],
  },
  {
    title: "Share trips with a link",
    folder: "src/atlas",
    hoursAgo: 26,
    turns: [
      "add a share link for a trip, read-only for people who aren't in it",
      "Added `POST /api/trips/:id/share`, which returns a link with a random token, and a read-only trip view for it: no edit buttons, no comments box. Tokens can be revoked from the trip's menu. Tests cover the link working, revoking it, and members still being able to edit.",
    ],
  },
  {
    title: "Dark mode for the trip page",
    folder: "src/atlas",
    hoursAgo: 20,
    turns: [
      "follow the system's dark mode on the trip page",
      "The page now uses `color-scheme: light dark` and the palette moved to CSS variables with a dark set under `prefers-color-scheme`. The map tiles switch to the dark style too. I checked contrast on the stop cards: 7.2:1.",
    ],
  },
  {
    title: "Offline mode for the itinerary",
    folder: "src/atlas",
    hoursAgo: 52,
    turns: [
      "people lose signal on trains. can the itinerary work offline?",
      "Added a service worker that caches the trip page and its data when you open it, and a small 'offline: showing the version from 10:42' banner. Edits made offline queue up and sync when the connection is back; conflicts keep both versions and ask.",
      "keep the queue under 50 edits",
      "Done: past 50 the oldest ones are merged into one.",
    ],
  },
  {
    title: "Flaky test in trips.test.ts",
    folder: "src/atlas",
    hoursAgo: 71,
    turns: [
      "trips.test.ts fails about one run in ten on CI",
      "The 'sorts by start date' test depends on `Date.now()` and two trips created in the same millisecond. I pinned the clock with `vi.useFakeTimers()` and gave the fixtures explicit dates. 200 runs in a row pass now.",
    ],
  },
  {
    title: "Map clusters for busy cities",
    folder: "src/atlas",
    hoursAgo: 95,
    turns: [
      "the map is unreadable when a trip has 30 stops in Lisbon",
      "Stops closer than 40 px now cluster into a numbered bubble; clicking it zooms in until they separate. Clustering runs on zoom end, not on every frame, so panning stays smooth.",
    ],
  },
  {
    title: "Split costs between travellers",
    folder: "src/atlas",
    hoursAgo: 120,
    branch: "costs",
    turns: [
      "let people add costs to a trip and split them",
      "Each cost has a payer and who it's for (everyone by default). The trip page shows who owes whom, settled in the fewest transfers. Amounts are stored in cents with their currency; the summary converts at the day's rate and says so.",
      "round to whole euros in the summary",
      "Done. The detail view keeps the cents.",
    ],
  },
  {
    title: "Speed up the trip page",
    folder: "src/atlas",
    hoursAgo: 140,
    turns: [
      "the trip page takes 3 seconds to show anything on a slow phone",
      "Most of it was the map library loading before anything rendered. The itinerary now renders first and the map loads after it, lazily. Largest contentful paint on a throttled Moto G went from 3.1 s to 1.2 s.",
    ],
  },
  {
    title: "Translations: German and Portuguese",
    folder: "src/atlas",
    hoursAgo: 160,
    turns: [
      "add German and Portuguese",
      "Strings moved to `src/i18n/*.json` with ICU plurals ('1 night', '3 nights'), dates and money go through `Intl`. German labels are about 30% longer, so the stop card's buttons wrap now instead of overflowing.",
    ],
  },
  {
    title: "Invite people by email",
    folder: "src/atlas",
    hoursAgo: 190,
    turns: [
      "invite someone to a trip by email",
      "The invite sends a one-time link that expires after 7 days; accepting it adds them as an editor. If they already have an account they land straight in the trip. Rate-limited to 20 invites a day per trip.",
    ],
  },
  {
    title: "Drag stops to reorder",
    folder: "src/atlas",
    hoursAgo: 215,
    turns: [
      "let me drag stops to change their order",
      "Stops are draggable (and movable with ⌥↑/⌥↓ for keyboards); dates shift to follow the new order. The move is one undo step.",
    ],
  },
  {
    title: "Accessibility pass on the stop cards",
    folder: "src/atlas",
    hoursAgo: 240,
    turns: [
      "check the stop cards with VoiceOver",
      "Each card is now a list item with its city as the name and 'Lisbon, 3 nights, 12–15 May' as its description; the menu button had no label, it says 'Stop options' now. Focus moves to the next card after deleting one.",
    ],
  },
  {
    title: "Weather on each stop",
    folder: "src/atlas",
    hoursAgo: 265,
    turns: [
      "show the forecast on each stop if it's within 10 days",
      "Each stop card shows the forecast for its dates from Open-Meteo, cached for 3 hours. Beyond 10 days it shows nothing rather than a guess.",
    ],
  },
  {
    title: "Export a trip to calendar",
    folder: "src/atlas",
    hoursAgo: 290,
    turns: [
      "export the trip to my calendar",
      "Added 'Add to calendar', which downloads an .ics with one all-day event per stop and the address in the location. Subscribing to a live calendar URL is the next step if you want edits to show up.",
    ],
  },
  {
    title: "Pricing page copy",
    folder: "src/atlas-site",
    hoursAgo: 30,
    turns: [
      "rewrite the pricing page, it reads like a contract",
      "Three plans, one line each: Free for one trip at a time, Plus for unlimited trips and costs, Group for shared billing. The FAQ answers the four questions support gets most. I cut it from 640 words to 210.",
    ],
  },
  {
    title: "Landing page hero video",
    folder: "src/atlas-site",
    hoursAgo: 75,
    turns: [
      "the hero video is 18 MB, make it lighter",
      "Re-encoded as AV1 with an H.264 fallback, 1600 px wide, with a poster frame: 2.4 MB and 5.1 MB. It only starts when it's on screen and respects reduced motion.",
    ],
  },
  {
    title: "Fix the broken og:image",
    folder: "src/atlas-site",
    hoursAgo: 150,
    turns: [
      "links to atlas show no preview image",
      "The og:image path was relative, which most crawlers don't resolve. It's an absolute URL now, 1200×630, and there's a twitter:card tag too. Checked with the LinkedIn and Slack preview tools.",
    ],
  },
  {
    title: "Changelog for 1.4",
    folder: "src/atlas-site",
    hoursAgo: 200,
    turns: [
      "write the changelog for 1.4 from the merged PRs",
      "Four headlines (offline itineraries, costs, German and Portuguese, faster trip page) and a short list of fixes. I left out the two internal refactors.",
    ],
  },
  {
    title: "FizzBuzz, but clean",
    folder: "src/fizzbuzz",
    hoursAgo: 30,
    turns: [
      "make this fizzbuzz something I'd be happy to explain in an interview",
      "It's one loop with the 15 case first, `n` comes from the command line, and there's a test for 1–15. Honestly it was fine before; the main change is that it now says what it does.",
      "what would they ask next",
      "Usually: make the rules configurable (7 → 'Bazz'), then 'what if there are 100 rules'. A list of [divisor, word] pairs answers both.",
    ],
  },
  {
    title: "Weekly notes cleanup",
    folder: "notes",
    hoursAgo: 100,
    turns: [
      "tidy up notes, merge the three standup files",
      "Merged into standup.md with the newest week first, and moved the trip ideas into their own file. Nothing deleted.",
    ],
  },
  {
    title: "Rename Trip to Journey?",
    folder: "src/atlas",
    hoursAgo: 330,
    turns: [
      "how big would renaming Trip to Journey be",
      "About 140 places: types, API routes, database columns, translations and the URL. The URL is the costly part, since shared links would break; I'd keep /trips/ as a redirect. I didn't change anything.",
      "let's not",
      "Agreed.",
    ],
  },
  {
    title: "Database backups",
    folder: "src/atlas",
    hoursAgo: 360,
    turns: [
      "are we backing up the database?",
      "Nightly dumps go to the bucket, but nothing had ever restored one. I added a weekly job that restores the latest dump into a scratch database and checks the row counts, and an alert if it fails.",
    ],
  },
  {
    title: "Upgrade to Vite 7",
    folder: "src/atlas",
    hoursAgo: 400,
    turns: [
      "upgrade vite",
      "Upgraded to Vite 7. Two plugins needed new versions and the env prefix changed for one variable. Build time went from 14 s to 9 s.",
    ],
  },
];
