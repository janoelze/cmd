// How devices reach this Mac (docs/38-direct-remote-access.md): a transport
// carries each device's channel as opaque bytes (Noise, end to end) and says
// where a pairing link should send the device. RelayLink is one; RemoteService
// runs exactly one at a time and treats them alike.

import type { EventEmitter } from "node:events";

export type TransportState = "connecting" | "online" | "error";

export interface TransportEvents {
  state: [TransportState, string | null];
  /** user: who the proxy says it is (Tailscale-User-Login), a display hint only. */
  open: [channel: number, ip: string, user?: string | null];
  data: [channel: number, bytes: Uint8Array<ArrayBuffer>];
  close: [channel: number];
}

/** Where a pairing link sends a device: its WebSocket base (dialled as `<socket>/r/<route>`) and the web client's origin. */
export interface Endpoint {
  socket: string;
  client: string;
}

export interface Transport extends EventEmitter<TransportEvents> {
  readonly state: TransportState;
  readonly error: string | null;
  /** This host's mailbox, once it has one. */
  readonly route: string | null;
  /** Null until the transport knows its public addresses. */
  endpoint(): Endpoint | null;
  start(): void;
  send(channel: number, payload: Uint8Array): void;
  closeChannel(channel: number): void;
  close(): void;
}
