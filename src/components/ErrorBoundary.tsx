/**
 * Last line of defence: a render error anywhere shows a friendly page with a
 * reload button instead of a blank screen. User data lives in localStorage
 * and is untouched.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import Mascot from './Mascot';

interface State {
  readonly failed: boolean;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-cream p-6 text-center">
        <Mascot mood="sleepy" size={120} />
        <h1 className="text-2xl font-semibold text-ink">Oops — we tripped over the leash</h1>
        <p className="max-w-sm text-inkSoft">
          Something went wrong while drawing the page. Your saved walks and settings are safe on this device.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-[44px] rounded-full bg-terracotta px-6 font-display text-lg text-cream shadow-soft active:bg-terracottaDeep"
        >
          Reload
        </button>
      </main>
    );
  }
}
