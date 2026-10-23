// A connector Pip needs isn't connected (Spec 4). The action throws this instead of a plain
// "not found", so a turn can ask you to connect it with a card, wait, and pick its work up again
// once you do. Connecting stays yours, from Settings: Pip never sees the secret.

/** The connectors a turn can wait for. Notion first; Google, Slack and GitHub come later. */
export type ConnectProvider = "notion";

export const CONNECT_PROVIDERS: Record<ConnectProvider, { label: string; connectAction: string }> =
  {
    notion: { label: "Notion", connectAction: "notion.connect" },
  };

export interface ConnectionNeed {
  provider: ConnectProvider;
  /** Why Pip needs it, in Pip's own words: never words from outside content. */
  why: string;
  /** The owner's own action that connects it, from Settings. */
  connectAction: string;
}

export class ConnectionError extends Error {
  readonly code = "needs_connection" as const;
  readonly need: ConnectionNeed;
  constructor(provider: ConnectProvider, why: string) {
    const p = CONNECT_PROVIDERS[provider];
    super(`${p.label} isn't connected.`);
    this.name = "ConnectionError";
    this.need = { provider, why, connectAction: p.connectAction };
  }
}
