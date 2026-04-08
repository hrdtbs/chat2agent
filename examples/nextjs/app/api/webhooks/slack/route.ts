import { getBot } from "@/lib/bot";
import { after } from "next/server";

export async function POST(request: Request) {
  return getBot().webhooks.slack(request, {
    waitUntil: (p) => {
      after(() => p);
    },
  });
}
