import type { Message } from "chat";

export type Chat2AgentPhase =
  | "idle"
  /** Collecting API-required fields before createSession (optional integrator hook). */
  | "gathering_prereqs"
  /** Session exists; polling Devin for user input or completion. */
  | "agent_running"
  /** We posted Devin's question in chat; waiting for the user's thread reply. */
  | "awaiting_agent_clarification"
  | "dispatched"
  | "aborted";

/**
 * Persisted per thread by the Chat SDK (`thread.setState`).
 * See https://github.com/vercel/chat — thread state TTL defaults (e.g. 30 days).
 */
export interface Chat2AgentThreadState {
  phase: Chat2AgentPhase;
  /** Task description accumulated from the mention and follow-ups (pre-session). */
  accumulatedPrompt: string;
  /** How many prereq prompts we have posted before createSession. */
  clarificationPromptsPosted: number;
  /** Arbitrary key/value slots (e.g. `devin_repos`). */
  slots: Record<string, string>;
  /** Devin session id (e.g. devin-…) after createSession. */
  externalSessionId?: string;
  externalSessionUrl?: string;
  /** Dedupe key for the last agent question mirrored to chat (event id / synthetic). */
  lastMirroredAgentMessageKey?: string;
}

export type PrereqStatus = "ready" | "need_more";

export type SessionPrereqResult =
  | { status: "ready" }
  | { status: "need_more"; missing: string[]; prompt: string };

export type ValidateSessionPrereqsContext = {
  threadId: string;
  channelId: string;
  accumulatedPrompt: string;
  slots: Record<string, string>;
};

export type ValidateSessionPrereqsFn = (
  ctx: ValidateSessionPrereqsContext,
) => SessionPrereqResult | Promise<SessionPrereqResult>;

export type MergeUserReplyResult = {
  /** Appended to `accumulatedPrompt` (e.g. `"\n\n" + message.text`). */
  appendedPrompt: string;
  /** Merged into `slots` with later keys overriding. */
  slotsPatch?: Record<string, string>;
};

export type MergeUserReplyFn = (
  state: Chat2AgentThreadState,
  message: Message,
) => MergeUserReplyResult;

export type SessionResult = {
  id: string;
  url: string;
  raw?: unknown;
};

/** Devin GET session — status_detail per https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session */
export type DevinSessionSnapshot = {
  sessionId: string;
  url: string;
  status: string;
  statusDetail: string | null;
};

export type DevinSessionMessage = {
  event_id: string;
  source: "devin" | "user";
  message: string;
  created_at: number;
};

export interface DevinBackend {
  createSession(input: {
    prompt: string;
    repos?: string[];
    title?: string;
  }): Promise<SessionResult>;
  getSession(sessionId: string): Promise<DevinSessionSnapshot>;
  listSessionMessages(
    sessionId: string,
    options?: { first?: number; after?: string | null },
  ): Promise<{
    items: DevinSessionMessage[];
    hasNextPage: boolean;
    endCursor?: string | null;
  }>;
  sendSessionMessage(sessionId: string, message: string): Promise<void>;
}

export type DispatchResult =
  | { ok: true; session: SessionResult }
  | { ok: false; error: string };

export type AgentPollOptions = {
  /** Delay between polls in ms (default 3000). */
  intervalMs?: number;
  /** Max poll iterations per scheduled run (default 40). */
  maxIterations?: number;
};
