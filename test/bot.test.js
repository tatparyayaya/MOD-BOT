const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { DeletionScheduler } = require('../src/scheduler');
const { recoverMissedMessages } = require('../src/recovery');
const { buildCommands, formatDuration, setupPanel } = require('../src/commands');

const silentLogger = { info() {}, warn() {}, error() {} };

function makeChannel(overrides = {}) {
  const deleted = [];
  const channel = {
    name: 'general',
    guild: { members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      delete: async (messageId) => {
        deleted.push(messageId);
      },
    },
    ...overrides,
  };
  channel.deleted = deleted;
  return channel;
}

function makeClient(channel) {
  return {
    channels: {
      cache: new Map([[channel.id || 'channel-1', channel]]),
      fetch: async () => channel,
    },
  };
}

function seed(db, delaySeconds = 60) {
  db.upsertConfig({ guildId: 'guild-1', channelId: 'channel-1', delaySeconds });
}

test('settings and pending jobs persist across database reopen', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autodelete-')), 'test.sqlite');

  const first = openDatabase(file);
  seed(first, 120);
  first.addJob({
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    dueAt: Date.now() + 120_000,
  });
  first.close();

  const second = openDatabase(file);
  const config = second.getConfig('guild-1', 'channel-1');
  assert.equal(config.delay_seconds, 120);
  assert.equal(config.enabled, 1);
  assert.equal(second.countJobsForChannel('guild-1', 'channel-1'), 1);
  second.close();
});

test('OFF disables the channel and clears queued jobs', () => {
  const db = openDatabase(':memory:');
  seed(db);
  db.addJob({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'm1', dueAt: Date.now() + 1000 });

  db.setEnabled('guild-1', 'channel-1', false);

  assert.equal(db.getConfig('guild-1', 'channel-1').enabled, 0);
  assert.equal(db.countJobsForChannel('guild-1', 'channel-1'), 0);
  db.close();
});

test('scheduler deletes due messages and keeps future jobs', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  db.addJob({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'due', dueAt: Date.now() - 1 });
  db.addJob({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'future', dueAt: Date.now() + 60_000 });

  const channel = makeChannel({ id: 'channel-1' });
  const scheduler = new DeletionScheduler({ client: makeClient(channel), db, logger: silentLogger });
  await scheduler.tick();

  assert.deepEqual(channel.deleted, ['due']);
  assert.equal(db.countJobsForChannel('guild-1', 'channel-1'), 1);
  db.close();
});

test('scheduler drops unknown messages', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  db.addJob({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'gone', dueAt: Date.now() - 1 });

  const channel = makeChannel({
    id: 'channel-1',
    messages: { delete: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } },
  });
  const scheduler = new DeletionScheduler({ client: makeClient(channel), db, logger: silentLogger });
  await scheduler.tick();

  assert.equal(db.countJobsForChannel('guild-1', 'channel-1'), 0);
  db.close();
});

test('scheduler postpones rate-limited deletions', async () => {
  const db = openDatabase(':memory:');
  seed(db);
  db.addJob({ guildId: 'guild-1', channelId: 'channel-1', messageId: 'limited', dueAt: Date.now() - 1 });

  const channel = makeChannel({
    id: 'channel-1',
    messages: {
      delete: async () => {
        throw Object.assign(new Error('rate limited'), { name: 'RateLimitError', retryAfter: 2 });
      },
    },
  });
  const scheduler = new DeletionScheduler({ client: makeClient(channel), db, logger: silentLogger });
  await scheduler.tick();

  const row = db.raw.prepare('SELECT * FROM deletion_jobs WHERE message_id = ?').get('limited');
  assert.ok(row);
  assert.ok(row.due_at > Date.now());
  db.close();
});

test('recovery schedules messages received during downtime, stopping at the checkpoint', async () => {
  const db = openDatabase(':memory:');
  seed(db, 60);
  db.setLastSeen('guild-1', 'channel-1', 'checkpoint');
  db.setState('last_online_at', Date.now() - 60_000);

  const newer = {
    id: 'newer',
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdTimestamp: Date.now() - 10_000,
    author: { bot: false },
  };
  const checkpoint = {
    id: 'checkpoint',
    guildId: 'guild-1',
    channelId: 'channel-1',
    createdTimestamp: Date.now() - 90_000,
    author: { bot: false },
  };
  const collection = {
    size: 2,
    first: () => newer,
    last: () => checkpoint,
    values: () => [newer, checkpoint][Symbol.iterator](),
  };
  const channel = makeChannel({
    id: 'channel-1',
    messages: { fetch: async () => collection },
  });

  await recoverMissedMessages(makeClient(channel), db, silentLogger);

  const jobs = db.raw.prepare('SELECT * FROM deletion_jobs').all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message_id, 'newer');
  db.close();
});

test('slash command contains the required subcommands and valid options', () => {
  const [command] = buildCommands();
  const json = command.toJSON();
  const names = json.options.map((option) => option.name).sort();

  assert.equal(json.name, 'autodelete');
  assert.deepEqual(names, ['off', 'on', 'remove', 'setup', 'status']);
  for (const option of json.options) {
    assert.equal(option.type, 1);
    assert.ok(option.description.length > 0);
  }
});

test('setup panel renders valid components for preset and custom delays', () => {
  const empty = setupPanel({ channelId: null, delaySeconds: null, error: null });
  const emptyRows = empty.components.map((row) => row.toJSON());
  assert.equal(emptyRows[2].components[0].disabled, true);

  const custom = setupPanel({ channelId: 'channel-1', delaySeconds: 777, error: null });
  const customRows = custom.components.map((row) => row.toJSON());
  const delayOptions = customRows[1].components[0].options;
  assert.equal(delayOptions[0].value, 'seconds:777');
  assert.equal(delayOptions[0].default, true);
  assert.equal(customRows[2].components[0].disabled, false);

  const preset = setupPanel({ channelId: 'channel-1', delaySeconds: 300, error: null });
  const presetOptions = preset.components.map((row) => row.toJSON())[1].components[0].options;
  assert.equal(presetOptions.filter((option) => option.default === true).length, 1);
  assert.equal(presetOptions.find((option) => option.default === true).value, 'seconds:300');
});

test('duration formatting is readable', () => {
  assert.equal(formatDuration(30), '30 seconds');
  assert.equal(formatDuration(300), '5 minutes');
  assert.equal(formatDuration(3600), '1 hour');
  assert.equal(formatDuration(86400), '1 day');
});
