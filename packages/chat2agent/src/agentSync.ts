import type { Thread } from "chat";
import type {
  AgentName,
  AgentPollOptions,
  Chat2AgentThreadState,
  DevinBackend,
  DevinSessionMessage,
  JulesActivity,
  JulesBackend,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lastDevinAssistantMessage(items: DevinSessionMessage[]): DevinSessionMessage | null {
  const fromDevin = items.filter((m) => m.source === "devin");
  return fromDevin.length ? fromDevin[fromDevin.length - 1]! : null;
}

function lastJulesAgentMessage(activities: JulesActivity[]): { id: string; text: string } | null {
  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i]!;
    const msg = a.agentMessaged?.agentMessage?.trim();
    if (msg) return { id: a.id, text: msg };
  }
  return null;
}

function lastJulesSessionFailureReason(activities: JulesActivity[]): string | null {
  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i] as JulesActivity & {
      sessionFailed?: { reason?: string };
    };
    const reason = a.sessionFailed?.reason;
    if (reason) return reason;
  }
  return null;
}

export type AgentSyncBackends = {
  devin?: DevinBackend;
  jules?: JulesBackend;
};

/**
 * Poll Devin/Jules until the agent asks for input (mirrored to chat), reaches a terminal state, or limits hit.
 */
export async function runAgentSessionPoll(
  thread: Thread<Chat2AgentThreadState>,
  backends: AgentSyncBackends,
  pollOptions?: AgentPollOptions,
): Promise<void> {
  const intervalMs = pollOptions?.intervalMs ?? 3_000;
  const maxIterations = pollOptions?.maxIterations ?? 40;

  for (let i = 0; i < maxIterations; i++) {
    if (i > 0) await sleep(intervalMs);

    const state = await thread.state;
    if (!state?.externalSessionId || !state.selectedAgent) return;
    if (state.phase !== "agent_running") return;

    const agent = state.selectedAgent as AgentName;
    const sessionId = state.externalSessionId;

    if (agent === "devin") {
      const devin = backends.devin;
      if (!devin) return;

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

    const jules = backends.jules;
    if (!jules) return;

    let snap;
    try {
      snap = await jules.getSession(sessionId);
    } catch {
      return;
    }

    if (snap.state === "FAILED") {
      let reason = "";
      try {
        const { activities } = await jules.listActivities(sessionId);
        reason = lastJulesSessionFailureReason(activities) ?? "";
      } catch {
        /* ignore */
      }
      await thread.post(`Jules session failed.${reason ? ` ${reason}` : ""} ${snap.url}`);
      await thread.setState({ phase: "aborted" });
      return;
    }

    if (snap.state === "COMPLETED") {
      await thread.post(`Jules session completed. Open: ${snap.url}`);
      await thread.setState({ phase: "dispatched" });
      return;
    }

    if (snap.state === "AWAITING_PLAN_APPROVAL") {
      const key = "jules:plan_approval";
      if (state.lastMirroredAgentMessageKey !== key) {
        await thread.post(
          `Jules generated a plan and needs approval in the web UI before continuing:\n${snap.url}`,
        );
        await thread.subscribe();
        await thread.setState({
          phase: "awaiting_agent_clarification",
          lastMirroredAgentMessageKey: key,
        });
      }
      return;
    }

    if (snap.state === "AWAITING_USER_FEEDBACK") {
      let activities: JulesActivity[] = [];
      try {
        let token: string | undefined;
        do {
          const page = await jules.listActivities(sessionId, token);
          activities = activities.concat(page.activities);
          token = page.nextPageToken;
        } while (token);
      } catch {
        continue;
      }
      const last = lastJulesAgentMessage(activities);
      if (!last) continue;
      const key = `jules:${last.id}`;
      if (state.lastMirroredAgentMessageKey === key) continue;

      await thread.post(last.text);
      await thread.subscribe();
      await thread.setState({
        phase: "awaiting_agent_clarification",
        lastMirroredAgentMessageKey: key,
      });
      return;
    }
  }
}
