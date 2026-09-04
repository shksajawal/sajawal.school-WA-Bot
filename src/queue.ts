import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Raw webhook payloads, one job per change value. */
export const inboundQueue = new Queue("inbound", { connection });

/** Debounced bot replies. */
export const replyQueue = new Queue("reply", { connection });

/** Delayed follow-up touches. */
export const followupQueue = new Queue("followup", { connection });

export interface InboundJob {
  value: unknown;
}

export interface ReplyJob {
  contactId: number;
  /** The inbound message row that triggered this job — used for debouncing. */
  afterMessageId: number;
}

export interface FollowupJob {
  contactId: number;
  touch: number;
  /** ISO timestamp of last_user_msg_at when scheduled — skip if the user has replied since. */
  lastUserMsgAt: string;
}

const REPLY_DEBOUNCE_MS = 6000;

export async function enqueueReply(job: ReplyJob): Promise<void> {
  await replyQueue.add("reply", job, {
    delay: REPLY_DEBOUNCE_MS,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

export async function scheduleFollowup(job: FollowupJob, delayMs: number): Promise<void> {
  await followupQueue.add("followup", job, {
    delay: delayMs,
    // BullMQ rejects custom ids containing ":" — the ISO timestamp in the old
    // id made EVERY followup add throw (silently caught upstream), so no
    // follow-up ever fired before 2026-09-05. Digits only now.
    jobId: `fu-${job.contactId}-${job.touch}-${Date.parse(job.lastUserMsgAt)}`,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}
