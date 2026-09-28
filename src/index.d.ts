export interface AppConfig {
  /** The Meta app id (client_id). */
  id: string;
  /** The app secret: signs webhooks and authenticates the code exchange. */
  secret: string;
  /** Redirect URIs the login flow may send the person back to. */
  redirectUris: string[];
}

export interface TestServerOptions {
  app: AppConfig;
  /** Default 0 (any free port). */
  port?: number;
  /** Default "127.0.0.1". */
  host?: string;
  /** Where comment webhooks go, after Meta's GET verification handshake passes. */
  webhook?: { callbackUrl: string; verifyToken: string } | null;
  /**
   * Fetch the media URL a publishing container names, as Meta does, and fail
   * the container when it is not a JPEG image or MP4/MOV video. Off by default,
   * because it makes this server request whatever URL the app sends.
   */
  downloadMedia?: boolean;
  /** Rewrite media URL origins before downloading, e.g. a public CDN to a local server. */
  mediaOrigins?: Record<string, string>;
  /** Status polls a video container needs before it reports FINISHED. Default 1. */
  videoPollsUntilFinished?: number;
  log?: (line: string) => void;
}

/** Plain objects in the Graph API's own shapes. */
export type GraphObject = { id: string; [field: string]: unknown };

export interface CommentState extends GraphObject {
  text: string;
  hidden: boolean;
  deleted: boolean;
  parent_id?: string;
  /** Who did what to the comment: created, hidden, unhidden, edited, deleted. */
  history: Array<{
    action: string;
    by: string;
    at: string;
    [detail: string]: unknown;
  }>;
  replies?: CommentState[];
  /** On comments created by comment(): what happened to the webhook for it. */
  webhook?: WebhookDelivery;
}

export interface WebhookDelivery {
  field: "comments" | "messages";
  commentId?: string;
  messageId?: string;
  accountId: string;
  attempts: Array<{ at: string; status?: number; error?: string }>;
  delivered?: boolean;
  skipped?: string;
}

/**
 * The running server. Point the app's Instagram hosts at `origin`. The actions
 * below are also available over HTTP under `${origin}/_fake/`.
 */
export interface TestServer {
  origin: string;
  /** A professional account the app can log in as. */
  createAccount(fields: {
    username: string;
    name?: string;
    account_type?: "BUSINESS" | "MEDIA_CREATOR";
    followers_count?: number;
  }): Promise<GraphObject>;
  /** The account with its subscriptions, quota usage and tokens. */
  getAccount(accountId: string): Promise<GraphObject>;
  /** Media the account posted outside the app. */
  postMedia(
    accountId: string,
    fields?: {
      caption?: string;
      media_product_type?: "FEED" | "REELS" | "STORY";
      media_type?: string;
    },
  ): Promise<GraphObject>;
  getMedia(accountId: string): Promise<GraphObject[]>;
  /** Someone who can comment or message. Their id is an Instagram-scoped id (IGSID). */
  createPerson(fields: {
    username: string;
    name?: string;
  }): Promise<{ id: string; username: string; name: string | null }>;
  /**
   * The person messages the account (a new person when only username is given),
   * opening the 24-hour window for the app to reply. hours_ago backdates it.
   * A message needs text or attachments; reply_to is the mid it answers.
   */
  sendMessageToAccount(
    accountId: string,
    fields: {
      text?: string;
      attachments?: Array<{
        type:
          | "image"
          | "video"
          | "audio"
          | "file"
          | "share"
          | "story_mention"
          | "ig_reel";
        url?: string;
      }>;
      reply_to?: string;
      username?: string;
      person_id?: string;
      hours_ago?: number;
    },
  ): Promise<{ mid: string; person_id: string; webhook: WebhookDelivery }>;
  /** The person unsends their message; the app gets it with is_deleted. */
  deleteMessage(
    accountId: string,
    mid: string,
  ): Promise<{ webhook: WebhookDelivery }>;
  /**
   * The person in the conversation reacts to a message (default "love", ❤️),
   * or takes the reaction back with action "unreact".
   */
  reactToMessage(
    accountId: string,
    mid: string,
    reaction?: {
      action?: "react" | "unreact";
      reaction?: string;
      emoji?: string;
    },
  ): Promise<{ webhook: WebhookDelivery }>;
  /**
   * Calls the account's tokens may make in 24 hours before Meta's code 80002,
   * or null for no limit. Setting it starts the count again.
   */
  setCallLimit(accountId: string, limit: number | null): Promise<unknown>;
  /** Backdate a comment by some hours, e.g. past the 7-day private-reply limit. */
  ageComment(commentId: string, hours: number): Promise<CommentState>;
  /**
   * A comment on the media: by a new person (username), an existing one
   * (person_id) or the account itself (as_owner), optionally replying to
   * parent_id. Resolves after the webhook for it was sent, skipped or failed.
   */
  comment(
    mediaId: string,
    fields: {
      text: string;
      username?: string;
      person_id?: string;
      as_owner?: boolean;
      parent_id?: string;
    },
  ): Promise<CommentState>;
  /** Top-level comments on the media, with their replies, including deleted ones. */
  getComments(mediaId: string): Promise<CommentState[]>;
  getComment(commentId: string): Promise<CommentState>;
  /** The author edits the comment. Meta sends no webhook for an edit. */
  editComment(commentId: string, text: string): Promise<CommentState>;
  /** The author deletes the comment. */
  deleteComment(commentId: string): Promise<CommentState>;
  /** How the next login page answers: allow as an account (optionally only some scopes), or deny. */
  setNextLogin(answer: {
    account_id?: string;
    grant?: string[];
    deny?: boolean;
  }): Promise<unknown>;
  /** Age, expire or revoke every token of the account. */
  changeTokens(
    accountId: string,
    change: {
      age_hours?: number;
      expire?: boolean;
      /** The person removed the app: subcode 458. */
      revoke?: boolean;
      /** The session ended, e.g. a password change: subcode 460. */
      logout?: boolean;
    },
  ): Promise<unknown>;
  /** Count extra publications against the account's quota. */
  setQuotaUsage(accountId: string, used: number): Promise<unknown>;
  /** Force a publishing container into a status. */
  setContainerStatus(
    containerId: string,
    statusCode: "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "EXPIRED" | "ERROR",
  ): Promise<GraphObject>;
  getContainer(containerId: string): Promise<GraphObject>;
  getContainers(): Promise<GraphObject[]>;
  /** The webhook callback, whether it passed verification, and every delivery. */
  getWebhook(): Promise<{
    callback_url: string | null;
    verified: boolean;
    verify_error: string | null;
    deliveries: WebhookDelivery[];
  }>;
  /** Run Meta's verification handshake against the callback now. */
  verifyWebhook(): Promise<boolean>;
  /** Messages the app sent. */
  getMessages(): Promise<GraphObject[]>;
  /**
   * Fail the next matching Graph calls: path is a regular expression; with
   * apply, the change is made but the answer is still an error.
   */
  addFault(fault: {
    method?: string;
    path?: string;
    status?: number;
    message?: string;
    code?: number;
    subcode?: number;
    times?: number;
    apply?: boolean;
  }): Promise<unknown>;
  clearFaults(): Promise<unknown>;
  /** Every call the app made, and any Graph calls this server does not model. */
  getCalls(): Promise<{ calls: GraphObject[]; unimplemented: string[] }>;
  stop(): Promise<void>;
}

export declare function startTestServer(
  options: TestServerOptions,
): Promise<TestServer>;
