import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
GlobalFonts.registerFromPath(fileURLToPath(new URL('../assets/DejaVuSans.ttf',import.meta.url)), 'DotArabic');
export function dotBoard(g) {
  const canvas=createCanvas(720,790),ctx=canvas.getContext('2d');
  ctx.scale(2,2);ctx.fillStyle='#2f3136';ctx.fillRect(0,0,360,395);
  ctx.fillStyle='#242627';ctx.fillRect(4,0,352,304);
  for(let c=0;c<7;c++) {
    const x=31+c*49;
    ctx.fillStyle='#091921';ctx.fillRect(x-14,10,28,28);
    const gradient=ctx.createLinearGradient(x,12,x,36);gradient.addColorStop(0,'#2b9dd6');gradient.addColorStop(1,'#07659a');
    ctx.fillStyle=gradient;ctx.fillRect(x-12,12,24,24);
    ctx.fillStyle='#fff';ctx.textAlign='center';ctx.font='bold 19px DotArabic';ctx.fillText(String(c+1),x,31);
    ctx.beginPath();ctx.moveTo(x-10,47);ctx.lineTo(x+10,47);ctx.lineTo(x,62);ctx.closePath();ctx.fillStyle='#f24a34';ctx.fill();ctx.strokeStyle='#171819';ctx.lineWidth=2;ctx.stroke();
  }
  ctx.strokeStyle='#9ba2a3';ctx.lineWidth=1.5;ctx.setLineDash([7,6]);ctx.beginPath();ctx.moveTo(17,82);ctx.lineTo(344,82);ctx.stroke();ctx.setLineDash([]);
  for(let r=0;r<6;r++) for(let c=0;c<7;c++) {
    const i=r*7+c,x=31+c*49,y=112+r*33,mark=g.board[i];
    ctx.beginPath();ctx.arc(x,y,13,0,Math.PI*2);ctx.fillStyle=mark==='R'?'#f32642':mark==='Y'?'#ffd544':'#414647';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#171b1c';ctx.stroke();
    if(g.line?.includes(i)){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
  }
  for(const [i,id,color] of [[0,g.x,'#f32642'],[1,g.o,'#ffd544']]) {
    const x=16+i*177;
    ctx.fillStyle='#f2f3f5';ctx.font='bold 16px DotArabic';ctx.textAlign='left';
    let label=g.names?.[id]||'لاعب';while(ctx.measureText(label).width>155&&label.length>1)label=label.slice(0,-2)+'…';ctx.fillText(label,x,331);
    ctx.textAlign='right';ctx.font='18px DotArabic';ctx.fillStyle='#c8cbce';ctx.fillText('اللون:',x+104,365);
    ctx.beginPath();ctx.arc(x+130,359,14,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  }
  return canvas.toBuffer('image/png');
}
