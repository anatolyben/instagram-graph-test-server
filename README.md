# instagram-graph-test-server

`instagram-graph-test-server` is a local test server for the Instagram Graph API (the Instagram API
with Instagram Login), for testing apps that moderate comments, answer a professional account's inbox
and publish media. It keeps everything in memory.

Point your app's Instagram hosts at it instead of Meta. It answers the way Meta does and keeps the
state an Instagram integration depends on: professional accounts with their tokens and granted scopes,
media, comments and replies, hidden and deleted comments, conversations, webhook subscriptions,
publishing containers and the publishing quota. Your test plays everyone else: people comment, reply,
edit, delete and message the account, the login page answers, tokens age or get revoked, and the
server sends your webhook the signed events Meta would.

Nothing here talks to Meta, so tests need no real accounts, no app review and no test users, and can
run as often as they like in CI. Never give it a real access token, app secret or account: it has no
use for them, and they would end up in test logs.

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

## Run it from the command line

For tests written in another language, run the server on its own and drive it over HTTP:

```sh
npx instagram-graph-test-server --app-id 1234567890 --app-secret test-app-secret \
  --redirect-uri http://localhost:4000/instagram/callback \
  --webhook-url http://localhost:4000/instagram/webhook --verify-token my-verify-token \
  --port 8083
```

`--download-media` turns on media downloads, and `--host` changes the address it binds to
(`127.0.0.1` by default). The routes under [Control API](#control-api) play Instagram's side.

## Test actions

`startTestServer()` returns the server with these actions. The same actions are available over HTTP
under `${origin}/_fake/` for tests written in other languages.

| Action                                                                                                                                            | What happens                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createAccount({ username, name, account_type })`                                                                                                 | A professional account the app can log in as.                                                                                                                                                                      |
| `setNextLogin({ account_id, grant })`                                                                                                             | The next login page allows as that account, optionally granting only some scopes. `{ deny: true }` cancels.                                                                                                        |
| `changeTokens(accountId, { age_hours, expire, revoke, logout })`                                                                                  | Age or expire the account's tokens, or invalidate them as a removed app (`revoke`) or an ended session (`logout`) does.                                                                                            |
| `postMedia(accountId, { caption, media_product_type })`                                                                                           | The account posts outside the app (`FEED`, `REELS` or `STORY`).                                                                                                                                                    |
| `comment(mediaId, { text, username \| person_id \| as_owner, parent_id })`                                                                        | Someone comments or replies; resolves after the webhook was sent, skipped or failed.                                                                                                                               |
| `editComment(commentId, text)`, `deleteComment(commentId)`                                                                                        | The author edits or deletes their comment. Meta sends no webhook for either.                                                                                                                                       |
| `getComment(commentId)`, `getComments(mediaId)`                                                                                                   | A comment's state (`hidden`, `deleted`) and its history: who hid, unhid or deleted it and when.                                                                                                                    |
| `sendMessageToAccount(accountId, { text, attachments, reply_to, reply_to_story, is_unsupported, username \| person_id, hours_ago })`              | Someone messages the account, opening the 24-hour window for the app to reply; see [Professional inbox](#professional-inbox) for attachments. Returns `{ mid, person_id, conversation_id, attachments, webhook }`. |
| `sendAsOwner(accountId, { text, person_id \| username })`                                                                                         | The owner writes from the Instagram app: only a `message_echoes` echo, and no 24-hour window. Returns `{ mid, person_id, webhook }`.                                                                               |
| `redeliverMessage(mid)`                                                                                                                           | Send that message's or echo's webhook again, with the same body and signature.                                                                                                                                     |
| `redeliverWebhook(deliveryId)`                                                                                                                    | Send any delivery again (the `id` from `getWebhook().deliveries` or an action's `webhook`), with the same body and signature.                                                                                      |
| `updatePerson(personId, { is_user_follow_business, is_business_follow_user })`                                                                    | Change who follows whom.                                                                                                                                                                                           |
| `deleteMessage(accountId, mid)`                                                                                                                   | The person unsends their message; the app gets it with `is_deleted`.                                                                                                                                               |
| `reactToMessage(accountId, mid, { action, reaction, emoji })`                                                                                     | The person reacts to a message in the conversation, or (`action: "unreact"`) takes the reaction back.                                                                                                              |
| `setCallLimit(accountId, limit)`                                                                                                                  | Calls the account's tokens may make in 24 hours before Meta's rate-limit error; `null` for no limit.                                                                                                               |
| `getMessages()`                                                                                                                                   | Messages and private replies the app sent.                                                                                                                                                                         |
| `ageComment(commentId, hours)`                                                                                                                    | Backdate a comment, e.g. past the 7-day private-reply limit.                                                                                                                                                       |
| `setContainerStatus(containerId, status)`                                                                                                         | Force a publishing container to `IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED` or `PUBLISHED`.                                                                                                                      |
| `setQuotaUsage(accountId, used)`                                                                                                                  | Use up the account's publishing quota.                                                                                                                                                                             |
| `getContainers()`, `getMedia(accountId)`                                                                                                          | What the app created and published.                                                                                                                                                                                |
| `addFault({ method, path, status, code, subcode, times, apply, drop })`                                                                           | Fail the next matching Graph calls; with `apply`, the change is made but the answer is still an error; with `drop`, the change is made and the connection closes with no answer.                                   |
| `getWebhook()`, `verifyWebhook()`                                                                                                                 | The callback, whether it passed verification, and every delivery attempt.                                                                                                                                          |
| `getCalls()`                                                                                                                                      | Every call the app made, and any Graph calls this server does not model.                                                                                                                                           |
| `createCustomer`, `seedConversation`, `addConversationMessages`, `getConversation`, `getConversations`, `setConversationFolder`, `updateCustomer` | People and history for an account's inbox: see [Professional inbox](#professional-inbox).                                                                                                                          |
| `markSeenByCustomer`, `editMessage`, `sendPostback`, `sendReferral`                                                                               | The person sees, edits, taps a button or opens an ig.me link.                                                                                                                                                      |
| `advanceClock(ms)`, `setAppAccess(...)`, `getAppAccess()`, `setPermissions(...)`                                                                  | Move the server's clock; change the app's standing with Meta; grant or revoke permissions.                                                                                                                         |
| `holdWebhooks()`, `releaseWebhooks({ order })`, `redeliverWebhook(id, { signature })`                                                             | Hold deliveries and send them out of order; resend one unsigned or wrongly signed.                                                                                                                                 |
| `resetMessaging()`                                                                                                                                | Forget every conversation and message; accounts and tokens stay.                                                                                                                                                   |
| `stop()`                                                                                                                                          | Shut the server down.                                                                                                                                                                                              |

## Control API

The test actions above, over HTTP, for tests written in other languages. All routes live under
`${origin}/_fake/` and take and return JSON.

| Route                                                            | Effect                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST accounts`                                                  | Create an account `{ username, name?, account_type? }`.                                                                         |
| `GET accounts/:id`                                               | The account with its tokens and subscribed fields.                                                                              |
| `POST accounts/:id`                                              | `{ extra_quota_usage? , call_limit?, unsubscribe? }`: use up quota, set a call limit, unsubscribe.                              |
| `POST accounts/:id/tokens`                                       | `{ age_hours?, expire?, revoke?, logout? }` for every token of the account.                                                     |
| `POST accounts/:id/media`, `GET` it                              | Post media `{ caption?, media_product_type?, media_type? }`, or list the account's media.                                       |
| `POST accounts/:id/messages`                                     | A person messages the account `{ text?, attachments?, reply_to?, username \| person_id, hours_ago? }`.                          |
| `POST accounts/:id/messages/:mid/delete`                         | The person unsends that message.                                                                                                |
| `POST accounts/:id/messages/:mid/reactions`                      | The person reacts `{ action?, reaction?, emoji? }`.                                                                             |
| `POST people`                                                    | Create a person `{ username, name?, is_user_follow_business?, is_business_follow_user? }`.                                      |
| `POST people/:id`                                                | Change `{ is_user_follow_business?, is_business_follow_user? }`.                                                                |
| `POST accounts/:id/outgoing`                                     | The owner writes from the app `{ text, person_id \| username }`; returns `{ mid, person_id, webhook }`.                         |
| `POST messages/:mid/redeliver`                                   | Send that message's or echo's webhook again; returns `{ mid, status, delivered }`, 404 for a mid never sent.                    |
| `POST webhook/deliveries/:id/redeliver`                          | Send that delivery again `{ signature? }`; returns `{ id, status, delivered }`, 404 for an unknown one, 409 for one never sent. |
| `POST media/:id/comments`, `GET` it                              | Someone comments `{ text, username \| person_id \| as_owner, parent_id? }`, or list the comments.                               |
| `GET comments/:id`                                               | The comment's state and history.                                                                                                |
| `POST comments/:id/edit`, `.../delete`                           | The author edits `{ text }` or deletes the comment.                                                                             |
| `POST comments/:id/age`                                          | Backdate the comment `{ hours }`.                                                                                               |
| `POST login/next`                                                | How the next login answers `{ account_id, grant? }` or `{ deny: true }`.                                                        |
| `GET containers`, `GET containers/:id`                           | Publishing containers.                                                                                                          |
| `POST containers/:id`                                            | Force a container's `{ status_code }`.                                                                                          |
| `GET webhook`, `POST webhook/verify`                             | The callback and its deliveries, or run Meta's verification handshake.                                                          |
| `GET messages`                                                   | Messages and private replies the app sent.                                                                                      |
| `POST faults`, `DELETE faults`                                   | Fail the next matching calls `{ method?, path?, status?, code?, subcode?, message?, times?, apply?, drop? }`.                   |
| `GET calls`                                                      | Every Graph call with its status, every webhook attempt, and the Graph calls this server does not model.                        |
| `GET clock`, `POST clock`                                        | The server's time, or move it forward `{ advance_ms }`.                                                                         |
| `GET app`, `POST app`                                            | The app's standing `{ mode?, access_level?, business_verified?, human_agent? }`.                                                |
| `POST accounts/:id/permissions`                                  | `{ grant?, revoke? }`: permission names, on every token of the account.                                                         |
| `POST accounts/:id/customers`, `GET` / `POST .../customers/:cid` | A person scoped to the account `{ username, id?, has_app_role?, ... }`, or change one.                                          |
| `POST accounts/:id/conversations`, `GET` it                      | Seed a conversation `{ id?, customer_id \| username, folder?, messages? }`, or list them.                                       |
| `GET` / `POST accounts/:id/conversations/:cid`                   | The conversation's state, or move it `{ folder }`.                                                                              |
| `POST accounts/:id/conversations/:cid/messages`                  | Seed more history `{ messages }`.                                                                                               |
| `POST accounts/:id/messages/:mid/seen`, `.../edit`               | The person sees the account's message, or edits theirs `{ text }`.                                                              |
| `POST accounts/:id/postbacks`, `.../referrals`                   | `{ person_id \| username, title, payload }`, or `{ person_id \| username, ref, source? }`.                                      |
| `POST webhook/hold`, `POST webhook/release`                      | Hold deliveries; release them `{ order: "sent" \| "reverse" \| [ids] }`.                                                        |
| `POST messaging/reset`                                           | Forget every conversation and message.                                                                                          |

## What it models

- **Login and tokens** ([Business Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login), [long-lived tokens](https://developers.facebook.com/docs/instagram-platform/reference/access_token)). The authorize page with `state`, one-time codes bound to the redirect URI,
  short-lived tokens, the long-lived exchange, and refresh, which is refused for tokens under 24 hours
  old. Tokens carry the scopes the person granted; a call outside them fails with Meta's permission
  error.
- **Errors in Meta's shapes** ([error codes](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes), [Graph API errors](https://developers.facebook.com/docs/graph-api/guides/error-handling)). `{ error: { message, type, code, error_subcode, fbtrace_id } }`, with
  the variants Meta actually returns for a missing token (`IGApiException`, code 190), an unparseable
  one, a revoked one (subcode 460) and an expired one (subcode 463), and the `www-authenticate` header.
  As on Meta, the token is checked before the path.
- **Accounts.** `id` is the app-scoped id and `user_id` the professional account id that webhooks
  use, as on Meta; both address the account.
- **Fields.** `fields` with expansion, such as `from{id,username}`, `media{media_product_type}` and
  `replies{text}`. Paths work with or without a version prefix.
- **Comments** ([comments](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation), [paging](https://developers.facebook.com/docs/graph-api/results)). Cursor pagination (at most 50 per page) that survives deletions, replies threaded one
  level deep, hiding and unhiding (`hide` is read from the query string only; the media owner's own
  comments stay visible; hidden comments take no replies), and deleting, which removes the replies too.
- **Webhooks** ([Instagram webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks), [getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)). Meta's `hub.challenge` handshake before the first delivery, `comments` events only for
  accounts subscribed through `subscribed_apps`, the body signed with the app secret in
  `X-Hub-Signature-256`, non-ASCII characters escaped exactly as Meta sends them, and retries after a
  failed delivery.
- **Publishing** ([content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing)). Containers for images, reels and stories, status polling, `media_publish`, the
  publishing limit, and the errors for publishing too early, twice or over quota.
- **Carousels.** Item containers (`is_carousel_item`, images or videos) and a `CAROUSEL` container
  of 2 to 10 of them, which finishes when every item has and fails when one does. It publishes as one
  `CAROUSEL_ALBUM` post counted once against the quota, with its items under `children`; the items
  cannot be published alone, are not listed as the account's media and take no comments.
- **Mentions.** A comment or caption that tags an account with `@username`, on media it does not
  own, sends that account a `mentions` change with the comment and media ids (or the media id
  alone for a caption). The account reads it through `mentioned_comment.comment_id(<id>){...}` or
  `mentioned_media.media_id(<id>){...}` on itself, since its token cannot read the other account's
  objects directly.
- **Messages** ([messaging](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api), [private replies](https://developers.facebook.com/docs/instagram-platform/private-replies)). People message the account, which sends a `messages` webhook to subscribed accounts.
  The app may answer only within 24 hours of the person's last message, and may read the person's
  profile only after they messaged. A private reply to a comment needs the comments permission, goes to
  the commenter, and is allowed once per comment within 7 days. Meta documents these rules but not the
  error for breaking the private-reply ones; this server answers code 10, subcode 2534022, the
  documented messaging-window error.
- **A professional account's inbox**: conversations, history, reply windows, access levels and
  more messaging webhooks, under [Professional inbox](#professional-inbox).
- **Messaging webhooks.** A person's messages arrive under `messages` with their `attachments` and
  `reply_to`, and an unsent one as `is_deleted`. Every message the app sends comes back under
  `message_echoes` with `is_echo: true`, and reactions under `message_reactions`, each only to
  accounts subscribed to that field. Subscribing to a field Meta does not have fails.
- **What a DM assistant sees.** The User Profile API returns `is_user_follow_business` and
  `is_business_follow_user` under the same consent rule as the other fields. The owner writing from
  the Instagram app reaches the app only as a `message_echoes` echo and opens no reply window. An
  echo of an API send carries the `mid` the send returned. A delivered message or echo can be sent
  again, with the same body and signature, as Meta's retries are. Unverified: that app-typed
  messages produce echoes, and that retries are byte-for-byte the same.
- **Rate limits** ([rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)). Every call with a valid token answers with Meta's `X-Business-Use-Case-Usage`
  header for its account. With `setCallLimit`, calls over the limit in 24 hours fail with code 80002
  and the header's `estimated_time_to_regain_access`. Private replies are limited to 750 an hour and
  Send API messages to 100 a second (code 613, subcode 2534040). App-level throttling (codes 4, 17, 32) is an injected fault: `addFault` takes a `subcode`.

## Professional inbox

What a business inbox needs from an Instagram professional account (`BUSINESS` or `MEDIA_CREATOR`;
there is no personal account here, as Instagram Login serves professional accounts only): its
conversations and their history, messages from people, answers within Meta's windows, and the
webhooks for all of it.

Checked against Meta's documentation on 2026-09-30:
[Conversations API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api),
[messaging](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api),
[sender actions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/sender-actions),
[webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples),
[Instagram webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks),
[access levels](https://developers.facebook.com/documentation/instagram-platform/overview),
[Human Agent](https://developers.facebook.com/documentation/development/features-reference/human-agent),
[Message reference](https://developers.facebook.com/docs/graph-api/reference/v26.0/message),
[Page Messages reference](https://developers.facebook.com/docs/graph-api/reference/page/messages),
[messaging error codes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes) and
[rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting). Field shapes
Meta publishes only for Messenger's Instagram messaging (the Message reference) are used for Instagram
Login too; where Meta is silent, the choice is listed under [Unverified](#unverified).

**Access.** Reading conversations and sending need `instagram_business_basic` and
`instagram_business_manage_messages`; without them Graph answers code 10. `setAppAccess` sets the
app's standing: `mode` (`live` or `development`), `access_level` (`advanced` or `standard`),
`business_verified` and `human_agent`. The default is a Live app with Advanced Access and a verified
business, as earlier versions assumed; Advanced Access and the Human Agent feature both need Business
Verification. A Live app is needed for any webhook. Under Standard Access the app sees and messages
only people with a role on the app (`has_app_role`), gets messaging webhooks only about them, and gets
no `comments` webhooks. `setPermissions(accountId, { grant, revoke })` changes what the account's
tokens may do, and `changeTokens` expires or revokes them.

**People.** A person's id (IGSID) is scoped to the account they message, as on Meta: the same id on two
accounts is two people, and one account's token cannot reach another's. `createCustomer(accountId,
{ username, id?, has_app_role? })` makes one; `sendMessageToAccount` with a `username` makes a new one.

**Graph calls.**

| Call                                                       | Answers                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/conversations` (or `/{ig-user-id}/conversations`) | The account's conversations, most recently active first. `platform=instagram` is optional; `user_id` finds one person's. Fields `id`, `updated_time` (the default), `participants` and `messages`.                                                        |
| `GET /{conversation-id}`                                   | The conversation; with `fields=messages`, the first page of its messages.                                                                                                                                                                                 |
| `GET /{conversation-id}/messages`                          | Its messages, newest first. Every id is listed; other fields only for the 20 most recent.                                                                                                                                                                 |
| `GET /{message-id}`                                        | `id`, `created_time` (the default), `from`, `to`, `message`, `attachments` (`image_data`, `video_data`, `file_url`), `shares`, `story` (`mention`), `reactions`, `reply_to` and `is_unsupported`. Older than the 20 most recent, or unsent: code 9000001. |
| `POST /me/messages`                                        | A message, within 24 hours of the person's last one; with `messaging_type: "MESSAGE_TAG"` and `tag: "HUMAN_AGENT"`, within 7 days, once the app has the Human Agent feature. Other tags: code 100.                                                        |
| `POST /me/messages` with `sender_action`                   | `typing_on`, `typing_off`, `mark_seen`, and `react` / `unreact` with `payload: { message_id, reaction: "love" }`. Only `recipient` and `sender_action` (and a reaction's `payload`); answers `{ recipient_id }` and sends no echo.                        |

Any other field on a conversation or message, the `folder` parameter, another `platform`, and any
other edge fail with code 100. Paths work with any version prefix.

**Order and paging.** Newest first, and by id when times are equal, the same on every read. Pages
carry Meta's `data` and `paging.cursors`, with `next` and `previous` links; 25 a page by default, at
most 100. A cursor names a position in one account's one listing, so a cursor from another account or
listing fails with code 100. Paging is live, not a snapshot, and Meta does not promise a snapshot
either: a message that arrives between pages comes before the first page, so older pages neither
repeat nor skip; a conversation that becomes active moves to the front, and one not read yet is then
reached only by reading the list again.

**Folders.** A new conversation starts in Requests and moves to General when the app answers. A
Requests conversation inactive for 30 days is no longer returned. There are no other folders.

**Windows and limits.** The 24-hour window and the 7-day Human Agent window run from the person's last
message. The Conversations API allows 2 calls a second per account (code 613), and the Send API 100 a
second (code 613, subcode 2534040); every call reports `X-Business-Use-Case-Usage`.

**What a person does**, each as Meta's webhook to accounts subscribed to its field:

| Action                                                        | Webhook                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sendMessageToAccount(accountId, { text, attachments })`      | `messages`. Attachments: `image`, `video`, `audio`, `file`, `share`, `ig_post`, `ig_reel`, `reel`, `story_mention`, `ephemeral`. |
| `sendMessageToAccount(accountId, { reply_to_story })`         | `messages` with `reply_to.story { url, id }`.                                                                                    |
| `sendMessageToAccount(accountId, { is_unsupported: true })`   | `messages` with `is_unsupported`.                                                                                                |
| `deleteMessage(accountId, mid)`                               | `messages` with `is_deleted`.                                                                                                    |
| `editMessage(accountId, mid, text)`                           | `message_edit { mid, text, num_edit }`.                                                                                          |
| `reactToMessage(accountId, mid, { action, reaction, emoji })` | `message_reactions`.                                                                                                             |
| `markSeenByCustomer(accountId, mid)`                          | `messaging_seen { read: { mid } }`, for a message the account sent. Instagram has no delivery events.                            |
| `sendPostback(accountId, { person_id, title, payload })`      | `messaging_postbacks { postback: { mid, title, payload } }`.                                                                     |
| `sendReferral(accountId, { person_id, ref, source })`         | `messaging_referral { referral: { ref, source, type: "OPEN_THREAD" } }`.                                                         |

An attachment with a `url` keeps it. Without one, the file is served by this server at a CDN-style URL
that works for 24 hours (or `expires_in_ms`) on the server's clock, then answers 403; it answers 404
once the message is unsent, or from the start with `unavailable: true`. `ig_post` takes
`ig_post_media_id` and `title`, the reels `reel_video_id` and `title`, `story_mention` a `story_id`.

**History.** `seedConversation(accountId, { id?, customer_id | username, folder?, messages })` and
`addConversationMessages(accountId, conversationId, messages)` set up history without webhooks. A
message is `{ id?, from: "customer" | "business", text?, created_time?, attachments?, reply_to?,
reply_to_story?, reactions?, is_unsupported?, seen? }`, with `created_time` in milliseconds or ISO.
Conversation and message ids are the account's own: two accounts can use the same ids without sharing
anything. `getConversation` shows the whole state, including unsent messages, edits and who has seen
what; `setConversationFolder` moves it.

**Time.** `advanceClock(ms)` moves the server's clock forward: the reply windows, the Requests rule,
token lifetimes, rate-limit windows and attachment URLs all follow it.

**Deliveries.** Every delivery is signed with the app secret. `redeliverWebhook(id)` sends one again,
byte for byte, which is how Meta retries; with `{ signature: "missing" }` or `{ signature: "invalid" }`
it goes unsigned or wrongly signed, for testing that the receiver refuses it. `holdWebhooks()` keeps
deliveries back until `releaseWebhooks({ order })` sends them in the order made (`"sent"`), in
`"reverse"`, or by delivery id; each keeps its own `timestamp`, which Meta says to order by.

**Failures.** `addFault` fails matching Graph calls with any status and code, including 5xx and rate
limits; with `drop`, the send is made and the connection closes with no answer, so the app must find
out from the conversation whether it went.

**The calls ledger.** `getCalls()` lists every Graph call (method, path, parameter names and status)
and every webhook attempt (delivery, field, account, time, status and signature mode). It records no
tokens, signatures, app secret or message text.

**Reset.** `resetMessaging()` forgets conversations, messages, people scoped to accounts, attachments
and held webhooks. Accounts, tokens, media, comments, subscriptions and the logs stay.

**For a unified inbox.** Everything above is per account and per provider id, so an app's tests can
check that its conversation and message references carry the connection they came from, that a
missing permission becomes a disabled capability rather than a silent no-op (revoke it with
`setPermissions` and look for code 10), and that changing only how the inbox is shown makes no Graph
call (compare `getCalls()` before and after).

### Upgrading to 0.5.0

- `createAccount` refuses any `account_type` but `BUSINESS` and `MEDIA_CREATOR`.
- An incoming attachment without a `url` gets a URL served by this server, which expires after 24
  hours on its clock, instead of an address on Meta's CDN.
- A person created by `sendMessageToAccount` or `sendAsOwner` with a `username` belongs to that account
  only. People from `createPerson` still work with every account.
- `getCalls()` adds `status` to each call and a `webhooks` list.
- Messaging webhooks go only from a Live app, and under Standard Access only about people with a role
  on the app; the defaults (Live, Advanced Access) behave as before.
- The Conversations API allows 2 calls a second per account. A test that pages quickly can move the
  clock with `advanceClock(500)` between calls.

## What it does not do

- Attachment uploads, quick replies, templates, icebreaker and menu setup, Conversation Routing
  (`is_owner`, handover), and the `folder` parameter of `/conversations`, for which Meta documents no
  values.
- Meta's real call budget, which depends on the account's impressions: there is no limit until a
  test sets one.
- `live_comments` and story webhooks; insights; hashtags; business discovery; Facebook Login for
  Business (`graph.facebook.com`).
- **Media downloads, unless you ask.** Meta downloads the file a container names. This server only does
  that with `downloadMedia: true`, because it then requests whatever URL the app sends.
- **Every detail Meta leaves undocumented.** Where Meta's documentation is silent or contradicts
  itself, this server makes a choice, listed under [Unverified](#unverified). It is a test tool, not
  a guarantee of how Meta will answer.
- Anything security-related. Bind it to localhost and never expose it to a network you do not control.

## Unverified

Where Meta's documentation is silent or contradicts itself, this server makes the choice below. A
test that depends on one of these checks this server, not Meta; confirm it against Meta once before
relying on it.

| Behaviour                                                         | What this server does                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error for an unknown path, field or object on graph.instagram.com | Unknown call: 400, code 100. Unknown object: 400, code 100, subcode 33, the widely reported Graph wording.                                                                                                                                            |
| HTTP status of error codes 4, 17, 32, 613, 190 and 80002          | 400. The permission error (code 10) is 403, as in Meta's Instagram error table.                                                                                                                                                                       |
| Hiding the media owner's own comment                              | Succeeds, and the comment stays visible, as documented; the exact answer is not.                                                                                                                                                                      |
| Replying to a hidden comment                                      | 400, code 100.                                                                                                                                                                                                                                        |
| A second private reply to a comment, or one after 7 days          | Code 10, subcode 2534022, the documented messaging-window error.                                                                                                                                                                                      |
| Reading a profile without the person's consent                    | Code 100 with Meta's documented text; the code is not documented.                                                                                                                                                                                     |
| Refreshing a token under 24 hours old                             | 400, code 100; `expires_in` after a refresh is 60 days.                                                                                                                                                                                               |
| `GET /me`                                                         | Wrapped in `data`, as Meta's get-started example shows.                                                                                                                                                                                               |
| The `comments` webhook envelope                                   | `changes[]` with `value.id`, as in the Facebook Login example and reported deliveries.                                                                                                                                                                |
| Webhook timeout, signatures and retries                           | 5-second timeout; both `X-Hub-Signature` and `X-Hub-Signature-256`; HMAC over the body with non-ASCII escaped; retries immediately, again, after 2 s and after 5 s (Meta retries for up to 36 hours). Redelivered bodies are byte-for-byte the first. |
| Daily publishing limit                                            | 100, as the content-publishing guide says; the reference pages say 50.                                                                                                                                                                                |
| Usage headers                                                     | Only `X-Business-Use-Case-Usage`, keyed by the professional account id; no `X-App-Usage`.                                                                                                                                                             |
| Business Use Case limit error                                     | 400, code 80002.                                                                                                                                                                                                                                      |
| Comment paging                                                    | 25 per page by default, at most 50, with `paging.next`.                                                                                                                                                                                               |
| A container's `status` on `ERROR`                                 | `Error: Media upload has failed with error code <subcode>`.                                                                                                                                                                                           |
| `mentions`                                                        | Facebook Login's webhook shape and `mentioned_comment` / `mentioned_media` fields; Meta documents mentions only for Facebook Login.                                                                                                                   |
| A misused carousel                                                | Plain code-100 errors; Meta documents only the 2 to 10 item error.                                                                                                                                                                                    |
| Messages the owner types in the Instagram app                     | Sent as `message_echoes`; Meta documents echoes for the business's messages without naming the app.                                                                                                                                                   |
| The Human Agent tag used without the feature, or after 7 days     | 403, code 10 without the feature; code 10, subcode 2534022 after 7 days. Meta does not document either error.                                                                                                                                         |
| Conversations paging                                              | 25 a page by default, at most 100; `paging` with `cursors`, `next` and `previous`; live paging, as described under [Professional inbox](#professional-inbox). Meta documents none of these for Instagram.                                             |
| Message order and times                                           | Newest first, ties by id; `updated_time` and `created_time` as `2026-09-30T12:00:00+0000`. Meta's samples imply newest first and mix Unix and ISO times.                                                                                              |
| A message older than the 20 most recent, or unsent                | 400, code 9000001, "This Message has been deleted by the user or the business."; Meta says only that the error says the message was deleted. Listings leave unsent messages out.                                                                      |
| Where a new conversation starts                                   | Requests. Meta documents only that the app's answer moves it to General.                                                                                                                                                                              |
| Attachment URLs                                                   | Served URLs work for 24 hours, then 403 "URL signature expired"; 404 once unsent. Meta documents only that they stop working.                                                                                                                         |
| `video_data`, audio and files through the API                     | `video_data { url, preview_url }`; audio and files as `file_url`. Meta documents neither the `video_data` keys nor audio. `image_data` sizes are 1080 unless set.                                                                                     |
| `shares` for a `share` attachment                                 | `type: "post"`; the other share types keep their names. Meta lists the types without saying which webhook type becomes which.                                                                                                                         |
| Sender actions                                                    | Answer `{ recipient_id }`, need an existing conversation, and take `love` as the only reaction. Meta documents the answer only for Messenger and for reactions.                                                                                       |
| Standard Access                                                   | Conversations with people without a role on the app are left out of listings; sending to them is code 200 in Messenger's wording.                                                                                                                     |
| Postbacks                                                         | Also open the 24-hour window; Meta documents only that they give profile consent.                                                                                                                                                                     |
| `num_edit` in `message_edit`                                      | A number; Meta's sample shows a placeholder.                                                                                                                                                                                                          |
| The `ig_reel` and `reel` payload                                  | `{ reel_video_id, title, url }`, from Messenger's `messages` reference.                                                                                                                                                                               |
| Send API rate                                                     | 100 a second, as the Instagram Login pages say; newer Messenger API for Instagram pages say 300.                                                                                                                                                      |

## Changes

- **0.5.0**: a professional account's inbox: the Conversations API with paging, message details,
  reactions and replies; people scoped to accounts; seeded history; the Human Agent tag and sender
  actions; seen, edit, postback and referral webhooks, story replies and mentions, `ig_post` and
  `ephemeral` attachments; attachment URLs that expire; the app's access level, Live mode and Business
  Verification; granting and revoking permissions; a server clock; held and out-of-order webhooks,
  unsigned or wrongly signed redeliveries; the Conversations API rate limit; webhook attempts and
  statuses in the calls ledger; `resetMessaging`. See [Upgrading to 0.5.0](#upgrading-to-050).
- **0.4.1**: describes the package as a local test server.
- **0.4.0**: every webhook delivery can be sent again (`redeliverWebhook`), a fault that makes the
  change and drops the connection without an answer (`drop`), an Unverified list with each choice
  this server makes where Meta is silent, and doc links for each rule.
- **0.3.0**: follow flags on people, the owner writing from the app (`POST accounts/:id/outgoing`),
  and redelivery of message and echo webhooks.
- **0.2.0**: messaging webhooks for attachments, replies, unsent messages, echoes and reactions;
  subscribed fields checked against Meta's list; the usage header, call limits and Meta's messaging
  rate limits; injected faults take a subcode; carousels; mentions; a command-line section and the
  Control API routes in this README.

## Development

```sh
pnpm install
pnpm test
```

## Status

This is an early-stage project with a deliberately small scope, and the API may still change.

## License

MIT
