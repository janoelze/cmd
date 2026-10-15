// Media Controls' states for the UI Workbench (`pnpm workbench widgets/nowplaying`): the widget
// against the fake host, one variant per state, each the host's data. The cover is a small PNG
// (a widget's covers come as data: PNG, JPEG, WebP or GIF), scaled up by its box.

import type { HostData } from "@cmd/widget-api/testing/host";
import { playing } from "@cmd/widget-api/testing/fixtures";
import MediaControls from "./nowplaying.tsx";

export default MediaControls;

/** A dusk in 32 px. */
const COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAADCUlEQVR42rXV908aYRgH8Ofvscvu7d4bnDgAB6IoICjCoYfAgQiaNG3UatRGJSrOaMFobIl71GocxdWa1JUmNtpak46kdtCQXKimcDS55Pn5833v7nm/BwdMr32G9zu6z16K73ay39ukgM3EwA1a0Bot2JIQuhwfthAXPh8bMRsTOR1NmaRSx6jRI5QYc1TcUGT8YERCfzjNGJbYG5rcE5rSGUI3BDNag1L1gWlNAelP/DPq/TOBVL3Wjw2k6tW+WUCqXumTDf+tm6h0YzSzJ4LpQH/ozQFXdXMSfSqPPS/jLmkES9r8eZVwQsIfYOW0hLPO6g+8csElfZrHWtEJtpuQ90b5kRn7NKw+HML2uuWrNdJxNL8rJfeUXuHJBeL6bEHWZo3ocFDxY1n3a7XCfr7Olu10KWbKJJ0Mvr2u9eAB0bNzWZuPRcfDqlO0/ez1YhMqpDGWj+saDz4Q0Z8n0i3avMMBhQPdOj9Xyt+0KEzCQlxX3RcAkZ2Z4rG3GpGTJZ3jAOt8GNFM6oprqUKbrrwnBCIbOYdy9/tKnOp/HsJSvlwn16cW2vSSu/ngVDdGpSyqBR+fYUQCrLPRirVzEJuO3ikAp3e1j8JY0AiPzCqCAa8NWHuu1KZLb4vAaRN0hTFeKgQHA0qCASvNmD5TatPFt8RApGfGRLzdDkLf4Nu8bqZSUU1DbLropgSItFh/GsdShXyeLnMasNdf2i+TqfzFNl14EwEiHakPyRiV5m+1y62b7kA/ntK+qFLWpxbhet4NKRBs4A5azpRavNOtPFku/5e+2IAZ8lDUU4Lr3OvFQLzfDcm8UYVkvVl+YC79bhfzZU63ayqdqVJadSzgL51zDQWX/h4NVN5TfuG4pmihVr6mV663Yq8aselHChMqq0stQj3Fp/SsqzIgruMdWR0paGKI2tiStmykKQOpikcwP7H9e8d11pUScFXHWwy/q/hGntXTL8uBVJ3prgRSdbo7BqTqSZdUQKqecFENpOpxFzRAqh59vgxI1SnntECqHuGmA1L1MLeK39d159+dbWxxAAAAAElFTkSuQmCC";

const TRACK = playing({ app: "com.spotify.client", title: "Interdimensional Life", artist: "ooxygen", album: "Rave Rats Volume 1", duration: 586, elapsed: 132, artwork: COVER });

/** A track playing, with its cover. */
export const Playing: HostData = { media: TRACK };

/** Paused. */
export const Paused: HostData = { media: { ...TRACK, playing: false } };

/** A player that sends no cover: its box with a note. */
export const NoCover: HostData = { media: { ...TRACK, artwork: null } };

/** A long title, in a narrow window, as in a sidebar: it stays at its size and is cut. */
export const Narrow: HostData & { size: "narrow" } = { media: playing({ app: "com.apple.Music", title: "Concerto for Two Violins in D Minor, BWV 1043: II. Largo ma non tanto", artist: "Hilary Hahn, Margaret Batjer, Los Angeles Chamber Orchestra", album: "Bach: Violin Concertos", duration: 412, elapsed: 30, artwork: COVER }), size: "narrow" };

/** A stream without a length or a cover: no scrubber. */
export const Stream: HostData = { media: playing({ app: "com.apple.Safari", title: "Radio Paradise · Main Mix", artist: null, album: null, duration: null, elapsed: null }) };

/** Nothing playing on the Mac. */
export const Nothing: HostData = { media: null };
