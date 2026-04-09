import { Chat } from "chat";
import type { Adapter, ChatConfig, Thread } from "chat";
import { processTurn } from "./processTurn.js";
import type { ProcessTurnConfig } from "./processTurn.js";
import type {
  AgentPollOptions,
  Chat2AgentThreadState,
  DevinBackend,
  DispatchResult,
  MergeUserReplyFn,
  ValidateSessionPrereqsFn,
} from "./types.js";

const defaultMergeUserReply: MergeUserReplyFn = (_state, message) => ({
  appendedPrompt: message.text.trim() ? `\n\n${message.text.trim()}` : "",
});

export type Chat2AgentBotConfig<TAdapters extends Record<string, Adapter>> = {
  /** Passed to `new Chat({ ... })` — include `userName`, `adapters`, `state`, etc. */
  chat: ChatConfig<TAdapters>;
  /** Devin session API — required. */
  devin: DevinBackend;
  /**
   * Return `ready` when `createSession` prerequisites are met, else `need_more` with a prompt.
   * Typically only API-required fields — not subjective task quality.
   */
  validateSessionPrereqs: ValidateSessionPrereqsFn;
  mergeUserReply?: MergeUserReplyFn;
  /** Max prereq prompts before createSession (default 5). */
  maxClarificationRounds?: number;
  /** Map slots to Devin `repos` array (optional). Default: `slots.devin_repos` split by comma. */
  getDevinRepos?: (slots: Record<string, string>) => string[] | undefined;
  /** User-facing success line(s) after a session is created. */
  formatDispatchSuccess?: (r: Extract<DispatchResult, { ok: true }>) => string;
  formatAbortMessage?: (missing: string[]) => string;
  onDispatchResult?: (
    thread: Thread<Chat2AgentThreadState>,
    result: DispatchResult,
  ) => void | Promise<void>;
  /**
   * Run work after the webhook response (e.g. Next.js `after(() => fn)`).
   * Required for agent-side clarification polling on serverless hosts.
   */
  scheduleBackgroundWork?: (fn: () => void | Promise<void>) => void;
  /** Options for `runAgentSessionPoll` (interval / max iterations per scheduled run). */
  agentPollOptions?: AgentPollOptions;
  /** Optional: enqueue `thread.toJSON()` for Cron-driven polling (see integrators doc). */
  onAgentRunning?: (
    thread: Thread<Chat2AgentThreadState>,
  ) => void | Promise<void>;
};

export function createChat2AgentBot<TAdapters extends Record<string, Adapter>>(
  config: Chat2AgentBotConfig<TAdapters>,
): Chat<TAdapters, Chat2AgentThreadState> {
  const maxPrereqPromptRounds = config.maxClarificationRounds ?? 5;
  const mergeUserReply = config.mergeUserReply ?? defaultMergeUserReply;

  const formatDispatchSuccess =
    config.formatDispatchSuccess ??
    ((r: Extract<DispatchResult, { ok: true }>) =>
      `Started **Devin** session: ${r.session.url} (id: \`${r.session.id}\`)`);

  const formatAbortMessage =
    config.formatAbortMessage ??
    ((missing: string[]) =>
      `I still need the following to continue: ${missing.join(", ")}. Please start a new @mention with the details.`);

  const turnConfig: ProcessTurnConfig = {
    devin: config.devin,
    validateSessionPrereqs: config.validateSessionPrereqs,
    mergeUserReply,
    maxPrereqPromptRounds,
    getDevinRepos:
      config.getDevinRepos ??
      ((slots) => {
        const raw = slots.devin_repos?.trim();
        if (!raw) return undefined;
        return raw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }),
    formatDispatchSuccess,
    formatAbortMessage,
    onDispatchResult: config.onDispatchResult,
    scheduleBackgroundWork: config.scheduleBackgroundWork,
    agentPollOptions: config.agentPollOptions,
    onAgentRunning: config.onAgentRunning,
  };

  const chat = new Chat<TAdapters, Chat2AgentThreadState>(config.chat);

  chat.onNewMention(async (thread, message) => {
    await processTurn(thread, message, turnConfig, "mention");
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await processTurn(thread, message, turnConfig, "subscribed");
  });

  return chat;
}
