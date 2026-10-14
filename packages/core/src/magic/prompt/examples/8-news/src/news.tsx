// The latest headlines about a topic (Google News' RSS search), newest first; a click opens
// the story beside the widget.

import { Window, View, List, ListRow, ListRowContent, ListRowEnd, Chip, useConfig, useData, useNow, cmd, fmt } from "@cmd/widget-api";

export interface Story {
  title: string;
  source: string;
  link: string;
  at: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ""), e[1]?.toLowerCase() === "x" ? 16 : 10)) : (ENTITIES[e] ?? m)))
    .trim();
const tag = (xml: string, name: string) => decode(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? "");

/** An RSS feed's items (no DOMParser in a widget: a few regular expressions do). */
export function parse(xml: string): Story[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item = ""]) => {
      const source = tag(item, "source");
      // Google News appends " - Source" to each title.
      const title = tag(item, "title").replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
      return { title, source, link: tag(item, "link"), at: Date.parse(tag(item, "pubDate")) || 0 };
    })
    .filter((s) => s.title && s.link)
    .sort((a, b) => b.at - a.at);
}

export default function News() {
  const query = useConfig<{ query: string }>().query || "Berlin";
  const { data, error } = useData(async () => {
    const r = await cmd.net.fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return parse(r.body).slice(0, 40);
  }, { every: 600 });
  const now = useNow(60_000);
  const status = error ? `Stale · ${error.message}` : data ? `${data.length} stories` : null;
  const state = data ? (data.length ? null : { icon: "newspaper", title: "No news", text: `Nothing about ${query} right now.` }) : error ? { kind: "error" as const, icon: "newspaper", title: "No news", text: error.message } : { kind: "loading" as const, title: "Reading the news…" };

  return (
    <Window status={status}>
      <View state={state}>
        <List>
          {(data ?? []).map((s) => (
            <ListRow key={s.link} onClick={() => void cmd.windows.open(s.link).catch(() => {})}>
              <ListRowContent title={s.title} detail={s.source} />
              <ListRowEnd>
                <Chip>{fmt.ago(s.at, now)}</Chip>
              </ListRowEnd>
            </ListRow>
          ))}
        </List>
      </View>
    </Window>
  );
}
