import type { Message } from "chat";

/** Which external coding agent receives the task. */
export type AgentName = "devin" | "jules";

export type Chat2AgentPhase =
  | "idle"
  /** Collecting API-required fields (e.g. Jules source/branch) before createSession. */
  | "gathering_prereqs"
  /** Session exists; polling Devin/Jules for user input or completion. */
  | "agent_running"
  /** We posted the agent's question in chat; waiting for the user's thread reply. */
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
  /** Arbitrary key/value slots (repo, branch, etc.). */
  slots: Record<string, string>;
  selectedAgent: AgentName | null;
  /** Devin session id (e.g. devin-…) or Jules session id after createSession. */
  externalSessionId?: string;
  externalSessionUrl?: string;
  /** Dedupe key for the last agent question mirrored to chat (event id / activity id / synthetic). */
  lastMirroredAgentMessageKey?: string;
}

export type ResolveAgentContext = {
  triggeringMessageText: string;
  accumulatedPrompt: string;
  slots: Record<string, string>;
};

export type ResolveAgentFn = (ctx: ResolveAgentContext) => AgentName | null;

export type JulesSourceContext = {
  sourceResourceName: string;
  startingBranch: string;
};

export type ResolveJulesSourceContext = {
  threadId: string;
  channelId: string;
  accumulatedPrompt: string;
  slots: Record<string, string>;
};

export type ResolveJulesSourceFn = (
  ctx: ResolveJulesSourceContext,
) => Promise<JulesSourceContext | null>;

export type PrereqStatus = "ready" | "need_more";

export type SessionPrereqResult =
  | { status: "ready" }
  | { status: "need_more"; missing: string[]; prompt: string };

export type ValidateSessionPrereqsContext = {
  threadId: string;
  channelId: string;
  accumulatedPrompt: string;
  slots: Record<string, string>;
  agent: AgentName;
  /** Resolved when `agent === "jules"`; nulls if not yet known. */
  jules: {
    sourceResourceName: string | null;
    startingBranch: string | null;
  };
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

/** Jules session.state enum strings from API. */
export type JulesSessionSnapshot = {
  sessionId: string;
  name: string;
  url: string;
  state: string;
};

export type JulesActivity = {
  id: string;
  description?: string;
  agentMessaged?: { agentMessage?: string };
  planGenerated?: unknown;
  sessionFailed?: { reason?: string };
};

export interface JulesBackend {
  createSession(input: {
    prompt: string;
    sourceResourceName: string;
    startingBranch: string;
    title?: string;
    automationMode?: string;
  }): Promise<SessionResult>;
  getSession(sessionId: string): Promise<JulesSessionSnapshot>;
  listActivities(
    sessionId: string,
    pageToken?: string,
  ): Promise<{ activities: JulesActivity[]; nextPageToken?: string }>;
  sendSessionMessage(sessionId: string, prompt: string): Promise<void>;
}

export type DispatchResult =
  | { ok: true; agent: AgentName; session: SessionResult }
  | { ok: false; agent: AgentName; error: string };

export type AgentPollOptions = {
  /** Delay between polls in ms (default 3000). */
  intervalMs?: number;
  /** Max poll iterations per scheduled run (default 40). */
  maxIterations?: number;
};
