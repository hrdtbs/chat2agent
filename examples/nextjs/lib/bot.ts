import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { after } from "next/server";
import {
  createChat2AgentBot,
  createDevinBackend,
  createJulesBackend,
  type SessionPrereqResult,
  type ValidateSessionPrereqsContext,
} from "chat2agent";
import { createPollQueue } from "./poll-queue";

function parseDefaultAgent(raw: string | undefined): "devin" | "jules" {
  if (raw === "jules") return "jules";
  return "devin";
}

function scheduleBackgroundWork(fn: () => void | Promise<void>) {
  after(() => fn());
}

/**
 * Only API-required fields before createSession (hybrid model).
 * Subjective task quality is left to Devin/Jules after the session starts.
 */
function validateSessionPrereqs(
  ctx: ValidateSessionPrereqsContext,
): SessionPrereqResult {
  if (ctx.agent === "jules") {
    if (!ctx.jules.sourceResourceName || !ctx.jules.startingBranch) {
      return {
        status: "need_more",
        missing: ["jules_source", "jules_branch"],
        prompt:
          "Jules にはソースとブランチが必要です。次のように返信してください:\n" +
          "- 1行目: `sources/...` 形式のソース名（Jules に登録済みの Source）\n" +
          "- 2行目: 起点ブランチ名（例: `main`）\n\n" +
          "または環境変数 `JULES_DEFAULT_SOURCE` と `JULES_DEFAULT_BRANCH` をホストに設定してください。",
      };
    }
  }

  return { status: "ready" };
}

/** Shared Devin/Jules clients for webhooks and Cron polling. */
export function createAgentBackends() {
  const devin =
    process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID
      ? createDevinBackend({
          apiKey: process.env.DEVIN_API_KEY,
          orgId: process.env.DEVIN_ORG_ID,
        })
      : undefined;

  const jules = process.env.JULES_API_KEY
    ? createJulesBackend({ apiKey: process.env.JULES_API_KEY })
    : undefined;

  return { devin, jules };
}

function buildBot() {
  const backends = createAgentBackends();
  const pollQueue = createPollQueue();
  const useCronPoll =
    process.env.CHAT2AGENT_USE_CRON_POLL === "1" && pollQueue != null;

  return createChat2AgentBot({
    chat: {
      userName: process.env.BOT_USER_NAME ?? "chat2agent",
      adapters: {
        slack: createSlackAdapter(),
        discord: createDiscordAdapter(),
      },
      state: createMemoryState(),
      dedupeTtlMs: 600_000,
    },
    defaultAgent: parseDefaultAgent(process.env.CHAT2AGENT_DEFAULT_AGENT),
    resolveAgent: ({ triggeringMessageText }) => {
      const t = triggeringMessageText.toLowerCase();
      if (/\bjules\b/.test(t)) return "jules";
      if (/\bdevin\b/.test(t)) return "devin";
      return null;
    },
    resolveJulesSource: async ({ slots, accumulatedPrompt }) => {
      const fromEnv = process.env.JULES_DEFAULT_SOURCE?.trim();
      const branchFromEnv = process.env.JULES_DEFAULT_BRANCH?.trim() ?? "main";
      if (fromEnv) {
        return {
          sourceResourceName: fromEnv,
          startingBranch: slots.jules_branch?.trim() || branchFromEnv,
        };
      }
      const lines = accumulatedPrompt
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const sourceLine = lines.find((l) => l.startsWith("sources/"));
      const branchLine = lines.find(
        (l) =>
          l !== sourceLine &&
          (/^(main|master|develop|HEAD)$/i.test(l) ||
            (/^[\w./-]+$/.test(l) && !l.includes("/"))),
      );
      if (sourceLine && branchLine) {
        return {
          sourceResourceName: sourceLine,
          startingBranch: branchLine,
        };
      }
      return null;
    },
    validateSessionPrereqs,
    mergeUserReply: (state, message) => {
      const text = message.text.trim();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const patch: Record<string, string> = {};
      const sourceLine = lines.find((l) => l.startsWith("sources/"));
      if (sourceLine) patch.jules_source = sourceLine;
      const branchLine = lines.find(
        (l) =>
          l !== sourceLine &&
          (/^(main|master|develop)$/i.test(l) ||
            (/^[\w./-]{1,64}$/.test(l) && !l.includes(":"))),
      );
      if (branchLine) patch.jules_branch = branchLine;
      const repoLine = lines.find((l) => /^[\w.-]+\/[\w.-]+$/.test(l));
      if (repoLine) patch.devin_repos = repoLine;
      return { appendedPrompt: text ? `\n\n${text}` : "", slotsPatch: patch };
    },
    maxClarificationRounds:
      Number(process.env.CHAT2AGENT_MAX_CLARIFICATION ?? "5") || 5,
    scheduleBackgroundWork: useCronPoll ? undefined : scheduleBackgroundWork,
    onAgentRunning: useCronPoll
      ? async (thread) => {
          await pollQueue!.enqueue(thread.toJSON());
        }
      : undefined,
    agents: backends,
  });
}

let cached: ReturnType<typeof buildBot> | undefined;

/** Lazy init so `next build` does not require Slack/Discord secrets at compile time. */
export function getBot() {
  if (!cached) cached = buildBot();
  return cached;
}
