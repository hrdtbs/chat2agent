# chat2agent

Slack / Discord での **メンション** を受け取り、**createSession に必要な条件だけ** 同じスレッドで補足し、セッション開始後は **Devin / Jules の API** で「ユーザー入力待ち」等を検知して追加質問を写す TypeScript SDK です。イングレスには [Vercel Chat SDK](https://github.com/vercel/chat)（`chat` + `@chat-adapter/slack` / `@chat-adapter/discord`）を使います。

## ドキュメント


| 向け                                    | ファイル                                       |
| ------------------------------------- | ------------------------------------------ |
| **チャットでボットを使う人**（Slack / Discord 利用者） | [docs/end-users.md](docs/end-users.md)     |
| **組み込み・運用する人**（開発者 / SRE）             | [docs/integrators.md](docs/integrators.md) |


## モノレポ構成


| パス                                         | 説明                           |
| ------------------------------------------ | ---------------------------- |
| [packages/chat2agent](packages/chat2agent) | 公開パッケージ `chat2agent`（npm レジストリ） |
| [examples/nextjs](examples/nextjs)         | Webhook を受ける Next.js 15 の最小例 |

ルートで [pnpm](https://pnpm.io/) を使用します（[Corepack](https://nodejs.org/api/corepack.html): `corepack enable` 後、`package.json` の `packageManager` に従います）。


## クイックスタート（ライブラリ利用）

```bash
pnpm add chat2agent chat @chat-adapter/slack @chat-adapter/discord @chat-adapter/state-memory
# または: npm install chat2agent chat @chat-adapter/slack @chat-adapter/discord @chat-adapter/state-memory
```

```typescript
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { after } from "next/server";
import {
  createChat2AgentBot,
  createDevinBackend,
} from "chat2agent";

const bot = createChat2AgentBot({
  chat: {
    userName: "mybot",
    adapters: { slack: createSlackAdapter() },
    state: createMemoryState(),
  },
  defaultAgent: "devin",
  resolveAgent: () => null,
  validateSessionPrereqs: () => ({ status: "ready" }),
  scheduleBackgroundWork: (fn) => after(() => fn()),
  agents: {
    devin: createDevinBackend({
      apiKey: process.env.DEVIN_API_KEY!,
      orgId: process.env.DEVIN_ORG_ID!,
    }),
  },
});

// Next.js App Router 例
export async function POST(req: Request) {
  return bot.webhooks.slack(req, {
    waitUntil: (p) => after(() => p),
  });
}
```

## 補足と追加質問（2 段階）

### 起動前（`validateSessionPrereqs`）

1. `validateSessionPrereqs` が `createSession` 前に **API 必須だけ** を判定（例: Jules の `sources/...` とブランチ）。
2. `need_more` のとき `thread.subscribe()` し、案内を `thread.post`（回数は `maxClarificationRounds`）。
3. 返信は `mergeUserReply` で `accumulatedPrompt` / `slots` にマージし、再度 `validateSessionPrereqs`。

### 起動後（エージェント API + ポーリング）

1. `ready` なら `createSession`。成功後はバックグラウンドで [Get Session / メッセージ一覧（Devin）](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session) または [Jules の state / activities](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions) をポーリング。
2. `waiting_for_user` / `AWAITING_USER_FEEDBACK` 等を検知したら、エージェントの文言を `thread.post` し、返信を `sendSessionMessage` に中継。

Next.js では `scheduleBackgroundWork: (fn) => after(() => fn())` を渡す想定です。長時間だけ Cron + Redis キューの例は [examples/nextjs](examples/nextjs) と [docs/integrators.md](docs/integrators.md) を参照。

ボット自身のメッセージは Chat SDK 側でハンドラに渡らない想定です。メッセージ編集・削除は初版では未対応（受信テキストのみ）。

## マイグレーション（`assessCompleteness` 利用者向け）

- 設定キーを `assessCompleteness` から `**validateSessionPrereqs`** に変更してください。戻り値の形（`ready` / `need_more` + `missing` + `prompt`）は同じです。
- **依頼文の品質**はエージェント側に任せる前提です。従来の「短文拒否」などは `validateSessionPrereqs` か別ロジックで残せます。
- セッション開始後の追加質問には `**scheduleBackgroundWork`**（例: Next の `after`）が必要です。

## 本番の状態ストア

例では `@chat-adapter/state-memory` を使用しています。複数インスタンスや再デプロイ間で **購読・スレッド状態・重複排除** を共有するには、`@chat-adapter/state-redis` などに差し替えてください。Cron 駆動ポーリングを使う場合も、スレッド状態は Redis 等で共有できる構成にしてください。

## 外部 API リファレンス

- **Devin v3** — [Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md)、[Get Session](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session)、[List session messages](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages.md)、[Send message](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages.md)
- **Jules** — [sessions.create](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/create)、[Session resource](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#Session)、[activities.list](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities/list)、[sendMessage](https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage)

## Slack アプリ

- Bot User を有効化し、必要スコープを付与（`app_mentions:read`、`chat:write` など用途に応じて）。
- Event Subscriptions の Request URL を `https://<host>/api/webhooks/slack` に。
- Signing Secret → `SLACK_SIGNING_SECRET`、Bot Token → `SLACK_BOT_TOKEN`。

## Discord アプリ

- Interactions Endpoint URL を `https://<host>/api/webhooks/discord` に。
- `DISCORD_BOT_TOKEN`、`DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY` を設定。
- メンションで応答するには、Message Content Intent など [Chat SDK の Discord ガイド](https://github.com/vercel/chat) に従ってください。

## Jules の前提

- 対象リポジトリに [Jules の GitHub 連携](https://developers.google.com/jules/api) が済んでいること。
- セッション作成には `sources/{id}` 形式のソース名と `startingBranch` が必要です。例では `JULES_DEFAULT_SOURCE` / 返信テキストのパースで補完します。

## 例アプリの実行

リポジトリルートで依存関係を入れてから、例アプリを起動します。

```bash
pnpm install
pnpm dev:example
```

別ターミナルで `examples/nextjs` に入る場合:

```bash
cd examples/nextjs
cp .env.example .env.local
# .env.local を編集
pnpm dev
```

`next build` 時にシークレットが無くても通るよう、ボットは `getBot()` で **遅延初期化** しています。

## Discord + Next.js のビルド注意

`discord.js` 系のオプション依存（`zlib-sync` 等）を webpack が解決しようとして失敗することがあるため、例の [next.config.ts](examples/nextjs/next.config.ts) で `serverExternalPackages` に指定しています。

## ライセンス

MIT