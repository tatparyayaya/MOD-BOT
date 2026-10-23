const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.warn(`Could not load .env: ${error.message}`);
  }
}

function list(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  token: process.env.DISCORD_TOKEN?.trim() || '',
  clientId: process.env.CLIENT_ID?.trim() || '',
  guildId: process.env.GUILD_ID?.trim() || '',
  dbPath: path.resolve(process.env.DB_PATH?.trim() || path.join(__dirname, '..', 'data', 'autodelete.sqlite')),
  authorizedUserIds: new Set(list(process.env.AUTHORIZED_USER_IDS)),
  authorizedRoleIds: new Set(list(process.env.AUTHORIZED_ROLE_IDS)),
};

module.exports = config;
