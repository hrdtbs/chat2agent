import { ThreadImpl, type Thread } from "chat";
import { runAgentSessionPoll, type Chat2AgentThreadState } from "chat2agent";
import { createAgentBackends, getBot } from "@/lib/bot";
import { createPollQueue } from "@/lib/poll-queue";

const MAX_DEQUEUE = 10;

/**
 * Vercel Cron: drains Upstash queue entries (serialized threads) and runs one poll burst each.
 * Requires the same `@chat-adapter/state-*` backend as webhooks (use Redis in production).
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "CRON_SECRET is not set" }, { status: 503 });
  }
  const auth = request.headers.get("authorization");
  const vercelCron = request.headers.get("x-vercel-cron");
  const authorized =
    auth === `Bearer ${secret}` ||
    (vercelCron === "1" && process.env.VERCEL === "1");
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  const queue = createPollQueue();
  if (!queue) {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured",
    });
  }

  getBot();
  const backends = createAgentBackends();
  let processed = 0;

  for (let i = 0; i < MAX_DEQUEUE; i++) {
    const serialized = await queue.dequeueOne();
    if (!serialized) break;
    const thread = ThreadImpl.fromJSON(
      serialized,
    ) as Thread<Chat2AgentThreadState>;
    await runAgentSessionPoll(thread, backends, {
      intervalMs: Number(process.env.CHAT2AGENT_POLL_INTERVAL_MS ?? "3000"),
      maxIterations: Number(process.env.CHAT2AGENT_POLL_MAX_ITERATIONS ?? "40"),
    });
    const st = await thread.state;
    if (st?.phase === "agent_running") {
      await queue.enqueue(thread.toJSON());
    }
    processed += 1;
  }

  return Response.json({ ok: true, processed });
}
