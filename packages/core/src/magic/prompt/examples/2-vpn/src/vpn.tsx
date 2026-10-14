// Whether traffic leaves through the VPN, as the internet sees it (ipinfo.io): the exit's
// address, network and place. Through the person's own provider (a config field) it isn't.

import { Window, View, Stack, Inline, StatusDot, Text, List, ListRow, ListRowContent, ListRowEnd, useConfig, useData, cmd } from "@cmd/widget-api";

interface Exit {
  ip: string;
  org: string;
  city: string;
  country: string;
}

async function exit(): Promise<Exit> {
  const r = await cmd.net.fetch("https://ipinfo.io/json");
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body) as Partial<Exit>;
  return { ip: j.ip ?? "–", org: j.org ?? "–", city: j.city ?? "", country: j.country ?? "" };
}

/** "AS9009 M247 Europe SRL" → "M247 Europe SRL". */
const network = (org: string) => org.replace(/^AS\d+\s+/, "");

export default function Vpn() {
  const provider = useConfig<{ provider: string }>().provider || "";
  const { data, error } = useData(exit, { every: 60 });
  const through = !!data && !!provider && !network(data.org).toLowerCase().includes(provider.toLowerCase());
  const place = data ? [data.city, data.country].filter(Boolean).join(", ") : "";
  const status = error ? `Stale · ${error.message}` : data ? (through ? `Through ${network(data.org)}` : "Not through the VPN") : null;
  const state = data ? null : error ? { kind: "error" as const, icon: "lock.shield", title: "Can't tell", text: error.message } : { kind: "loading" as const, title: "Looking…" };

  return (
    <Window status={status}>
      <View state={state}>
        {data && (
          <>
            <Stack pad="inset" gap={1}>
              <Inline>
                <StatusDot state={through ? "success" : "warning"} label={through ? "Connected" : "Not connected"} />
                <Text strong>{through ? "Traffic goes through the VPN" : `Traffic leaves through ${provider || "your provider"}`}</Text>
              </Inline>
              <Text tone="dim" size="sm">
                What the internet sees now
              </Text>
            </Stack>
            <List>
              <ListRow>
                <ListRowContent title="Address" />
                <ListRowEnd>
                  <Text mono select>
                    {data.ip}
                  </Text>
                </ListRowEnd>
              </ListRow>
              <ListRow>
                <ListRowContent title="Network" />
                <ListRowEnd>
                  <Text truncate>{network(data.org)}</Text>
                </ListRowEnd>
              </ListRow>
              <ListRow>
                <ListRowContent title="Place" />
                <ListRowEnd>
                  <Text>{place || "–"}</Text>
                </ListRowEnd>
              </ListRow>
            </List>
          </>
        )}
      </View>
    </Window>
  );
}
