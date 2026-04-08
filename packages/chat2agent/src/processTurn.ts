import type { Message, Thread } from "chat";
import { runAgentSessionPoll } from "./agentSync.js";
import type {
  AgentName,
  AgentPollOptions,
  Chat2AgentThreadState,
  DevinBackend,
  DispatchResult,
  JulesBackend,
  MergeUserReplyFn,
  ResolveAgentFn,
  ResolveJulesSourceFn,
  ValidateSessionPrereqsFn,
} from "./types.js";

export type TurnKind = "mention" | "subscribed";

export type ProcessTurnConfig = {
  defaultAgent: AgentName;
  resolveAgent: ResolveAgentFn;
  resolveJulesSource?: ResolveJulesSourceFn;
  validateSessionPrereqs: ValidateSessionPrereqsFn;
  mergeUserReply: MergeUserReplyFn;
  maxPrereqPromptRounds: number;
  agents: {
    devin?: DevinBackend;
    jules?: JulesBackend;
  };
  getDevinRepos?: (slots: Record<string, string>) => string[] | undefined;
  formatDispatchSuccess: (r: Extract<DispatchResult, { ok: true }>) => string;
  formatAbortMessage: (missing: string[]) => string;
  onDispatchResult?: (
    thread: Thread<Chat2AgentThreadState>,
    result: DispatchResult,
  ) => void | Promise<void>;
  /** Schedule work after the HTTP response (e.g. Next.js `after`). Used to poll Devin/Jules. */
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
    selectedAgent: null,
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
    void runAgentSessionPoll(thread, config.agents, config.agentPollOptions).catch(() => {
      /* integrator can wrap scheduleBackgroundWork with logging */
    });
  });
}

async function dispatchAgent(
  agent: AgentName,
  prompt: string,
  slots: Record<string, string>,
  julesCtx: { sourceResourceName: string; startingBranch: string } | null,
  config: ProcessTurnConfig,
): Promise<DispatchResult> {
  try {
    if (agent === "devin") {
      const backend = config.agents.devin;
      if (!backend) {
        return { ok: false, agent, error: "Devin backend is not configured." };
      }
      const repos = config.getDevinRepos?.(slots);
      const session = await backend.createSession({
        prompt,
        repos,
        title: slots.title,
      });
      return { ok: true, agent, session };
    }
    const backend = config.agents.jules;
    if (!backend) {
      return { ok: false, agent, error: "Jules backend is not configured." };
    }
    if (!julesCtx) {
      return {
        ok: false,
        agent,
        error: "Jules requires a source and branch (resolveJulesSource / slots).",
      };
    }
    const session = await backend.createSession({
      prompt,
      sourceResourceName: julesCtx.sourceResourceName,
      startingBranch: julesCtx.startingBranch,
      title: slots.title,
      automationMode: slots.jules_automation_mode,
    });
    return { ok: true, agent, session };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, agent, error: msg };
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
  let selectedAgent: AgentName | null;
  let externalSessionId: string | undefined;
  let externalSessionUrl: string | undefined;
  let lastMirroredAgentMessageKey: string | undefined;

  if (kind === "mention") {
    accumulatedPrompt = message.text.trim();
    slots = {};
    clarificationPromptsPosted = 0;
    selectedAgent = null;
    externalSessionId = undefined;
    externalSessionUrl = undefined;
    lastMirroredAgentMessageKey = undefined;
  } else if (prev.phase === "awaiting_agent_clarification") {
    const text = message.text.trim();
    if (!text) return;

    const agent = prev.selectedAgent;
    const sessionId = prev.externalSessionId;
    if (!agent || !sessionId) return;

    try {
      if (agent === "devin") {
        const b = config.agents.devin;
        if (!b) throw new Error("Devin backend is not configured.");
        await b.sendSessionMessage(sessionId, text);
      } else {
        const b = config.agents.jules;
        if (!b) throw new Error("Jules backend is not configured.");
        await b.sendSessionMessage(sessionId, text);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await thread.post(`Could not forward your message to ${agent}: ${msg}`);
      return;
    }

    const merged = config.mergeUserReply(prev, message);
    await thread.setState({
      phase: "agent_running",
      accumulatedPrompt: `${prev.accumulatedPrompt}${merged.appendedPrompt}`.trim(),
      clarificationPromptsPosted: prev.clarificationPromptsPosted,
      slots: { ...prev.slots, ...merged.slotsPatch },
      selectedAgent: prev.selectedAgent,
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
    selectedAgent = prev.selectedAgent;
    externalSessionId = prev.externalSessionId;
    externalSessionUrl = prev.externalSessionUrl;
    lastMirroredAgentMessageKey = prev.lastMirroredAgentMessageKey;
  }

  const agentChoice =
    config.resolveAgent({
      triggeringMessageText: message.text,
      accumulatedPrompt,
      slots,
    }) ?? config.defaultAgent;

  selectedAgent = agentChoice;

  let julesResolved: { sourceResourceName: string; startingBranch: string } | null =
    null;
  if (agentChoice === "jules") {
    if (config.resolveJulesSource) {
      julesResolved = await config.resolveJulesSource({
        threadId: thread.id,
        channelId: thread.channelId,
        accumulatedPrompt,
        slots,
      });
    }
    if (
      !julesResolved &&
      slots.jules_source?.trim() &&
      slots.jules_branch?.trim()
    ) {
      julesResolved = {
        sourceResourceName: slots.jules_source.trim(),
        startingBranch: slots.jules_branch.trim(),
      };
    }
  }

  const prereqs = await config.validateSessionPrereqs({
    threadId: thread.id,
    channelId: thread.channelId,
    accumulatedPrompt,
    slots,
    agent: agentChoice,
    jules: {
      sourceResourceName: julesResolved?.sourceResourceName ?? null,
      startingBranch: julesResolved?.startingBranch ?? null,
    },
  });

  if (prereqs.status === "need_more") {
    if (clarificationPromptsPosted >= config.maxPrereqPromptRounds) {
      await thread.post(config.formatAbortMessage(prereqs.missing));
      await thread.setState({
        phase: "aborted",
        accumulatedPrompt,
        clarificationPromptsPosted,
        slots,
        selectedAgent,
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
      selectedAgent,
      externalSessionId,
      externalSessionUrl,
      lastMirroredAgentMessageKey,
    });
    await thread.post(prereqs.prompt);
    return;
  }

  const dispatch = await dispatchAgent(
    agentChoice,
    accumulatedPrompt,
    slots,
    julesResolved,
    config,
  );

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
      selectedAgent,
      externalSessionId: dispatch.session.id,
      externalSessionUrl: dispatch.session.url,
      lastMirroredAgentMessageKey: undefined,
    });
    scheduleAgentPoll(thread, config);
    await notifyAgentRunning(thread, config);
  } else {
    await thread.post(`Could not start ${dispatch.agent}: ${dispatch.error}`);
    await thread.setState({
      phase: "aborted",
      accumulatedPrompt,
      clarificationPromptsPosted: 0,
      slots,
      selectedAgent,
      externalSessionId,
      externalSessionUrl,
      lastMirroredAgentMessageKey,
    });
  }
}
