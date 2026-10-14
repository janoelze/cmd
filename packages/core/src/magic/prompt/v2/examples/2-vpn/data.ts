import { s, run, type Infer } from "cmd";

export const schema = s.object({
  connected: s.boolean(),
  tunnels: s.array(s.object({ name: s.string(), address: s.string(), routes: s.array(s.string()) })),
  services: s.array(s.object({ name: s.string(), state: s.string(), type: s.string() })),
});
export type Data = Infer<typeof schema>;

export default async function data(): Promise<Data> {
  const [ifc, routes, nc] = await Promise.all([run("ifconfig"), run("netstat", ["-rn", "-f", "inet"]), run("scutil", ["--nc", "list"], { allowFail: true })]);

  // Tunnel interfaces with an IPv4 address (macOS's own utuns only have IPv6 link-local ones).
  const tunnels: Data["tunnels"] = [];
  for (const block of ifc.stdout.split(/\n(?=\S)/)) {
    const name = /^([\w]+):/.exec(block)?.[1];
    const addr = /\binet (\d+\.\d+\.\d+\.\d+)/.exec(block)?.[1];
    if (name && addr && /^(utun|wg|ipsec|ppp|tun)\d*/.test(name)) tunnels.push({ name, address: addr, routes: [] });
  }
  for (const line of routes.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const t = tunnels.find((x) => x.name === cols[3]);
    if (t && cols[0] && t.routes.length < 8) t.routes.push(cols[0]);
  }

  // Services configured in System Settings: * (Connected) … "Name" [Type]
  const services = nc.stdout
    .split("\n")
    .map((l) => /\((\w[\w ]*)\).*?"([^"]+)"\s*\[([^\]]*)\]/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ state: m[1]!, name: m[2]!, type: m[3]!.split("/").pop() ?? "" }));

  return { connected: tunnels.length > 0 || services.some((x) => x.state === "Connected"), tunnels, services };
}
