import { StaleGameViewError } from './game-display.js';
import { XoGame, XO_TURN } from './xo.js';

export const BOXES_SIZE = 3;
// Twelve horizontal edges, then twelve vertical edges. One button per edge.
export const BOXES_EDGES = Object.freeze([
  ...Array.from({ length: 12 }, (_, i) => Object.freeze({ row: Math.floor(i / 3), column: i % 3, horizontal: true })),
  ...Array.from({ length: 12 }, (_, i) => Object.freeze({ row: Math.floor(i / 4), column: i % 4, horizontal: false }))
]);
export function boxEdges(index) {
  const row = Math.floor(index / BOXES_SIZE), column = index % BOXES_SIZE;
  return [row * 3 + column, (row + 1) * 3 + column, 12 + row * 4 + column, 12 + row * 4 + column + 1];
}
export function boxesScore(boxes) {
  return { B: boxes.filter(owner => owner === 'B').length, R: boxes.filter(owner => owner === 'R').length };
}
export function connectBoxes(g, edge, mark) {
  if (!Number.isInteger(edge) || edge < 0 || edge >= BOXES_EDGES.length) throw new Error('اختر خطًا من 1 إلى 24.');
  if (!['B', 'R'].includes(mark)) throw new Error('لون اللاعب غير صالح.');
  if (g.edges[edge]) throw new Error('هذا الخط مرسوم بالفعل؛ اختر خطًا متاحًا.');
  const edges = [...g.edges], boxes = [...g.boxes], captured = [];
  edges[edge] = mark;
  for (let i = 0; i < boxes.length; i++) {
    // The fourth edge owns the box, regardless of who drew its other edges.
    if (!boxes[i] && boxEdges(i).every(id => !!edges[id])) { boxes[i] = mark; captured.push(i); }
  }
  return { edges, boxes, lastEdge: edge, captured };
}

export class BoxesGame extends XoGame {
  get prefix() { return 'boxes'; }
  get name() { return 'مربعات'; }
  initial() { return { edges: Array(24).fill(null), boxes: Array(9).fill(null), lastEdge: null, captured: [] }; }
  async act(input, eligible) {
    if (['accept', 'reject'].includes(input.move)) return super.act(input, eligible);
    eligible = await this.members(input, eligible);
    return this.run(async () => {
      const g = await this.get(input.id);
      if (!g || g.channelId !== input.channelId) throw new Error('تحدّي مربعات غير صالح.');
      if (![g.x, g.o].includes(input.userId)) throw new Error('التحدّي مخصص للطرفين فقط.');
      if (!['pending', 'active'].includes(g.status)) return g;
      const bank = (await this.store.settings())?.bank;
      if (bank?.channelId !== g.channelId || bank.channelVersion !== g.bankVersion
        || [g.x, g.o].some(id => g.createdAt <= this.service.bankCutoff(id))) return this.finish(g, 'cancelled', null, 'settings');
      if (!await eligible(g.x) || !await eligible(g.o)) return this.finish(g, 'cancelled', null, 'membership');
      if (g.expiresAt <= this.service.clock()) return this.timeout(g);
      if (input.revision !== g.revision || (g.dirty && g.requireDelivery)) throw new StaleGameViewError(g);
      if (g.status !== 'active') throw new Error('انتظر قبول التحدّي.');
      if (g.turn !== input.userId) throw new Error('ليس دورك الآن.');
      if (!/^(?:[1-9]|1\d|2[0-4])$/.test(input.move)) throw new Error('اختر خطًا من 1 إلى 24.');
      const moved = { ...g, ...connectBoxes(g, Number(input.move) - 1, input.userId === g.x ? 'B' : 'R') };
      if (moved.edges.every(Boolean)) {
        const score = boxesScore(moved.boxes);
        return score.B === score.R ? this.finish(moved, 'tie') : this.finish(moved, 'won', score.B > score.R ? g.x : g.o);
      }
      return this.commit({ ...moved, turn: moved.captured.length ? g.turn : g.turn === g.x ? g.o : g.x,
        expiresAt: this.service.clock() + XO_TURN });
    });
  }
}
