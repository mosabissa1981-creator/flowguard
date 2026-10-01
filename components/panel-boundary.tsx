"use client";

import { Component, type ReactNode } from "react";

type Props = { name: string; children: ReactNode };
type State = { error: Error | null };

/**
 * Keeps one broken panel from unmounting the whole desk. Without this, any
 * client exception (e.g. an API returning an unexpected shape) blanks the page,
 * which on a dark-mode iPhone home-screen app looks like a black screen.
 */
export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[FlowGuard] ${this.props.name} panel crashed`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="rounded-xl border border-rose-400/30 bg-rose-950/30 p-3 text-xs text-rose-100">
          <span className="font-medium">{this.props.name} failed to render.</span>{" "}
          <span className="text-rose-200/80">The rest of the desk still works.</span>{" "}
          <button
            type="button"
            className="ml-1 underline underline-offset-2"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
