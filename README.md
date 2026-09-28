# instagram-graph-test-server

`instagram-graph-test-server` is a local, in-memory fake of the Instagram Graph API (the Instagram API
with Instagram Login) for testing apps that moderate comments, reply to people and publish media.

Point your app's Instagram hosts at it instead of Meta. It answers the way Meta does and keeps the
state an Instagram integration depends on: professional accounts with their tokens and granted scopes,
media, comments and replies, hidden and deleted comments, conversations, webhook subscriptions,
publishing containers and the publishing quota. Your test plays everyone else: people comment, reply,
edit, delete and message the account, the login page answers, tokens age or get revoked, and the
server sends your webhook the signed events Meta would.

Nothing here talks to Meta, so tests need no real accounts, no app review and no test users, and can
run as often as they like in CI.

The project is intentionally narrow and early-stage.

## Install

```sh
npm install --save-dev instagram-graph-test-server
```

Requires Node.js 20.3 or newer. No runtime dependencies.

## Quick start

```js
import { startTestServer } from "instagram-graph-test-server";

const server = await startTestServer({
  app: {
    id: "1234567890",
    secret: "test-app-secret",
    redirectUris: ["http://localhost:4000/instagram/callback"],
  },
  // Where comment webhooks go, after Meta's GET verification handshake passes.
  webhook: {
    callbackUrl: "http://localhost:4000/instagram/webhook",
    verifyToken: "my-verify-token",
  },
});

// Start your app with every Instagram host pointed at server.origin (see below).

// Instagram's side, played by the test.
const shop = await server.createAccount({ username: "acme_store" });
await server.setNextLogin({ account_id: shop.id }); // the login page will "Allow" as this account
// ...your app runs its Instagram login and subscribes to comments...

const post = await server.postMedia(shop.id, { caption: "New drop" });
const spam = await server.comment(post.id, {
  username: "cheap_followers",
  text: "Buy 10k followers at example.com",
});
// spam.webhook reports whether the signed event reached your app.

// Then check what your app did. It runs asynchronously, so wait for the outcome.
(await server.getComment(spam.id)).hidden; // true, if your app hid it

await server.stop();
```

## Pointing your app at it

Instagram Login uses three hosts. Serve all three from `server.origin`:

| Meta host                     | Used for                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| `https://www.instagram.com`   | `/oauth/authorize`, the login and consent page                             |
| `https://api.instagram.com`   | `POST /oauth/access_token`, the code exchange                              |
| `https://graph.instagram.com` | `/access_token`, `/refresh_access_token` and every `/vNN.N/...` Graph call |

Most apps keep these in configuration. Instagram client libraries generally hard-code them, so a test
that uses one needs to rewrite those hosts, for example by wrapping `fetch`.

The test suite runs Vercel's Chat SDK Instagram adapter (`@chat-adapter/instagram`) against the
server: it passes Meta's verification handshake, verifies the webhook signature itself, receives a
direct message and sends its reply through the Graph API, with its `graph.instagram.com` requests
redirected to the server.

The login page at `/oauth/authorize` is a real page: open it in a browser and pick an account, or call
`setNextLogin()` so the next visit redirects straight back with a code, or with `access_denied`.

## Test actions

`startTestServer()` returns the server with these actions. The same actions are available over HTTP
under `${origin}/_fake/` for tests written in other languages.

| Action                                                                        | What happens                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `createAccount({ username, name, account_type })`                             | A professional account the app can log in as.                                                                           |
| `setNextLogin({ account_id, grant })`                                         | The next login page allows as that account, optionally granting only some scopes. `{ deny: true }` cancels.             |
| `changeTokens(accountId, { age_hours, expire, revoke, logout })`              | Age or expire the account's tokens, or invalidate them as a removed app (`revoke`) or an ended session (`logout`) does. |
| `postMedia(accountId, { caption, media_product_type })`                       | The account posts outside the app (`FEED`, `REELS` or `STORY`).                                                         |
| `comment(mediaId, { text, username \| person_id \| as_owner, parent_id })`    | Someone comments or replies; resolves after the webhook was sent, skipped or failed.                                    |
| `editComment(commentId, text)`, `deleteComment(commentId)`                    | The author edits or deletes their comment. Meta sends no webhook for either.                                            |
| `getComment(commentId)`, `getComments(mediaId)`                               | A comment's state (`hidden`, `deleted`) and its history: who hid, unhid or deleted it and when.                         |
| `sendMessageToAccount(accountId, { text, username \| person_id, hours_ago })` | Someone messages the account, opening the 24-hour window for the app to reply; `hours_ago` backdates it.                |
| `getMessages()`                                                               | Messages and private replies the app sent.                                                                              |
| `ageComment(commentId, hours)`                                                | Backdate a comment, e.g. past the 7-day private-reply limit.                                                            |
| `setContainerStatus(containerId, status)`                                     | Force a publishing container to `IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED` or `PUBLISHED`.                           |
| `setQuotaUsage(accountId, used)`                                              | Use up the account's publishing quota.                                                                                  |
| `getContainers()`, `getMedia(accountId)`                                      | What the app created and published.                                                                                     |
| `addFault({ method, path, status, code, times, apply })`                      | Fail the next matching Graph calls; with `apply`, the change is made but the answer is still an error.                  |
| `getWebhook()`, `verifyWebhook()`                                             | The callback, whether it passed verification, and every delivery attempt.                                               |
| `getCalls()`                                                                  | Every call the app made, and any Graph calls this server does not model.                                                |
| `stop()`                                                                      | Shut the server down.                                                                                                   |

## What it models

- **Login and tokens.** The authorize page with `state`, one-time codes bound to the redirect URI,
  short-lived tokens, the long-lived exchange, and refresh, which is refused for tokens under 24 hours
  old. Tokens carry the scopes the person granted; a call outside them fails with Meta's permission
  error.
- **Errors in Meta's shapes.** `{ error: { message, type, code, error_subcode, fbtrace_id } }`, with
  the variants Meta actually returns for a missing token (`IGApiException`, code 190), an unparseable
  one, a revoked one (subcode 460) and an expired one (subcode 463), and the `www-authenticate` header.
  As on Meta, the token is checked before the path.
- **Accounts.** `id` is the app-scoped id and `user_id` the professional account id that webhooks
  use, as on Meta; both address the account.
- **Fields.** `fields` with expansion, such as `from{id,username}`, `media{media_product_type}` and
  `replies{text}`. Paths work with or without a version prefix.
- **Comments.** Cursor pagination (at most 50 per page) that survives deletions, replies threaded one
  level deep, hiding and unhiding (`hide` is read from the query string only; the media owner's own
  comments stay visible; hidden comments take no replies), and deleting, which removes the replies too.
- **Webhooks.** Meta's `hub.challenge` handshake before the first delivery, `comments` events only for
  accounts subscribed through `subscribed_apps`, the body signed with the app secret in
  `X-Hub-Signature-256`, non-ASCII characters escaped exactly as Meta sends them, and retries after a
  failed delivery.
- **Publishing.** Containers for images, reels and stories, status polling, `media_publish`, the
  publishing limit, and the errors for publishing too early, twice or over quota.
- **Messages.** People message the account, which sends a `messages` webhook to subscribed accounts.
  The app may answer only within 24 hours of the person's last message, and may read the person's
  profile only after they messaged. A private reply to a comment needs the comments permission, goes to
  the commenter, and is allowed once per comment within 7 days. Meta documents these rules but not the
  error for breaking the private-reply ones; this server answers code 10, subcode 2534022, the
  documented messaging-window error.

## What it does not do

- Message attachments, reactions, read receipts, echoes and the Human Agent tag.
- `mentions`, `live_comments` and story webhooks; insights; hashtags; business discovery; Facebook Login
  for Business (`graph.facebook.com`).
- **Media downloads, unless you ask.** Meta downloads the file a container names. This server only does
  that with `downloadMedia: true`, because it then requests whatever URL the app sends.
- **Every detail Meta leaves undocumented.** Where Meta's documentation is silent or contradicts itself
  (for example, the daily publishing limit is given as both 50 and 100), this server follows the most
  consistent documented behaviour. The `/me` response is wrapped in `data` because Meta's own example
  shows it that way. It is a test tool, not a guarantee of how Meta will answer.
- Rate limits and usage headers.
- Anything security-related. Bind it to localhost and never expose it to a network you do not control.

## Development

```sh
pnpm install
pnpm test
```

## Status

This is an early-stage project with a deliberately small scope, and the API may still change.

## License

MIT
