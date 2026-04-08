import type {
  JulesActivity,
  JulesBackend,
  JulesSessionSnapshot,
  SessionResult,
} from "../types.js";

/**
 * Jules API — sessions.create
 * @see https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/create
 */
export type JulesClientConfig = {
  apiKey: string;
  /** Default `https://jules.googleapis.com` */
  baseUrl?: string;
};

function sessionPath(base: string, sessionId: string): string {
  const id = sessionId.includes("/") ? sessionId.split("/").pop()! : sessionId;
  return `${base}/v1alpha/sessions/${encodeURIComponent(id)}`;
}

export function createJulesBackend(config: JulesClientConfig): JulesBackend {
  const base = (config.baseUrl ?? "https://jules.googleapis.com").replace(/\/$/, "");
  const createUrl = `${base}/v1alpha/sessions`;

  async function parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Jules API: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  return {
    async createSession(input: {
      prompt: string;
      sourceResourceName: string;
      startingBranch: string;
      title?: string;
      automationMode?: string;
    }): Promise<SessionResult> {
      const body: Record<string, unknown> = {
        prompt: input.prompt,
        sourceContext: {
          source: input.sourceResourceName,
          githubRepoContext: {
            startingBranch: input.startingBranch,
          },
        },
      };
      if (input.title) body.title = input.title;
      if (input.automationMode) body.automationMode = input.automationMode;

      const res = await fetch(createUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": config.apiKey,
        },
        body: JSON.stringify(body),
      });

      const json = (await parseJson(res)) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Jules API ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }

      const o = json as {
        name?: string;
        id?: string;
        url?: string;
      };
      const id = o.id ?? (o.name?.includes("/") ? o.name.split("/").pop() : o.name);
      if (!id) {
        throw new Error(`Jules API: missing session id: ${JSON.stringify(json).slice(0, 300)}`);
      }
      return {
        id,
        url: o.url ?? `https://jules.google/`,
        raw: json,
      };
    },

    async getSession(sessionId: string): Promise<JulesSessionSnapshot> {
      const url = sessionPath(base, sessionId);
      const res = await fetch(url, {
        headers: { "X-Goog-Api-Key": config.apiKey },
      });
      const json = (await parseJson(res)) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Jules API ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }
      const o = json as {
        name?: string;
        id?: string;
        url?: string;
        state?: string;
      };
      const id = o.id ?? sessionId;
      const name = o.name ?? `sessions/${id}`;
      if (!o.state) {
        throw new Error(`Jules API: missing session state`);
      }
      return {
        sessionId: id,
        name,
        url: o.url ?? `https://jules.google/`,
        state: o.state,
      };
    },

    async listActivities(
      sessionId: string,
      pageToken?: string,
    ): Promise<{ activities: JulesActivity[]; nextPageToken?: string }> {
      const id = sessionId.includes("/") ? sessionId.split("/").pop()! : sessionId;
      const u = new URL(`${base}/v1alpha/sessions/${encodeURIComponent(id)}/activities`);
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      u.searchParams.set("pageSize", "100");

      const res = await fetch(u.toString(), {
        headers: { "X-Goog-Api-Key": config.apiKey },
      });
      const json = (await parseJson(res)) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Jules API ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      }
      const activities = (json.activities as JulesActivity[] | undefined) ?? [];
      const nextPageToken = json.nextPageToken as string | undefined;
      return { activities, nextPageToken };
    },

    async sendSessionMessage(sessionId: string, prompt: string): Promise<void> {
      const id = sessionId.includes("/") ? sessionId.split("/").pop()! : sessionId;
      const url = `${base}/v1alpha/sessions/${encodeURIComponent(id)}:sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": config.apiKey,
        },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jules API ${res.status}: ${text.slice(0, 500)}`);
      }
    },
  };
}
