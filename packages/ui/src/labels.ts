// Accessible names from a form row: FormRow publishes the ids of its title and
// description, and the kit's controls inside it are labelled and described by
// them unless they are given a label of their own. So a script (or VoiceOver)
// finds Settings' "Code font" field by that name.

import { createContext, useContext } from "react";

export const RowLabels = createContext<{ label: string; desc?: string } | null>(null);

/** The aria attributes for a control: its own label, else its row's title. */
export function useRowLabel(label?: string) {
  const row = useContext(RowLabels);
  return {
    "aria-label": label,
    "aria-labelledby": label ? undefined : row?.label,
    "aria-describedby": row?.desc,
  };
}
