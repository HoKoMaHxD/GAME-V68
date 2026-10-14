import { randomInt } from 'node:crypto';
import { XoGame, XO_TURN } from './xo.js';
import { StaleGameViewError } from './game-display.js';

export const SHIP_WIDTH = 5, SHIP_HEIGHT = 4;
export const SHIP_SETUP_MS = 120000;
export const SHIP_ROWS = 'ABCDEFGHIJ';
export const SHIP_FLEET = Object.freeze([[1, 3], [1, 2], [1, 1], [1, 1]].map(Object.freeze));
const QUICK_RULES = Object.freeze({ width: SHIP_WIDTH, height: SHIP_HEIGHT, fleet: SHIP_FLEET });
// Saved rounds keep their original coordinates and fleets across an upgrade.
const QUICK_THREE_RULES = Object.freeze({ width: SHIP_WIDTH, height: SHIP_HEIGHT,
  fleet: Object.freeze([[1, 3], [1, 2], [1, 2]].map(Object.freeze)) });
const LEGACY_RULES = Object.freeze({ width: 10, height: 10,
  fleet: Object.freeze([[2, 5], [1, 5], [1, 4], [1, 3], [1, 2], [1, 2]].map(Object.freeze)) });
export const shipRules = g => g.shipMode === 'quick4' ? QUICK_RULES : g.shipMode === 'quick' ? QUICK_THREE_RULES : LEGACY_RULES;
const shuffled = values => {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};
const placementsFor = rules => rules.fleet.map(([h, w], id) => {
  const options = [];
  for (const [height, width] of h === w ? [[h, w]] : [[h, w], [w, h]]) {
    for (let row = 0; row <= rules.height - height; row++) for (let col = 0; col <= rules.width - width; col++) {
      const cells = [];
      for (let r = row; r < row + height; r++) for (let c = col; c < col + width; c++) cells.push(r * rules.width + c);
      options.push({ id, row, col, height, width, cells });
    }
  }
  return options;
});
const placementSets = new Map([QUICK_RULES, QUICK_THREE_RULES, LEGACY_RULES].map(rules => [rules, placementsFor(rules)]));
export function randomFleet(rules = QUICK_RULES) {
  const placements = placementSets.get(rules);
  // Randomized backtracking over all legal positions, never a catalogue of layouts.
  // A one-cell sea border between ships makes their silhouettes easy to read.
  const place = (id, blocked) => {
    if (id === rules.fleet.length) return [];
    for (const ship of shuffled(placements[id])) {
      if (ship.cells.some(cell => blocked.has(cell))) continue;
      const next = new Set(blocked);
      for (let r = Math.max(0, ship.row - 1); r <= Math.min(rules.height - 1, ship.row + ship.height); r++) {
        for (let c = Math.max(0, ship.col - 1); c <= Math.min(rules.width - 1, ship.col + ship.width); c++) next.add(r * rules.width + c);
      }
      const rest = place(id + 1, next);
      if (rest) return [{ ...ship, cells: [...ship.cells] }, ...rest];
    }
    return null;
  };
  const fleet = place(0, new Set());
  if (!fleet) throw new Error('تعذر توزيع السفن؛ اضغط عشوائي مجددًا.');
  return fleet;
}
export const opponent = (g, id) => id === g.x ? g.o : g.x;
export const shipSunk = (ship, shots) => ship.cells.every(cell => shots.includes(cell));
export const sunkCount = (fleet = [], shots = []) => fleet.filter(ship => shipSunk(ship, shots)).length;
export const cellLabel = (cell, width = SHIP_WIDTH) => `${SHIP_ROWS[Math.floor(cell / width)]}${cell % width + 1}`;
export function fireShot(fleet, shots, cell, rules = QUICK_RULES) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= rules.width * rules.height) throw new Error(`اختر خانة صحيحة من A1 إلى ${SHIP_ROWS[rules.height - 1]}${rules.width}.`);
  if (shots.includes(cell)) throw new Error('هاجمت هذه الخانة من قبل؛ اختر خانة أخرى.');
  const next = [...shots, cell], ship = fleet.find(s => s.cells.includes(cell));
  return { shots: next, hit: !!ship, sunk: ship && shipSunk(ship, next) ? ship.id : null,
    won: fleet.length === rules.fleet.length && fleet.every(s => shipSunk(s, next)) };
}

export class ShipGame extends XoGame {
  get prefix() { return 'ship'; }
  get name() { return 'سفينة'; }
  initial() { return { shipMode: 'quick4', phase: 'invite', fleets: {}, shots: {}, ready: {}, layoutRevision: {}, selectedRow: null, lastShot: null }; }
  accepted(g, holds, now) {
    return { ...super.accepted(g, holds, now), phase: 'setup', expiresAt: now + SHIP_SETUP_MS,
      fleets: { [g.x]: randomFleet(shipRules(g)), [g.o]: randomFleet(shipRules(g)) }, shots: { [g.x]: [], [g.o]: [] },
      ready: { [g.x]: false, [g.o]: false }, layoutRevision: { [g.x]: 0, [g.o]: 0 } };
  }
  timeout(g) {
    // No one loses a stake before both players are ready, or on a failed delivery.
    if (g.phase === 'setup') return this.finish(g, 'cancelled', null, 'setup-timeout');
    return super.timeout(g);
  }
  async act(input, eligible) {
    if (['accept', 'reject'].includes(input.move)) return super.act(input, eligible);
    eligible = await this.members(input, eligible);
    return this.run(async () => {
      const g = await this.get(input.id), who = input.userId;
      if (!g || g.channelId !== input.channelId || ![g.x, g.o].includes(who)) throw new Error('هذه اللعبة مخصصة للطرفين فقط.');
      if (!['pending', 'active'].includes(g.status)) return g;
      const bank = (await this.store.settings())?.bank;
      if (bank?.channelId !== g.channelId || bank.channelVersion !== g.bankVersion
        || [g.x, g.o].some(id => g.createdAt <= this.service.bankCutoff(id))) return this.finish(g, 'cancelled', null, 'settings');
      if (!await eligible(g.x) || !await eligible(g.o)) return this.finish(g, 'cancelled', null, 'membership');
      if (g.expiresAt <= this.service.clock()) return this.timeout(g);
      if (g.status !== 'active') throw new Error('انتظر قبول التحدّي لفتح أسطولك.');
      if (input.move === 'own') return g;
      if (['random', 'ready'].includes(input.move)) {
        if (g.phase !== 'setup' || g.ready[who]) throw new Error('تم تثبيت أسطولك؛ لا يمكن تغيير التوزيع بعد الجاهزية.');
        // Each player has their own version: the opponent's shuffle cannot stale this panel.
        if (input.layoutRevision !== g.layoutRevision[who]) throw new StaleGameViewError(g);
        if (input.move === 'random') return this.commit({ ...g, fleets: { ...g.fleets, [who]: randomFleet(shipRules(g)) },
          layoutRevision: { ...g.layoutRevision, [who]: g.layoutRevision[who] + 1 } });
        const next = { ...g, ready: { ...g.ready, [who]: true } };
        if (next.ready[g.x] && next.ready[g.o]) Object.assign(next, {
          phase: 'battle', turn: randomInt(2) ? g.x : g.o, selectedRow: null, expiresAt: this.service.clock() + XO_TURN
        });
        return this.commit(next);
      }
      if (g.phase !== 'battle') throw new Error('يبدأ الهجوم بعد ضغط الطرفين على جاهز.');
      if (input.revision !== g.revision || (g.dirty && g.requireDelivery)) throw new StaleGameViewError(g);
      if (g.turn !== who) throw new Error('ليس دورك الآن.');
      const rules = shipRules(g), direct = rules.width === SHIP_WIDTH;
      if (!direct && /^row:[A-J]$/.test(input.move)) {
        const row = SHIP_ROWS.indexOf(input.move.slice(4));
        if (Array.from({ length: 10 }, (_, col) => row * 10 + col).every(cell => g.shots[who].includes(cell))) throw new Error('كل خانات هذا الصف مهاجمة؛ اختر صفًا آخر.');
        if (g.selectedRow === row) return g;
        // Choosing or changing a row is navigation, not an attack, and grants no extra time.
        return this.commit({ ...g, selectedRow: row });
      }
      if (!/^fire:(?:[0-9]|[1-9][0-9])$/.test(input.move)) throw new Error('اضغط زر الخانة من الرسالة الأساسية للهجوم.');
      const cell = Number(input.move.slice(5));
      if (!direct && g.selectedRow !== Math.floor(cell / rules.width)) throw new StaleGameViewError(g);
      const result = fireShot(g.fleets[opponent(g, who)], g.shots[who], cell, rules);
      const next = { ...g, shots: { ...g.shots, [who]: result.shots },
        lastShot: { by: who, cell, hit: result.hit, sunk: result.sunk }, selectedRow: null,
        turn: result.hit ? who : opponent(g, who), expiresAt: this.service.clock() + XO_TURN };
      return result.won ? this.finish(next, 'won', who) : this.commit(next);
    });
  }
}
