// The news widget's states: two stories about Berlin.

import type { HostData } from "@cmd/widget-api/testing";
import berlin from "../fixtures/berlin.json" with { type: "json" };
import News from "./news.tsx";

export default News;

/** Two stories, the newest first. */
export const Berlin = berlin as HostData;
