const { Client, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const config = require('./config');
const { openDatabase } = require('./db');
const { DeletionScheduler } = require('./scheduler');
const { buildCommands, handleCommand } = require('./commands');
const { missingBotPermissions } = require('./permissions');
const { recoverMissedMessages } = require('./recovery');

const logger = {
  info: (...args) => console.log(new Date().toISOString(), ...args),
  warn: (...args) => console.warn(new Date().toISOString(), ...args),
  error: (...args) => console.error(new Date().toISOString(), ...args),
};

if (!config.token) {
  logger.error('DISCORD_TOKEN is missing. Copy .env.example to .env and set your bot token.');
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const scheduler = new DeletionScheduler({ client, db, logger });
const rest = new REST({ version: '10' }).setToken(config.token);
const warnedChannels = new Set();
let heartbeatTimer = null;
let shuttingDown = false;

async function registerGuildCommands(guildId, applicationId = client.user?.id) {
  if (!applicationId) return;
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: buildCommands().map((command) => command.toJSON()),
  });
  logger.info(`Registered slash commands in guild ${guildId}.`);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'autodelete') return;

  try {
    await handleCommand(interaction, { db, logger });
  } catch (error) {
    logger.error('Command failed:', error);
    if (interaction.isRepliable()) {
      const payload = {
        content: 'An unexpected error occurred while running this command.',
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await registerGuildCommands(guild.id);
  } catch (error) {
    logger.warn(`Could not register commands in guild ${guild.id}: ${error.message}`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.inGuild()) return;

  try {
    const channelConfig = db.getConfig(message.guildId, message.channelId);
    if (!channelConfig) return;

    db.setLastSeen(message.guildId, message.channelId, message.id);

    if (!channelConfig.enabled) return;
    if (channelConfig.exclude_bots && message.author.bot) return;

    const me = message.guild.members.me;
    const missing = missingBotPermissions(message.channel, me);
    if (missing.length > 0) {
      if (!warnedChannels.has(message.channelId)) {
        warnedChannels.add(message.channelId);
        logger.warn(`Auto-delete is enabled in #${message.channel.name} but permissions are missing; messages are not being scheduled.`);
      }
      return;
    }

    warnedChannels.delete(message.channelId);
    db.addJob({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      dueAt: message.createdTimestamp + channelConfig.delay_seconds * 1000,
      createdAt: message.createdTimestamp,
    });
  } catch (error) {
    logger.error(`Failed to schedule deletion for message ${message.id}:`, error);
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}.`);

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await registerGuildCommands(guild.id, readyClient.user.id);
    } catch (error) {
      logger.warn(`Could not register commands in guild ${guild.id}: ${error.message}`);
    }
  }

  try {
    await recoverMissedMessages(readyClient, db, logger);
  } catch (error) {
    logger.error('Recovery scan failed:', error);
  }

  scheduler.start();

  heartbeatTimer = setInterval(() => {
    try {
      db.setState('last_online_at', Date.now());
    } catch (error) {
      logger.error('Heartbeat failed:', error);
    }
  }, 30_000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  logger.info('Auto-delete scheduler started.');
});

client.on(Events.Error, (error) => logger.error('Discord client error:', error));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}; shutting down.`);

  scheduler.stop();
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  try {
    db.setState('last_online_at', Date.now());
  } catch (error) {
    logger.error('Could not save shutdown time:', error);
  }

  for (let i = 0; i < 50 && scheduler.running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  client.destroy();
  try {
    db.close();
  } catch (error) {
    logger.error('Could not close database:', error);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => logger.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => logger.error('Uncaught exception:', error));

client.login(config.token).catch((error) => {
  logger.error('Discord login failed:', error);
  process.exit(1);
});
