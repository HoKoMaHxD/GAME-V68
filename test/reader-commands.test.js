import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { buildReaderCommand, createReaderHandler } from '../src/reader-commands.js';
import { createHandler, buildCommands } from '../src/commands.js';

const config = { clanGuildId: '100000000000000001', mode: 'selfbot' }, user = '100000000000000010';
function interaction({ modal = false, admin = true, guildId = config.clanGuildId, owner = user } = {}) {
  const replies = [], modals = [];
  return { replies, modals, guildId, guild: { ownerId: '100000000000000999' }, id: '100000000000000002', user: { id: user },
    memberPermissions: { has: permission => admin && permission === PermissionFlagsBits.Administrator },
    isChatInputCommand: () => !modal, isModalSubmit: () => modal, commandName: 'تحديث',
    options: { getSubcommand: () => 'التوكن' }, customId: `reader-token-update:${owner}`,
    fields: { getTextInputValue: () => 'secret-new-token' },
    reply: async p => replies.push(p), deferReply: async p => replies.push(p), editReply: async p => replies.push(p),
    showModal: async p => modals.push(p.toJSON()) };
}
test('slash command is exactly /تحديث التوكن and never has a public token option', () => {
  const c = buildReaderCommand().toJSON(); assert.equal(c.name, 'تحديث'); assert.equal(c.options[0].name, 'التوكن');
  assert.equal(c.options[0].type, 1); assert.equal(c.options[0].options.length, 0);
  assert.equal(c.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(buildCommands().filter(c => c.name === 'تحديث').length, 1);
});
test('administrator opens an empty private modal; submission saves and replies ephemerally', async () => {
  const updates = [], handler = createReaderHandler({ config, readerRuntime: { update: async (...args) => updates.push(args) } });
  const command = interaction(); await handler(command); assert.equal(command.modals.length, 1);
  assert.ok(!JSON.stringify(command.modals).includes('secret-new-token'));
  const submit = interaction({ modal: true }); await handler(submit); assert.equal(updates.length, 1);
  assert.equal(submit.replies[0].flags, MessageFlags.Ephemeral); assert.match(submit.replies[1].content, /✅/);
});
test('authorization and modal ownership are checked again at submission', async () => {
  let updates = 0; const handler = createReaderHandler({ config, readerRuntime: { update: async () => updates++ } });
  for (const patch of [{ admin: false }, { guildId: '100000000000000003' }, { owner: '100000000000000011' }]) {
    const i = interaction({ modal: true, ...patch }); await handler(i);
    assert.equal(i.replies[0].flags, MessageFlags.Ephemeral); assert.ok(!i.replies[0].content.includes('secret-new-token'));
  }
  assert.equal(updates, 0);
});
test('SDK errors never expose the submitted token', async () => {
  const handler = createReaderHandler({ config, readerRuntime: { update: async () => { throw new Error('secret-new-token'); } } });
  const i = interaction({ modal: true }); await handler(i); assert.ok(!JSON.stringify(i.replies).includes('secret-new-token'));
  assert.match(i.replies[1].content, /❌/);
});
test('main handler routes recovery command even while accounting is paused or blocked', async () => {
  const handler = createHandler({ config, service: { paused: true, blocked: true }, readerRuntime: { update: async () => {} } });
  const i = interaction(); await handler(i); assert.equal(i.modals.length, 1);
});
