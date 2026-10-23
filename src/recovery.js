const { missingBotPermissions } = require('./permissions');

const MAX_SCAN_MESSAGES = 500;

async function recoverMissedMessages(client, db, logger) {
  const lastOnline = Number(db.getState('last_online_at', 0)) || 0;
  db.setState('last_online_at', Date.now());

  if (lastOnline <= 0) return;

  for (const config of db.listEnabledConfigs()) {
    if (!config.last_seen_id) continue;

    let channel;
    try {
      channel = client.channels.cache.get(config.channel_id)
        || await client.channels.fetch(config.channel_id);
    } catch (error) {
      logger.warn(`Recovery: could not fetch channel ${config.channel_id}: ${error.message}`);
      continue;
    }

    if (!channel || !channel.isTextBased() || !channel.guild) continue;

    const me = channel.guild.members.me;
    const missing = missingBotPermissions(channel, me);
    if (missing.length > 0) {
      logger.warn(`Recovery: skipping #${channel.name || config.channel_id} because permissions are missing.`);
      continue;
    }

    let before;
    let scanned = 0;
    let newestId = null;

    try {
      while (scanned < MAX_SCAN_MESSAGES) {
        const messages = await channel.messages.fetch({ limit: 100, before });
        if (messages.size === 0) break;

        newestId ??= messages.first().id;
        let reachedKnownBoundary = false;

        for (const message of messages.values()) {
          if (message.id === config.last_seen_id || message.createdTimestamp <= lastOnline) {
            reachedKnownBoundary = true;
            break;
          }

          if (config.exclude_bots && message.author?.bot) continue;

          db.addJob({
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            dueAt: message.createdTimestamp + config.delay_seconds * 1000,
            createdAt: message.createdTimestamp,
          });
        }

        scanned += messages.size;
        if (reachedKnownBoundary) break;
        before = messages.last().id;
      }

      if (newestId) {
        db.setLastSeen(config.guild_id, config.channel_id, newestId);
        logger.info(`Recovery: scanned ${scanned} message(s) in #${channel.name || config.channel_id}.`);
      }
    } catch (error) {
      logger.warn(`Recovery: could not scan #${channel.name || config.channel_id}: ${error.message}`);
    }
  }
}

module.exports = { recoverMissedMessages };
