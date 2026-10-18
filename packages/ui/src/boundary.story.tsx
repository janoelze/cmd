// A view that throws while rendering shows the ErrorBoundary in its own place (a window's
// tile, a page) instead of blanking the whole window. Reload mounts it again.
import { useState, type ReactNode } from "react";
import { ErrorBoundary } from "./boundary.tsx";
import { View } from "./frame.tsx";

/** Throws while `broken`. */
function Fragile({ broken }: { broken: boolean }): ReactNode {
  if (broken) throw new Error("This view broke on purpose (a story)");
  return <View state={{ kind: "empty", icon: "check-circle", title: "Working again" }} />;
}

const Box = ({ w, children }: { w: number; children: ReactNode }) => <div style={{ width: w, height: 240, display: "flex", borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>{children}</div>;

/** Broken: Reload works the second time. And at a narrow window's width. */
export const Broken = () => {
  const [broken, setBroken] = useState(true);
  return (
    <div style={{ display: "flex", gap: "var(--space-5)" }}>
      <Box w={320}>
        <ErrorBoundary text="Your other windows keep running." onError={() => setBroken(false)}>
          <Fragile broken={broken} />
        </ErrorBoundary>
      </Box>
      <Box w={200}>
        <ErrorBoundary text="Your other windows keep running." onReload={() => {}}>
          <Fragile broken />
        </ErrorBoundary>
      </Box>
    </div>
  );
};
