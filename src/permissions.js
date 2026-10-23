const { PermissionFlagsBits } = require('discord.js');
const config = require('./config');

const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

function isAuthorized(interaction) {
  if (!interaction.guildId) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config.authorizedUserIds.has(interaction.user.id)) return true;

  const roles = interaction.member?.roles;
  const roleIds = roles?.cache ? [...roles.cache.keys()] : Array.isArray(roles) ? roles : [];
  return roleIds.some((id) => config.authorizedRoleIds.has(id));
}

function missingBotPermissions(channel, me) {
  if (!channel || !me) return BOT_PERMISSIONS;
  const permissions = channel.permissionsFor(me);
  if (!permissions) return BOT_PERMISSIONS;
  return BOT_PERMISSIONS.filter((permission) => !permissions.has(permission));
}

module.exports = { BOT_PERMISSIONS, isAuthorized, missingBotPermissions };
