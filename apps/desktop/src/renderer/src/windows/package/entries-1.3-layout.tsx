// API 1.3's layout element that translates (protocol widget-elements-1.3-layout.ts; Case, and
// Stack's `justify` and Text's `fit`, are the kit's as they are, elements.tsx's KIT):
// - Adapt: its Case nodes become the kit's Cases (their conditions, their drawn node inside),
//   and the kit's Adapt measures its own box and mounts the first that fits. The switch is all
//   here: a resize never reaches the widget's process, and the cases not drawn aren't mounted.

import { Adapt, Case } from "@cmd/ui";
import type { ApiElement } from "@cmd/protocol";
import type { ComponentType, ReactNode } from "react";
import { v, type Drawn } from "./draw.ts";

function AdaptEntry({ node, children }: Drawn) {
  const drawn = (Array.isArray(children) ? children : [children]) as ReactNode[];
  const cases = node.children.flatMap((c, i) =>
    c.type === "Case" && !c.props.$hidden
      ? [
          <Case key={c.id} minWidth={v<number>(c.props.minWidth)} maxWidth={v<number>(c.props.maxWidth)} minHeight={v<number>(c.props.minHeight)} maxHeight={v<number>(c.props.maxHeight)}>
            {drawn[i]}
          </Case>,
        ]
      : [],
  );
  return <Adapt>{cases}</Adapt>;
}

/** The 1.3 layout elements that translate, and what draws each. */
export type Translated13Layout = "Adapt";
export const ENTRIES_1_3_LAYOUT: { readonly [K in Translated13Layout & ApiElement]: ComponentType<Drawn> } = {
  Adapt: AdaptEntry,
};
