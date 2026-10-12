// DataGrid: a table of values; here without its header row.

import { DataGrid } from "./grid.tsx";

/** No header (headless): the values say what they are; the columns still line up. */
export const Headless = () => (
  <div style={{ width: 420, background: "var(--well)" }}>
    <DataGrid
      headless
      columns={[
        { key: "name", label: "Name", grow: true },
        { key: "lines", label: "Lines", align: "end" },
        { key: "when", label: "Changed", align: "end" },
      ]}
      rows={[
        ["checkout.ts", { node: "+41 −2", kind: "number" }, { node: "38s", kind: "number" }],
        ["server.ts", { node: "+210", kind: "number" }, { node: "50s", kind: "number" }],
        ["CHANGELOG.md", { node: "+4", kind: "number" }, { node: "42m", kind: "number" }],
      ]}
    />
  </div>
);
