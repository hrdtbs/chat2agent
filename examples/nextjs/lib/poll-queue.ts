import { Redis } from "@upstash/redis";
import type { SerializedThread } from "chat";

const QUEUE_KEY = "chat2agent:poll-queue";

export function createPollQueue(): {
  enqueue: (serialized: SerializedThread) => Promise<void>;
  dequeueOne: () => Promise<SerializedThread | null>;
} | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    async enqueue(serialized: SerializedThread) {
      await redis.lpush(QUEUE_KEY, JSON.stringify(serialized));
    },
    async dequeueOne() {
      const v = await redis.rpop<string>(QUEUE_KEY);
      if (!v) return null;
      return JSON.parse(v) as SerializedThread;
    },
  };
}
