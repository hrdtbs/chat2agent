import type { Thread } from "chat";
import type {
  AgentPollOptions,
  Chat2AgentThreadState,
  DevinBackend,
  DevinSessionMessage,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lastDevinAssistantMessage(items: DevinSessionMessage[]): DevinSessionMessage | null {
  const fromDevin = items.filter((m) => m.source === "devin");
  return fromDevin.length ? fromDevin[fromDevin.length - 1]! : null;
}

/**
 * Poll Devin until the session asks for input (mirrored to chat), reaches a terminal state, or limits hit.
 */
export async function runAgentSessionPoll(
  thread: Thread<Chat2AgentThreadState>,
  devin: DevinBackend,
  pollOptions?: AgentPollOptions,
): Promise<void> {
  const intervalMs = pollOptions?.intervalMs ?? 3_000;
  const maxIterations = pollOptions?.maxIterations ?? 40;

  for (let i = 0; i < maxIterations; i++) {
    if (i > 0) await sleep(intervalMs);

    const state = await thread.state;
    if (!state?.externalSessionId) return;
    if (state.phase !== "agent_running") return;

    const sessionId = state.externalSessionId;

    let snap;
    try {
      snap = await devin.getSession(sessionId);
    } catch {
      return;
    }

    if (snap.status === "error") {
      await thread.post(`Devin session ended with an error. Open: ${snap.url || state.externalSessionUrl || ""}`);
      await thread.setState({
        phase: "aborted",
        lastMirroredAgentMessageKey: state.lastMirroredAgentMessageKey,
      });
      return;
    }

    if (snap.status === "exit") {
      await thread.post(
        `Devin session finished. ${snap.url || state.externalSessionUrl ? `Open: ${snap.url || state.externalSessionUrl}` : ""}`,
      );
      await thread.setState({ phase: "dispatched" });
      return;
    }

    if (snap.status === "running" && snap.statusDetail === "finished") {
      await thread.post(
        `Devin session completed. ${snap.url || state.externalSessionUrl ? `Open: ${snap.url || state.externalSessionUrl}` : ""}`,
      );
      await thread.setState({ phase: "dispatched" });
      return;
    }

    if (snap.status === "running" && snap.statusDetail === "waiting_for_approval") {
      const key = "devin:waiting_for_approval";
      if (state.lastMirroredAgentMessageKey !== key) {
        await thread.post(
          `Devin is waiting for approval (safe mode). Continue in the Devin UI: ${snap.url || state.externalSessionUrl || ""}`,
        );
        await thread.subscribe();
        await thread.setState({
          phase: "awaiting_agent_clarification",
          lastMirroredAgentMessageKey: key,
        });
      }
      return;
    }

    if (snap.status === "running" && snap.statusDetail === "waiting_for_user") {
      let items: DevinSessionMessage[] = [];
      try {
        const page = await devin.listSessionMessages(sessionId, { first: 100 });
        items = page.items;
      } catch {
        continue;
      }
      const last = lastDevinAssistantMessage(items);
      if (!last?.message?.trim()) continue;
      const key = `devin:${last.event_id}`;
      if (state.lastMirroredAgentMessageKey === key) continue;

      await thread.post(last.message.trim());
      await thread.subscribe();
      await thread.setState({
        phase: "awaiting_agent_clarification",
        lastMirroredAgentMessageKey: key,
      });
      return;
    }

    if (snap.status === "suspended") {
      const key = `devin:suspended:${snap.statusDetail ?? "unknown"}`;
      if (state.lastMirroredAgentMessageKey !== key) {
        await thread.post(
          `Devin session suspended (${snap.statusDetail ?? "unknown"}). Open: ${snap.url || state.externalSessionUrl || ""}`,
        );
        await thread.setState({
          lastMirroredAgentMessageKey: key,
        });
      }
      continue;
    }

    continue;
  }
}
