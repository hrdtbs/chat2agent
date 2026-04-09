# インテグレータ向けガイド

この文書は **chat2agent を自社アプリやインフラに組み込む開発者・SRE・プラットフォーム担当**向けです。

## アーキテクチャ概要

```
Slack → HTTPS Webhook → Vercel Chat SDK（adapters）→ createChat2AgentBot
  → validateSessionPrereqs（createSession 前のみ）→ createSession（Devin）
  → scheduleBackgroundWork（例: after）→ runAgentSessionPoll → Devin GET + メッセージ API
```

- **イングレス**: `chat` の `Chat` クラスと `@chat-adapter/slack`。
- **起動前**: `validateSessionPrereqs` は **API が受け付けない必須項目**に限定する想定（組織独自のルール可）。
- **起動後**: `createDevinBackend` が **getSession・メッセージ一覧・sendMessage** を実装。`runAgentSessionPoll` が待ち状態を検知して `thread.post` / `subscribe` します（[agentSync.ts](../packages/chat2agent/src/agentSync.ts)）。
- **状態**: スレッド購読・`thread.setState`・重複排除は Chat SDK + **State アダプタ**（本番は Redis 推奨）。

## 依存関係の入れ方

アプリケーション側で最低限必要なパッケージの例です。

```bash
pnpm add chat2agent chat @chat-adapter/slack @chat-adapter/state-memory
# または npm install … / yarn add …
```

長時間のポーリングを **Vercel Cron** などで補う場合は、自前でキュー（例: Redis）を用意し `onAgentRunning` で `thread.toJSON()` を積み、Cron ハンドラから `ThreadImpl.fromJSON` と `runAgentSessionPoll` を呼び出す形になります。付属の Next 例は Next.js `after()` のみです。

## 公開 API（パッケージ `chat2agent`）


| エクスポート                | 役割                                                         |
| --------------------- | ---------------------------------------------------------- |
| `createChat2AgentBot` | `Chat` を生成し、`onNewMention` / `onSubscribedMessage` を登録     |
| `createDevinBackend`  | Devin v3 セッション作成 + get / list messages / send message      |
| `runAgentSessionPoll` | 単発のポーリングループ（第 2 引数に `DevinBackend`、Cron や `after` から呼び出し可） |
| `processTurn`         | 上記ハンドラ内のコア処理のみ再利用したい場合                                     |


型: `Chat2AgentThreadState`, `ValidateSessionPrereqsFn`, `MergeUserReplyFn` などは [types.ts](../packages/chat2agent/src/types.ts) を参照。

### `createChat2AgentBot` の主なオプション


| オプション                                          | 必須  | 説明                                                                                |
| ---------------------------------------------- | --- | --------------------------------------------------------------------------------- |
| `chat`                                         | はい  | `ChatConfig`（`userName`, `adapters`, `state`, `dedupeTtlMs` など）                   |
| `devin`                                        | はい  | `createDevinBackend(...)` の戻り値                                                    |
| `validateSessionPrereqs`                       | はい  | `createSession` 前のみ: `ready` または `need_more` + `missing` + `prompt`               |
| `scheduleBackgroundWork`                       | 推奨  | サーバレスで `runAgentSessionPoll` を HTTP 応答後に走らせる（例: `after(() => fn)`）                |
| `agentPollOptions`                             | いいえ | ポーリング間隔・1 回あたりの最大イテレーション（[AgentPollOptions](../packages/chat2agent/src/types.ts)） |
| `onAgentRunning`                               | いいえ | `phase: agent_running` のたびに呼ばれる。Cron 用に `thread.toJSON()` をキューへ積む用途               |
| `mergeUserReply`                               | いいえ | デフォルトは累積プロンプトへの追記のみ                                                               |
| `maxClarificationRounds`                       | いいえ | **起動前**の prereq プロンプト上限。既定 `5`                                                    |
| `getDevinRepos`                                | いいえ | 既定は `slots.devin_repos` を区切りで分割して Devin `repos` に渡す                               |
| `formatDispatchSuccess` / `formatAbortMessage` | いいえ | ユーザー向け文言のカスタム                                                                     |
| `onDispatchResult`                             | いいえ | ログ・メトリクス用フック                                                                      |


### スレッド `phase`（`Chat2AgentThreadState`）


| `phase`                        | 意味                                    |
| ------------------------------ | ------------------------------------- |
| `gathering_prereqs`            | createSession 前の必須情報をスレッドで集めている       |
| `agent_running`                | セッション作成済み。ポーリングで Devin の待ち状態を監視       |
| `awaiting_agent_clarification` | Devin の質問をチャットに出したあと、ユーザ返信を API に転送待ち |
| `dispatched`                   | Devin 側が完了などターミナルに達した（実装依存）           |
| `aborted`                      | 起動失敗・セッションエラー・prereq 打ち切りなど           |


### 内部動作（要約）

1. `onNewMention` で `processTurn(..., "mention")`。新規メンションはタスク状態をリセットします。
2. `validateSessionPrereqs` が `need_more` → `thread.subscribe()` → `phase: gathering_prereqs` → `thread.post`。
3. `onSubscribedMessage` は `phase` が `gathering_prereqs` または `awaiting_agent_clarification` のときだけ処理。
4. prereq 経路: `mergeUserReply` → 再バリデーション → `ready` なら `createSession`（Devin）。
5. セッション成功 → `phase: agent_running` + `scheduleBackgroundWork` で `runAgentSessionPoll`。
6. ポーリングがユーザ入力待ちを検知 → `thread.post` + `subscribe` → `awaiting_agent_clarification`。
7. 返信 → Devin へ `sendSessionMessage` → 再び `agent_running` とポーリング。

### マイグレーション: `assessCompleteness` → `validateSessionPrereqs`

- キー名と型名を置き換えてください。戻り値の形は同じです。
- 「依頼が短い」等の主観的チェックはエージェント起動後に任せるか、独自に `validateSessionPrereqs` に残してください。

### Next.js `after` と `Thread`

`Thread` は `adapterName` などを保持する **遅延解決ハンドル**です。`after(() => runAgentSessionPoll(thread, devin, …))` のように **Webhook ハンドラが握っている `thread` をクロージャで渡す**形が一般的です。`ThreadImpl.toJSON()` / `ThreadImpl.fromJSON()` はワークフローや Cron 連携向け（[Chat SDK の型定義](https://github.com/vercel/chat)参照）。

### Cron + キュー（自前・任意）

例アプリは **Next.js `after()` + `scheduleBackgroundWork`** のみです。サーバレスの実行時間やコールドスタートで `after()` 内のポーリングが途切れる懸念がある場合のみ、上記のとおりキューと Cron ルートをアプリ側で追加してください。**スレッド状態**もプロセスをまたぐ必要があるため、その場合は `@chat-adapter/state-redis` 等が前提になります。

## Webhook の配線（Next.js App Router）

```typescript
import { after } from "next/server";

export async function POST(request: Request) {
  return bot.webhooks.slack(request, {
    waitUntil: (p) => {
      after(() => p);
    },
  });
}
```

### ビルド時に環境変数が無い問題

Slack アダプタはモジュール読み込み時に `SLACK_SIGNING_SECRET` を要求するため、**ビルドでルートが評価される**と失敗することがあります。付属の [examples/nextjs/lib/bot.ts](../examples/nextjs/lib/bot.ts) は `getBot()` で **遅延初期化**しています。同様のパターンを推奨します。

## 環境変数

### 例アプリのテンプレート

[examples/nextjs/.env.example](../examples/nextjs/.env.example) が一覧です。

### Slack（シングルワークスペース）

- `SLACK_BOT_TOKEN`（`xoxb-...`）
- `SLACK_SIGNING_SECRET`

### Devin（v3）

- `DEVIN_API_KEY`（サービスユーザの Bearer、`cog_` プレフィックス）
- `DEVIN_ORG_ID`

参考: [Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md)、[Get Session](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session)、[List messages](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages.md)

### ボット挙動のチューニング

- `BOT_USER_NAME` — メンション判定用（[Chat SDK](https://github.com/vercel/chat) の `userName`）
- `CHAT2AGENT_MAX_CLARIFICATION` — **起動前** prereq プロンプトの最大回数（例アプリ）
## 本番の状態ストア

`createMemoryState()` は **プロセス内のみ**です。複数レプリカやサーバレスでは購読・ロック・スレッド状態が共有されません。

- `@chat-adapter/state-redis`（または `state-pg` 等）へ差し替え
- `dedupeTtlMs` を Webhook 再送・コールドスタートに合わせて調整（既定 5 分より長めも可）

## Slack アプリ設定（チェックリスト）

- Bot をチャンネルに招待
- Event Subscriptions: Request URL を `https://<host>/api/webhooks/slack`（実際のパスに合わせる）
- `app_mention` 等、必要イベントを購読
- OAuth スコープ: 少なくとも `app_mentions:read`, `chat:write`（要件に応じて追加）

## ローカル開発

モノレポのルートで依存関係を解決してから起動します。

```bash
pnpm install
pnpm dev:example
```

`examples/nextjs` で `.env.local` を用意する手順は従来どおりです（上記の `dev:example` はルートから `next dev` を実行します）。別途ディレクトリに入る場合:

```bash
cd examples/nextjs
cp .env.example .env.local
pnpm dev
```

Slack は [ngrok](https://ngrok.com/) 等で HTTPS トンネルを張り、Event Subscriptions の URL を一時的に差し替えます。

## エンドユーザ向けの説明

チャンネルでの書き方・追加質問の答え方は [エンドユーザ向けガイド](./end-users.md) に分離しています。組織向けにカスタムした場合は、その内容を上書きして配布してください。