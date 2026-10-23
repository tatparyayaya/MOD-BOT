const { REST, Routes } = require('discord.js');
const config = require('./config');
const { buildCommands } = require('./commands');

async function main() {
  if (!config.token) throw new Error('DISCORD_TOKEN is missing from .env');
  if (!config.clientId) throw new Error('CLIENT_ID is missing from .env');

  const commands = buildCommands().map((command) => command.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.token);

  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body: commands });
  console.log(
    `Registered ${commands.length} command(s) ${config.guildId ? `in guild ${config.guildId}` : 'globally'}.`,
  );
}

main().catch((error) => {
  console.error('Command registration failed:', error);
  process.exitCode = 1;
});
