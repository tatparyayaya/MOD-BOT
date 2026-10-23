const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS channel_configs (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      delay_seconds INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      exclude_bots INTEGER NOT NULL DEFAULT 1,
      last_seen_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS deletion_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (channel_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_deletion_jobs_due ON deletion_jobs (due_at);

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const statements = {
    getConfig: db.prepare('SELECT * FROM channel_configs WHERE guild_id = ? AND channel_id = ?'),
    listConfigs: db.prepare('SELECT * FROM channel_configs WHERE guild_id = ? ORDER BY created_at ASC'),
    listEnabledConfigs: db.prepare('SELECT * FROM channel_configs WHERE enabled = 1'),
    upsertConfig: db.prepare(`
      INSERT INTO channel_configs
        (guild_id, channel_id, delay_seconds, enabled, exclude_bots, last_seen_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, NULL, ?, ?)
      ON CONFLICT (guild_id, channel_id) DO UPDATE SET
        delay_seconds = excluded.delay_seconds,
        enabled = 1,
        exclude_bots = excluded.exclude_bots,
        updated_at = excluded.updated_at
    `),
    setEnabled: db.prepare('UPDATE channel_configs SET enabled = ?, updated_at = ? WHERE guild_id = ? AND channel_id = ?'),
    setAllEnabled: db.prepare('UPDATE channel_configs SET enabled = ?, updated_at = ? WHERE guild_id = ?'),
    removeConfig: db.prepare('DELETE FROM channel_configs WHERE guild_id = ? AND channel_id = ?'),
    removeJobsForChannel: db.prepare('DELETE FROM deletion_jobs WHERE guild_id = ? AND channel_id = ?'),
    setLastSeen: db.prepare('UPDATE channel_configs SET last_seen_id = ? WHERE guild_id = ? AND channel_id = ?'),
    addJob: db.prepare(`
      INSERT OR IGNORE INTO deletion_jobs (guild_id, channel_id, message_id, due_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    dueJobs: db.prepare(`
      SELECT j.* FROM deletion_jobs j
      INNER JOIN channel_configs c
        ON c.guild_id = j.guild_id AND c.channel_id = j.channel_id
      WHERE c.enabled = 1 AND j.due_at <= ?
      ORDER BY j.due_at ASC
      LIMIT ?
    `),
    deleteJob: db.prepare('DELETE FROM deletion_jobs WHERE id = ?'),
    postponeJob: db.prepare('UPDATE deletion_jobs SET due_at = ?, attempts = ? WHERE id = ?'),
    countJobsForChannel: db.prepare('SELECT COUNT(*) AS count FROM deletion_jobs WHERE guild_id = ? AND channel_id = ?'),
    getState: db.prepare('SELECT value FROM bot_state WHERE key = ?'),
    setState: db.prepare(`
      INSERT INTO bot_state (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `),
  };

  return {
    raw: db,

    getConfig(guildId, channelId) {
      return statements.getConfig.get(guildId, channelId);
    },

    listConfigs(guildId) {
      return statements.listConfigs.all(guildId);
    },

    listEnabledConfigs() {
      return statements.listEnabledConfigs.all();
    },

    upsertConfig({ guildId, channelId, delaySeconds, excludeBots = true }) {
      const now = Date.now();
      statements.upsertConfig.run(
        guildId,
        channelId,
        delaySeconds,
        excludeBots ? 1 : 0,
        now,
        now,
      );
    },

    setEnabled(guildId, channelId, enabled) {
      const result = statements.setEnabled.run(enabled ? 1 : 0, Date.now(), guildId, channelId);
      if (!enabled) {
        statements.removeJobsForChannel.run(guildId, channelId);
      }
      return result.changes > 0;
    },

    setAllEnabled(guildId, enabled) {
      const result = statements.setAllEnabled.run(enabled ? 1 : 0, Date.now(), guildId);
      if (!enabled) {
        db.prepare('DELETE FROM deletion_jobs WHERE guild_id = ?').run(guildId);
      }
      return result.changes;
    },

    removeConfig(guildId, channelId) {
      db.exec('BEGIN');
      try {
        statements.removeJobsForChannel.run(guildId, channelId);
        const result = statements.removeConfig.run(guildId, channelId);
        db.exec('COMMIT');
        return result.changes > 0;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    setLastSeen(guildId, channelId, messageId) {
      statements.setLastSeen.run(messageId, guildId, channelId);
    },

    addJob({ guildId, channelId, messageId, dueAt, createdAt = Date.now() }) {
      statements.addJob.run(guildId, channelId, messageId, dueAt, createdAt);
    },

    getDueJobs(now, limit = 25) {
      return statements.dueJobs.all(now, limit);
    },

    deleteJob(id) {
      statements.deleteJob.run(id);
    },

    postponeJob(id, dueAt, attempts) {
      statements.postponeJob.run(dueAt, attempts, id);
    },

    countJobsForChannel(guildId, channelId) {
      return statements.countJobsForChannel.get(guildId, channelId).count;
    },

    getState(key, fallback = null) {
      const row = statements.getState.get(key);
      return row ? row.value : fallback;
    },

    setState(key, value) {
      statements.setState.run(key, String(value));
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDatabase };
