const { RESTJSONErrorCodes } = require('discord.js');
const { missingBotPermissions } = require('./permissions');

const REMOVABLE_ERROR_CODES = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
]);

class DeletionScheduler {
  constructor({ client, db, logger = console, intervalMs = 1000, batchSize = 25 }) {
    this.client = client;
    this.db = db;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error('Scheduler tick failed:', error));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = this.db.getDueJobs(Date.now(), this.batchSize);
      for (const job of jobs) {
        await this.processJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  async processJob(job) {
    const channelConfig = this.db.getConfig(job.guild_id, job.channel_id);
    if (!channelConfig || !channelConfig.enabled) {
      this.db.deleteJob(job.id);
      return;
    }

    let channel;
    try {
      channel = this.client.channels.cache.get(job.channel_id)
        || await this.client.channels.fetch(job.channel_id);
    } catch (error) {
      if (REMOVABLE_ERROR_CODES.has(error.code)) {
        this.db.deleteJob(job.id);
        return;
      }
      this.postpone(job, this.backoff(job.attempts), true);
      this.logger.warn(`Could not fetch channel ${job.channel_id}; will retry: ${error.message}`);
      return;
    }

    if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
      this.db.deleteJob(job.id);
      return;
    }

    const me = channel.guild?.members?.me;
    if (me) {
      const missing = missingBotPermissions(channel, me);
      if (missing.length > 0) {
        this.postpone(job, 5 * 60_000, true);
        this.logger.warn(`Missing permissions in #${channel.name || job.channel_id}; postponing deletion.`);
        return;
      }
    }

    try {
      await channel.messages.delete(job.message_id);
      this.db.deleteJob(job.id);
    } catch (error) {
      if (REMOVABLE_ERROR_CODES.has(error.code)) {
        this.db.deleteJob(job.id);
        return;
      }

      if (error.code === RESTJSONErrorCodes.MissingPermissions) {
        this.postpone(job, 5 * 60_000, true);
        this.logger.warn(`Missing permissions while deleting in #${channel.name || job.channel_id}; retrying later.`);
        return;
      }

      if (error.name === 'RateLimitError') {
        const retryAfter = Number(error.retryAfter) || 5000;
        this.postpone(job, Date.now() + retryAfter, false);
        return;
      }

      const attempts = job.attempts + 1;
      if (attempts >= 5) {
        this.db.deleteJob(job.id);
        this.logger.error(`Giving up deleting message ${job.message_id}: ${error.message}`);
        return;
      }

      this.postpone(job, this.backoff(attempts), true);
      this.logger.warn(`Delete failed for message ${job.message_id}; retrying: ${error.message}`);
    }
  }

  backoff(attempts) {
    return Date.now() + Math.min(15 * 60_000, 5_000 * 2 ** attempts);
  }

  postpone(job, delayMsOrTime, incrementAttempts) {
    const dueAt = delayMsOrTime > Date.now() ? delayMsOrTime : Date.now() + delayMsOrTime;
    const attempts = incrementAttempts ? job.attempts + 1 : job.attempts;
    this.db.postponeJob(job.id, dueAt, attempts);
  }
}

module.exports = { DeletionScheduler };
