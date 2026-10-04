Request: show my vpn connection status
Notes: `ifconfig` showed utun4 with an IPv4 address (the other utun interfaces only have IPv6 link-local addresses), `netstat -rn -f inet` showed 10.8.0.0/24 routed through utun4, and `scutil --nc list` showed one WireGuard service, "Home". data.ts reads all three, so it stays right when another VPN connects.
