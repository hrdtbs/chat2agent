import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { after } from "next/server";
import {
  createChat2AgentBot,
  createDevinBackend,
  type DevinBackend,
  type SessionPrereqResult,
  type ValidateSessionPrereqsContext,
} from "chat2agent";
function scheduleBackgroundWork(fn: () => void | Promise<void>) {
  after(() => fn());
}

/**
 * Only API-required fields before createSession (hybrid model).
 * Subjective task quality is left to Devin after the session starts.
 */
function validateSessionPrereqs(
  _ctx: ValidateSessionPrereqsContext,
): SessionPrereqResult {
  return { status: "ready" };
}

/** Shared Devin client for webhooks. */
export function createDevinClient(): DevinBackend | undefined {
  if (!process.env.DEVIN_API_KEY || !process.env.DEVIN_ORG_ID) return undefined;
  return createDevinBackend({
    apiKey: process.env.DEVIN_API_KEY,
    orgId: process.env.DEVIN_ORG_ID,
  });
}

function missingDevinBackend(): DevinBackend {
  const err = () =>
    Promise.reject(
      new Error(
        "Configure DEVIN_API_KEY and DEVIN_ORG_ID in the environment.",
      ),
    );
  return {
    createSession: () => err(),
    getSession: () => err(),
    listSessionMessages: async () => ({ items: [], hasNextPage: false }),
    sendSessionMessage: () => err(),
  };
}

function buildBot() {
  const devin = createDevinClient() ?? missingDevinBackend();

  return createChat2AgentBot({
    chat: {
      userName: process.env.BOT_USER_NAME ?? "chat2agent",
      adapters: {
        slack: createSlackAdapter(),
      },
      state: createMemoryState(),
      dedupeTtlMs: 600_000,
    },
    devin,
    validateSessionPrereqs,
    mergeUserReply: (state, message) => {
      const text = message.text.trim();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const patch: Record<string, string> = {};
      const repoLine = lines.find((l) => /^[\w.-]+\/[\w.-]+$/.test(l));
      if (repoLine) patch.devin_repos = repoLine;
      return { appendedPrompt: text ? `\n\n${text}` : "", slotsPatch: patch };
    },
    maxClarificationRounds:
      Number(process.env.CHAT2AGENT_MAX_CLARIFICATION ?? "5") || 5,
    scheduleBackgroundWork,
  });
}

let cached: ReturnType<typeof buildBot> | undefined;

/** Lazy init so `next build` does not require Slack secrets at compile time. */
export function getBot() {
  if (!cached) cached = buildBot();
  return cached;
}
