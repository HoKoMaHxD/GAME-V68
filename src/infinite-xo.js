// FIFO queues are persisted with the board. Remove the oldest mark before
// checking the winning line; a vanished mark cannot contribute to a win.
export function infiniteMove(game, cell, mark) {
 if (!Number.isInteger(cell) || cell<0 || cell>8 || game.board[cell]) throw new Error('اختر خانة فارغة.');
 const order=structuredClone(game.markOrder);
 if(!order || !Array.isArray(order.X) || !Array.isArray(order.O))throw new Error('تعذر قراءة ترتيب علامات القيم.');
 for(const symbol of ['X','O']) {
  const cells=order[symbol];
  if(cells.length>3 || new Set(cells).size!==cells.length || cells.some(i=>!Number.isInteger(i)||i<0||i>8||game.board[i]!==symbol) || game.board.filter(x=>x===symbol).length!==cells.length)throw new Error('ترتيب علامات القيم غير متطابق مع اللوحة.');
 }
 const board=[...game.board];
 if(order[mark].length===3)board[order[mark].shift()]=null;
 board[cell]=mark;order[mark].push(cell);
 return {board,markOrder:order};
}
