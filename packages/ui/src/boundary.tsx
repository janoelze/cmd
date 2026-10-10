// ErrorBoundary: a view that throws while rendering shows a fallback in its own
// place (a window's tile, a page) instead of taking the whole React root down.
// Reload remounts the children; reporting is the page's (createRoot's
// onCaughtError, or `onError` here).

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./button.tsx";
import { View } from "./frame.tsx";

export interface ErrorBoundaryProps {
  children?: ReactNode;
  /** The fallback's title. */
  title?: ReactNode;
  /** A line under it: what still works, how to get back. */
  text?: ReactNode;
  /** The button's label. */
  reloadLabel?: string;
  /** What Reload does; by default the children mount again. */
  onReload?: () => void;
  /** Called once per caught error with React's component stack. */
  onError?: (error: unknown, info: { componentStack: string }) => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean; mount: number }> {
  state = { failed: false, mount: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, { componentStack: info.componentStack ?? "" });
  }

  reload = (): void => {
    if (this.props.onReload) return this.props.onReload();
    this.setState((s) => ({ failed: false, mount: s.mount + 1 }));
  };

  render(): ReactNode {
    const { title = "This window stopped working", text, reloadLabel = "Reload Window", children } = this.props;
    if (this.state.failed)
      return (
        <View
          scroll={false}
          state={{ kind: "error", title, text, action: <Button icon="arrow.clockwise" onClick={this.reload}>{reloadLabel}</Button> }}
        />
      );
    // A new key on Reload remounts the children from scratch.
    return <Fragment key={this.state.mount}>{children}</Fragment>;
  }
}
