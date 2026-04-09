import type { Message, Thread } from "chat";
import { runAgentSessionPoll } from "./agentSync.js";
import type {
  AgentPollOptions,
  Chat2AgentThreadState,
  DevinBackend,
  DispatchResult,
  MergeUserReplyFn,
  ValidateSessionPrereqsFn,
} from "./types.js";

export type TurnKind = "mention" | "subscribed";

export type ProcessTurnConfig = {
  devin: DevinBackend;
  validateSessionPrereqs: ValidateSessionPrereqsFn;
  mergeUserReply: MergeUserReplyFn;
  maxPrereqPromptRounds: number;
  getDevinRepos?: (slots: Record<string, string>) => string[] | undefined;
  formatDispatchSuccess: (r: Extract<DispatchResult, { ok: true }>) => string;
  formatAbortMessage: (missing: string[]) => string;
  onDispatchResult?: (
    thread: Thread<Chat2AgentThreadState>,
    result: DispatchResult,
  ) => void | Promise<void>;
  /** Schedule work after the HTTP response (e.g. Next.js `after`). Used to poll Devin. */
  scheduleBackgroundWork?: (fn: () => void | Promise<void>) => void;
  agentPollOptions?: AgentPollOptions;
  /**
   * Called after `phase` is set to `agent_running` (session created or user reply forwarded).
   * Use with a durable queue + Vercel Cron when `after()` polling is insufficient.
   */
  onAgentRunning?: (thread: Thread<Chat2AgentThreadState>) => void | Promise<void>;
};

function emptyState(): Chat2AgentThreadState {
  return {
    phase: "idle",
    accumulatedPrompt: "",
    clarificationPromptsPosted: 0,
    slots: {},
  };
}

async function notifyAgentRunning(
  thread: Thread<Chat2AgentThreadState>,
  config: ProcessTurnConfig,
): Promise<void> {
  if (config.onAgentRunning) {
    await config.onAgentRunning(thread);
  }
}

function scheduleAgentPoll(
  thread: Thread<Chat2AgentThreadState>,
  config: ProcessTurnConfig,
): void {
  if (!config.scheduleBackgroundWork) return;
  config.scheduleBackgroundWork(() => {
    void runAgentSessionPoll(thread, config.devin, config.agentPollOptions).catch(() => {
      /* integrator can wrap scheduleBackgroundWork with logging */
    });
  });
}

async function dispatchDevin(
  prompt: string,
  slots: Record<string, string>,
  config: ProcessTurnConfig,
): Promise<DispatchResult> {
  try {
    const repos = config.getDevinRepos?.(slots);
    const session = await config.devin.createSession({
      prompt,
      repos,
      title: slots.title,
    });
    return { ok: true, session };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function processTurn(
  thread: Thread<Chat2AgentThreadState>,
  message: Message,
  config: ProcessTurnConfig,
  kind: TurnKind,
): Promise<void> {
  if (message.author.isMe) return;

  const prev = (await thread.state) ?? emptyState();

  if (kind === "subscribed") {
    if (
      prev.phase !== "gathering_prereqs" &&
      prev.phase !== "awaiting_agent_clarification"
    ) {
      return;
    }
  }

  let accumulatedPrompt: string;
  let slots: Record<string, string>;
  let clarificationPromptsPosted: number;
  let externalSessionId: string | undefined;
  let externalSessionUrl: string | undefined;
  let lastMirroredAgentMessageKey: string | undefined;

  if (kind === "mention") {
    accumulatedPrompt = message.text.trim();
    slots = {};
    clarificationPromptsPosted = 0;
    externalSessionId = undefined;
    externalSessionUrl = undefined;
    lastMirroredAgentMessageKey = undefined;
  } else if (prev.phase === "awaiting_agent_clarification") {
    const text = message.text.trim();
    if (!text) return;

    const sessionId = prev.externalSessionId;
    if (!sessionId) return;

    try {
      await config.devin.sendSessionMessage(sessionId, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await thread.post(`Could not forward your message to Devin: ${msg}`);
      return;
    }

    const merged = config.mergeUserReply(prev, message);
    await thread.setState({
      phase: "agent_running",
      accumulatedPrompt: `${prev.accumulatedPrompt}${merged.appendedPrompt}`.trim(),
      clarificationPromptsPosted: prev.clarificationPromptsPosted,
      slots: { ...prev.slots, ...merged.slotsPatch },
      externalSessionId: prev.externalSessionId,
      externalSessionUrl: prev.externalSessionUrl,
      lastMirroredAgentMessageKey: prev.lastMirroredAgentMessageKey,
    });

    scheduleAgentPoll(thread, config);
    await notifyAgentRunning(thread, config);
    return;
  } else {
    const merged = config.mergeUserReply(prev, message);
    accumulatedPrompt = `${prev.accumulatedPrompt}${merged.appendedPrompt}`.trim();
    slots = { ...prev.slots, ...merged.slotsPatch };
    clarificationPromptsPosted = prev.clarificationPromptsPosted;
    externalSessionId = prev.externalSessionId;
    externalSessionUrl = prev.externalSessionUrl;
    lastMirroredAgentMessageKey = prev.lastMirroredAgentMessageKey;
  }

  const prereqs = await config.validateSessionPrereqs({
    threadId: thread.id,
    channelId: thread.channelId,
    accumulatedPrompt,
    slots,
  });

  if (prereqs.status === "need_more") {
    if (clarificationPromptsPosted >= config.maxPrereqPromptRounds) {
      await thread.post(config.formatAbortMessage(prereqs.missing));
      await thread.setState({
        phase: "aborted",
        accumulatedPrompt,
        clarificationPromptsPosted,
        slots,
        externalSessionId,
        externalSessionUrl,
        lastMirroredAgentMessageKey,
      });
      return;
    }

    await thread.subscribe();
    await thread.setState({
      phase: "gathering_prereqs",
      accumulatedPrompt,
      clarificationPromptsPosted: clarificationPromptsPosted + 1,
      slots,
      externalSessionId,
      externalSessionUrl,
      lastMirroredAgentMessageKey,
    });
    await thread.post(prereqs.prompt);
    return;
  }

  const dispatch = await dispatchDevin(accumulatedPrompt, slots, config);

  if (config.onDispatchResult) {
    await config.onDispatchResult(thread, dispatch);
  }

  if (dispatch.ok) {
    await thread.post(config.formatDispatchSuccess(dispatch));
    await thread.setState({
      phase: "agent_running",
      accumulatedPrompt,
      clarificationPromptsPosted: 0,
      slots,
      externalSessionId: dispatch.session.id,
      externalSessionUrl: dispatch.session.url,
      lastMirroredAgentMessageKey: undefined,
    });
    scheduleAgentPoll(thread, config);
    await notifyAgentRunning(thread, config);
  } else {
    await thread.post(`Could not start Devin session: ${dispatch.error}`);
    await thread.setState({
      phase: "aborted",
      accumulatedPrompt,
      clarificationPromptsPosted: 0,
      slots,
      externalSessionId,
      externalSessionUrl,
      lastMirroredAgentMessageKey,
    });
  }
}
