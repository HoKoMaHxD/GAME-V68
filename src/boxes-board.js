import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { BOXES_EDGES, boxesScore } from './boxes-game.js';

GlobalFonts.registerFromPath(fileURLToPath(new URL('../assets/DejaVuSans.ttf', import.meta.url)), 'BoxesArabic');
const colors = { B: '#168ec4', R: '#e64e68' };
export function boxesBoard(g) {
  const canvas = createCanvas(760, 820), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eaf7fc'; ctx.fillRect(0, 0, 760, 820);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(24, 24, 712, 772, 24); ctx.fill();
  ctx.textAlign = 'center'; ctx.fillStyle = '#263c49'; ctx.font = 'bold 34px BoxesArabic';
  ctx.fillText('مربعات', 380, 77);
  const score = boxesScore(g.boxes);
  for (const [id, mark, x] of [[g.x, 'B', 206], [g.o, 'R', 554]]) {
    ctx.fillStyle = colors[mark]; ctx.font = 'bold 22px BoxesArabic';
    ctx.fillText(g.names?.[id] || (mark === 'B' ? 'اللاعب الأزرق' : 'اللاعب الأحمر'), x, 117, 300);
    ctx.font = 'bold 38px BoxesArabic'; ctx.fillText(String(score[mark]), x, 163);
    if (g.status === 'active' && g.turn === id) { ctx.fillRect(x - 40, 177, 80, 4); }
  }
  const left = 110, top = 240, step = 180;
  for (let i = 0; i < g.boxes.length; i++) if (g.boxes[i]) {
    const x = left + (i % 3) * step, y = top + Math.floor(i / 3) * step;
    ctx.fillStyle = g.boxes[i] === 'B' ? '#d1effb' : '#fde0e7'; ctx.fillRect(x + 8, y + 8, step - 16, step - 16);
    ctx.fillStyle = colors[g.boxes[i]]; ctx.font = 'bold 32px BoxesArabic'; ctx.fillText('■', x + step / 2, y + step / 2 + 12);
  }
  BOXES_EDGES.forEach(({ row, column, horizontal }, i) => {
    const x = left + column * step, y = top + row * step;
    const endX = x + (horizontal ? step : 0), endY = y + (horizontal ? 0 : step);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY);
    ctx.strokeStyle = g.edges[i] ? colors[g.edges[i]] : '#c5d4dc'; ctx.lineWidth = g.edges[i] ? 12 : 3;
    ctx.lineCap = 'round'; ctx.setLineDash(g.edges[i] ? [] : [6, 8]); ctx.stroke(); ctx.setLineDash([]);
    const mx = (x + endX) / 2, my = (y + endY) / 2;
    ctx.beginPath(); ctx.arc(mx, my, 20, 0, Math.PI * 2);
    ctx.fillStyle = g.edges[i] ? colors[g.edges[i]] : '#f0f5f8'; ctx.fill();
    if (g.lastEdge === i) { ctx.strokeStyle = '#233a48'; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.fillStyle = g.edges[i] ? '#ffffff' : '#3f5969'; ctx.font = 'bold 21px BoxesArabic'; ctx.fillText(String(i + 1), mx, my + 7);
  });
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    ctx.beginPath(); ctx.arc(left + column * step, top + row * step, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#304650'; ctx.fill();
  }
  return canvas.toBuffer('image/png');
}
