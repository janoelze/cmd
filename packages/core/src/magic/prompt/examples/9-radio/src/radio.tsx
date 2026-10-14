// Bassdrive's widget process: the player itself is view.html, drawn in a frame (it needs
// an audio element and a meter); this only names the station in the title bar.

import { Window } from "@cmd/widget-api";

export default function Radio() {
  return <Window status="24/7 drum & bass" />;
}
