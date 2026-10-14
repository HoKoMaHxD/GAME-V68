import { StaleGameViewError } from './game-display.js';
import { XoGame, XO_TURN } from './xo.js';
export const DOT_ROWS = 6, DOT_COLUMNS = 7;
export function dotLine(board) {
  for (let r=0;r<DOT_ROWS;r++) for(let c=0;c<DOT_COLUMNS;c++) {
    const mark=board[r*DOT_COLUMNS+c]; if(!mark) continue;
    for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      const cells=Array.from({length:4},(_,i)=>[r+i*dr,c+i*dc]);
      if(cells.every(([y,x])=>y>=0&&y<DOT_ROWS&&x>=0&&x<DOT_COLUMNS&&board[y*DOT_COLUMNS+x]===mark)) return cells.map(([y,x])=>y*DOT_COLUMNS+x);
    }
  }
  return null;
}
export function dropDot(board,column,mark) {
  if(!Number.isInteger(column)||column<0||column>=DOT_COLUMNS) throw new Error('اختر عمودًا من 1 إلى 7.');
  for(let row=DOT_ROWS-1;row>=0;row--) {
    const cell=row*DOT_COLUMNS+column;
    if(!board[cell]) {const next=[...board];next[cell]=mark;return {board:next,lastCell:cell};}
  }
  throw new Error('هذا العمود ممتلئ؛ اختر عمودًا آخر.');
}
export class DotGame extends XoGame {
  get prefix(){return 'dot';}
  get name(){return 'دوت';}
  initial(){return {board:Array(42).fill(null),line:null,lastCell:null};}
  async initialize(){await super.initialize();await this.games.createIndex({clanId:1,messageId:1});}
  byMessage(messageId){return this.games.findOne({clanId:this.clanId,messageId});}
  async act(input,eligible){
    if(['accept','reject'].includes(input.move))return super.act(input,eligible);
    eligible=await this.members(input,eligible);
    return this.run(async()=>{
      const g=await this.get(input.id);
      if(!g||g.channelId!==input.channelId)throw new Error('تحدّي دوت غير صالح.');
      if(![g.x,g.o].includes(input.userId))throw new Error('التحدّي مخصص للطرفين فقط.');
      if(!['pending','active'].includes(g.status))return g;
      const bank=(await this.store.settings())?.bank;
      if(bank?.channelId!==g.channelId||bank.channelVersion!==g.bankVersion||[g.x,g.o].some(id=>g.createdAt<=this.service.bankCutoff(id)))return this.finish(g,'cancelled',null,'settings');
      if(!await eligible(g.x)||!await eligible(g.o))return this.finish(g,'cancelled',null,'membership');
      if(input.revision!==g.revision||g.dirty&&g.requireDelivery)throw new StaleGameViewError(g,'هذه الحركة تخص دورًا سابقًا؛ انتظر ظهور لوحة دورك.');
      if(g.status!=='active')throw new Error('انتظر ظهور لوحة دورك.');
      if(g.turn!==input.userId)throw new Error('ليس دورك الآن.');
      if(g.expiresAt<=this.service.clock())return this.timeout(g);
      if(!/^[1-7]$/.test(input.move))throw new Error('اختر عمودًا من 1 إلى 7.');
      const moved={...g,...dropDot(g.board,Number(input.move)-1,input.userId===g.x?'R':'Y')};
      const line=dotLine(moved.board);
      if(line)return this.finish({...moved,line},'won',input.userId);
      if(moved.board.every(Boolean))return this.finish(moved,'tie');
      return this.commit({...moved,turn:g.turn===g.x?g.o:g.x,expiresAt:this.service.clock()+XO_TURN});
    });
  }
}
