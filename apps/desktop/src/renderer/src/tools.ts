// Built-in tools, written in the declarative shape planned for plugins
// (docs/06-plugins-routines-system.md). The plugin host will move these into
// the core; the UI only renders primitives.

export type ToolAction =
  | { kind: "terminal"; command: string; cwd?: string } // visible: sudo prompts work
  | { kind: "agent"; agent: string; prompt?: string };

export type Control =
  | { type: "button"; id: string; label: string; action: ToolAction; hint?: string }
  | { type: "note"; text: string };

export interface Tool {
  id: string;
  title: string;
  icon: string;
  controls: Control[];
}

export const builtinTools: Tool[] = [
  {
    id: "agents",
    title: "Agents",
    icon: "✦",
    controls: [
      { type: "button", id: "claude", label: "New Claude", action: { kind: "agent", agent: "claude" } },
      { type: "button", id: "codex", label: "New Codex", action: { kind: "agent", agent: "codex" } },
      { type: "note", text: "Agents started here get a known session id and appear in Sessions." },
    ],
  },
  {
    id: "vpn-wireguard",
    title: "WireGuard VPN",
    icon: "⛨",
    controls: [
      { type: "button", id: "up", label: "Connect", action: { kind: "terminal", command: "~/src/private-vpn/up.sh" }, hint: "sudo" },
      { type: "button", id: "down", label: "Disconnect", action: { kind: "terminal", command: "~/src/private-vpn/down.sh" }, hint: "sudo" },
      { type: "note", text: "Runs in a visible terminal so the sudo prompt works. Status monitor pending the plugin host." },
    ],
  },
  {
    id: "system",
    title: "System",
    icon: "⚙",
    controls: [
      { type: "button", id: "dns", label: "Flush DNS", action: { kind: "terminal", command: "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder && echo flushed" }, hint: "sudo" },
      { type: "button", id: "ports", label: "Listening ports", action: { kind: "terminal", command: "lsof -nP -iTCP -sTCP:LISTEN" } },
    ],
  },
];
