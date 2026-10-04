import { s, fetchText, xmlItems, type Infer } from "cmd";

export const schema = s.object({
  stories: s.array(s.object({ title: s.string(), source: s.string(), link: s.string(), at: s.number() })),
});
export type Data = Infer<typeof schema>;

export default async function data(config: { query: string }): Promise<Data> {
  const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(config.query + " when:1d")}&hl=en-US&gl=US&ceid=US:en`);
  const stories = xmlItems(xml, "item")
    .map((it) => {
      const source = it.source ?? "";
      const title = (it.title ?? "").replace(source ? ` - ${source}` : /$^/, "");
      return { title, source, link: it.link ?? "", at: Date.parse(it.pubDate ?? "") || 0 };
    })
    .filter((x) => x.title && x.link)
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);
  return { stories };
}
