const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { isAuthorized, missingBotPermissions } = require('./permissions');

const MIN_DELAY = 10;
const MAX_DELAY = 30 * 24 * 60 * 60;
const SETUP_TIMEOUT = 5 * 60_000;

const DELAY_PRESETS = [
  { label: '30 seconds', value: 30 },
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '10 minutes', value: 600 },
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '12 hours', value: 43200 },
  { label: '1 day', value: 86400 },
  { label: '3 days', value: 259200 },
  { label: '7 days', value: 604800 },
];

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'}${rest ? ` ${rest}s` : ''}`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const rest = Math.round((seconds % 3600) / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest}m` : ''}`;
  }
  const days = Math.floor(seconds / 86400);
  const rest = Math.round((seconds % 86400) / 3600);
  return `${days} day${days === 1 ? '' : 's'}${rest ? ` ${rest}h` : ''}`;
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('autodelete')
      .setDescription('Manage automatic message deletion in this server')
      .setDMPermission(false)
      .addSubcommand((subcommand) => subcommand
        .setName('setup')
        .setDescription('Configure automatic deletion for a text channel'))
      .addSubcommand((subcommand) => subcommand
        .setName('on')
        .setDescription('Resume auto-delete for one channel or all configured channels')
        .addChannelOption((option) => option
          .setName('channel')
          .setDescription('Channel to enable (omit to enable all configured channels)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((subcommand) => subcommand
        .setName('off')
        .setDescription('Pause auto-delete without deleting queued messages')
        .addChannelOption((option) => option
          .setName('channel')
          .setDescription('Channel to disable (omit to disable all configured channels)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((subcommand) => subcommand
        .setName('status')
        .setDescription('Show auto-delete configuration and pending deletions'))
      .addSubcommand((subcommand) => subcommand
        .setName('remove')
        .setDescription('Remove auto-delete configuration and queued jobs for a channel')
        .addChannelOption((option) => option
          .setName('channel')
          .setDescription('Channel to remove')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true))),
  ];
}

function setupPanel(state) {
  const channelLabel = state.channelId ? `<#${state.channelId}>` : 'Not selected';
  const delayLabel = state.delaySeconds ? formatDuration(state.delaySeconds) : 'Not selected';

  const embed = new EmbedBuilder()
    .setTitle('Auto-delete setup')
    .setDescription([
      'Select a text channel and a deletion delay, then confirm.',
      '',
      `Channel: ${channelLabel}`,
      `Delay: ${delayLabel}`,
      'Bot messages: **excluded**',
      '',
      '**Deletion is permanent.** Messages will be removed after the delay while auto-delete is ON.',
      state.error ? `\n⚠️ ${state.error}` : '',
    ].join('\n'))
    .setColor(state.error ? 0xed4245 : 0x5865f2);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('autodelete:channel')
    .setPlaceholder('Select a text channel')
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  if (state.channelId) channelSelect.setDefaultChannels(state.channelId);

  const delayOptions = DELAY_PRESETS.map((preset) => ({
    label: preset.label,
    value: `seconds:${preset.value}`,
    default: preset.value === state.delaySeconds,
  }));
  const isPreset = DELAY_PRESETS.some((preset) => preset.value === state.delaySeconds);
  if (state.delaySeconds && !isPreset) {
    delayOptions.unshift({
      label: `Custom: ${formatDuration(state.delaySeconds)}`,
      value: `seconds:${state.delaySeconds}`,
      default: true,
    });
  }
  delayOptions.push({ label: 'Custom delay...', value: 'custom' });

  const delaySelect = new StringSelectMenuBuilder()
    .setCustomId('autodelete:delay')
    .setPlaceholder('Select a deletion delay')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(delayOptions);

  const confirm = new ButtonBuilder()
    .setCustomId('autodelete:confirm')
    .setLabel('Confirm')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!state.channelId || !state.delaySeconds);

  const cancel = new ButtonBuilder()
    .setCustomId('autodelete:cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(delaySelect),
      new ActionRowBuilder().addComponents(confirm, cancel),
    ],
  };
}

async function validateTargetChannel(interaction, channelId) {
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildText) {
    return { error: 'That channel is not a valid text channel in this server.' };
  }

  const me = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  const missing = missingBotPermissions(channel, me);
  if (missing.length > 0) {
    const names = missing.map((permission) => {
      const key = Object.keys(PermissionFlagsBits).find((name) => PermissionFlagsBits[name] === permission);
      return key || String(permission);
    });
    return { error: `I am missing permissions in ${channel}: ${names.join(', ')}.` };
  }

  return { channel };
}

async function runSetup(interaction, db, logger) {
  const state = { channelId: null, delaySeconds: null, error: null };

  await interaction.reply({
    ...setupPanel(state),
    flags: MessageFlags.Ephemeral,
  });
  const panelMessage = await interaction.fetchReply();

  const collector = panelMessage.createMessageComponentCollector({
    time: SETUP_TIMEOUT,
    filter: (component) => component.user.id === interaction.user.id,
  });

  let completed = false;

  collector.on('collect', async (component) => {
    try {
      if (component.customId === 'autodelete:channel') {
        state.channelId = component.values[0];
        state.error = null;
        await component.update(setupPanel(state));
        return;
      }

      if (component.customId === 'autodelete:delay') {
        const value = component.values[0];
        if (value !== 'custom') {
          state.delaySeconds = Number(value.split(':')[1]);
          state.error = null;
          await component.update(setupPanel(state));
          return;
        }

        const modalId = `autodelete:custom-delay:${interaction.id}`;
        const modal = new ModalBuilder()
          .setCustomId(modalId)
          .setTitle('Custom deletion delay')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('seconds')
              .setLabel('Delay in seconds')
              .setPlaceholder(`Between ${MIN_DELAY} and ${MAX_DELAY}`)
              .setStyle(TextInputStyle.Short)
              .setMinLength(1)
              .setMaxLength(7)
              .setRequired(true),
          ));

        await component.showModal(modal);
        let submitted;
        try {
          submitted = await component.awaitModalSubmit({
            time: 120_000,
            filter: (modalInteraction) => modalInteraction.customId === modalId
              && modalInteraction.user.id === interaction.user.id,
          });
        } catch (error) {
          if (error.code === 'InteractionCollectorError') return;
          throw error;
        }

        const seconds = Number(submitted.fields.getTextInputValue('seconds').trim());
        if (!Number.isInteger(seconds) || seconds < MIN_DELAY || seconds > MAX_DELAY) {
          await submitted.reply({
            content: `Enter a whole number between ${MIN_DELAY} and ${MAX_DELAY} seconds.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        state.delaySeconds = seconds;
        state.error = null;
        await submitted.update(setupPanel(state));
        return;
      }

      if (component.customId === 'autodelete:cancel') {
        completed = true;
        collector.stop('cancelled');
        await component.update({
          embeds: [new EmbedBuilder()
            .setTitle('Auto-delete setup cancelled')
            .setDescription('No settings were changed.')
            .setColor(0x95a5a6)],
          components: [],
        });
        return;
      }

      if (component.customId === 'autodelete:confirm') {
        if (!state.channelId || !state.delaySeconds) {
          state.error = 'Select both a channel and a delay before confirming.';
          await component.update(setupPanel(state));
          return;
        }

        if (state.delaySeconds < MIN_DELAY || state.delaySeconds > MAX_DELAY) {
          state.error = `Delay must be between ${MIN_DELAY} and ${MAX_DELAY} seconds.`;
          await component.update(setupPanel(state));
          return;
        }

        const result = await validateTargetChannel(interaction, state.channelId);
        if (result.error) {
          state.error = result.error;
          await component.update(setupPanel(state));
          return;
        }

        db.upsertConfig({
          guildId: interaction.guildId,
          channelId: state.channelId,
          delaySeconds: state.delaySeconds,
          excludeBots: true,
        });

        completed = true;
        collector.stop('completed');

        await component.update({
          embeds: [new EmbedBuilder()
            .setTitle('Auto-delete enabled')
            .setDescription([
              `Channel: <#${state.channelId}>`,
              `Delay: ${formatDuration(state.delaySeconds)}`,
              'Bot messages are excluded.',
              '',
              'Deletion is permanent. Use `/autodelete off` to pause or `/autodelete remove` to remove this configuration.',
            ].join('\n'))
            .setColor(0x57f287)],
          components: [],
        });

        logger.info(`Auto-delete configured for ${interaction.guildId}/${state.channelId} (${state.delaySeconds}s)`);
      }
    } catch (error) {
      logger.error('Setup interaction failed:', error);
      const message = 'Something went wrong while saving this setup. Please try again.';
      if (component.deferred || component.replied) {
        await component.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await component.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  collector.on('end', async () => {
    if (completed) return;
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('Auto-delete setup timed out')
        .setDescription('No settings were changed. Run `/autodelete setup` again.')
        .setColor(0x95a5a6)],
      components: [],
    }).catch(() => {});
  });
}

async function handleCommand(interaction, { db, logger }) {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!isAuthorized(interaction)) {
    await interaction.reply({
      content: 'You need the Manage Server permission (or an authorized role/user) to use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const channel = interaction.options.getChannel('channel');

  if (subcommand === 'setup') {
    await runSetup(interaction, db, logger);
    return;
  }

  if (subcommand === 'status') {
    const configs = db.listConfigs(interaction.guildId);
    if (configs.length === 0) {
      await interaction.reply({
        content: 'No channels are configured. Use `/autodelete setup` to add one.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = configs.map((config) => {
      const pending = db.countJobsForChannel(config.guild_id, config.channel_id);
      return [
        `<#${config.channel_id}> — **${config.enabled ? 'ON' : 'OFF'}**`,
        `Delay: ${formatDuration(config.delay_seconds)} | Pending: ${pending}`,
      ].join('\n');
    });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Auto-delete status')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Only new messages are scheduled; existing history is not deleted.' })
        .setColor(0x5865f2)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'on' || subcommand === 'off') {
    const enabled = subcommand === 'on';
    let changes = 0;

    if (channel) {
      const existing = db.getConfig(interaction.guildId, channel.id);
      if (!existing) {
        await interaction.reply({
          content: `${channel} is not configured. Use \`/autodelete setup\` first.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      db.setEnabled(interaction.guildId, channel.id, enabled);
      changes = 1;
    } else {
      if (db.listConfigs(interaction.guildId).length === 0) {
        await interaction.reply({
          content: 'No channels are configured. Use `/autodelete setup` to add one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      changes = db.setAllEnabled(interaction.guildId, enabled);
    }

    await interaction.reply({
      content: enabled
        ? `Auto-delete resumed for ${changes} channel${changes === 1 ? '' : 's'}. New messages will be deleted after their configured delay.`
        : `Auto-delete paused for ${changes} channel${changes === 1 ? '' : 's'}. Queued deletions were cancelled; messages were not deleted.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'remove') {
    const existing = db.getConfig(interaction.guildId, channel.id);
    if (!existing) {
      await interaction.reply({
        content: `${channel} is not configured.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    db.removeConfig(interaction.guildId, channel.id);
    await interaction.reply({
      content: `Auto-delete configuration and queued deletions removed for ${channel}. Existing messages were not deleted.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = {
  MIN_DELAY,
  MAX_DELAY,
  buildCommands,
  formatDuration,
  handleCommand,
  runSetup,
  setupPanel,
};
