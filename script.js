// ===== Configs =====
const PAY = {
  LEFT_WIN: 2.0, RIGHT_WIN: 2.0, TIE: 20.0,
  ANY_HOLE_SUITED_OR_CONN: 1.66, ANY_HOLE_PAIR: 8.5, ANY_HOLE_AA: 100.0,
  WIN_HIGH_OR_PAIR: 2.2, WIN_TWO_PAIR: 3.1, WIN_TRIPS_STRAIGHT_FLUSH: 4.7,
  WIN_FULL_HOUSE: 20.0, ANY_FOUR_OR_SF_OR_ROYAL: 248.0
};

let chips = 10000;
let selectedChip = 100;
const bets = Object.fromEntries(Object.keys(PAY).map(k=>[k,0]));
const since = Object.fromEntries(Object.keys(PAY).map(k=>[k,0]));
let history = [];
const undoStack = [];

const $ = q=>document.querySelector(q);
const $$ = q=>Array.from(document.querySelectorAll(q));
const THB = n=>Math.floor(n).toLocaleString('th-TH');
const log = (t) => {
  const box = $('#log');
  box.textContent = t;      // เขียนทับของเดิม
};

const updateChips = ()=> $('#chips').textContent = THB(chips);

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RVAL = Object.fromEntries(RANKS.map((r,i)=>[r,i+2]));

function makeDeck(){ const d=[]; for(const s of SUITS) for(const r of RANKS) d.push(r+s); return d; }
function shuf(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]] } return a; }
const cardHtml = (c)=>`<div class="card ${c[1]==='♥'||c[1]==='♦' ? 'red':''}">${c[0]}<small>${c[1]}</small></div>`;

function deal(){
  const dk = shuf(makeDeck());
  const L=[dk.pop(),dk.pop()]; const R=[dk.pop(),dk.pop()];
  const board=[dk.pop(),dk.pop(),dk.pop(),dk.pop(),dk.pop()];
  return {L,R,board};
}

function eval7(cards){
  const ranks = cards.map(c=>c[0]);
  const suits = cards.map(c=>c[1]);
  const vals = ranks.map(r=>RVAL[r]).sort((a,b)=>b-a);
  const rc={}; ranks.forEach(r=>rc[r]=(rc[r]||0)+1);
  const sc={}; suits.forEach(s=>sc[s]=(sc[s]||0)+1);
  let flushSuit=null; for(const s of SUITS) if((sc[s]||0)>=5){ flushSuit=s; break; }
  const u=[...new Set(vals)].sort((a,b)=>b-a); if(u[0]===14) u.push(1);
  let sHi=0; for(let i=0;i<=u.length-5;i++){ if(u[i]-u[i+4]===4){ sHi=u[i]; break; } }
  let sfHi=0; if(flushSuit){ const fv=cards.filter(c=>c[1]===flushSuit).map(c=>RVAL[c[0]]).sort((a,b)=>b-a); const fu=[...new Set(fv)]; if(fu[0]===14) fu.push(1); for(let i=0;i<=fu.length-5;i++){ if(fu[i]-fu[i+4]===4){ sfHi=fu[i]; break; } } }
  const groups = Object.entries(rc).map(([r,c])=>({r:RVAL[r],c})).sort((a,b)=> b.c-a.c || b.r-a.r);
  const four = groups.find(g=>g.c===4);
  const trips = groups.filter(g=>g.c===3);
  const pairs = groups.filter(g=>g.c===2);
  const key=(...k)=>k.join('-');
  if(sfHi) return {rank:9,name: sfHi===14? 'Royal Flush':'Straight Flush', key:key(9,sfHi)};
  if(four){ const kick=Math.max(...u.filter(v=>v!==four.r)); return {rank:8,name:'Four of a Kind', key:key(8,four.r,kick)}; }
  if(trips.length && (pairs.length || trips.length>1)){ const t=trips[0].r; const p=pairs.length?pairs[0].r:trips[1].r; return {rank:7,name:'Full House', key:key(7,t,p)}; }
  if(flushSuit) return {rank:6,name:'Flush', key:key(6)};
  if(sHi) return {rank:5,name:'Straight', key:key(5,sHi)};
  if(trips.length){ const ks=u.filter(v=>v!==trips[0].r).slice(0,2); return {rank:4,name:'Three of a Kind', key:key(4,trips[0].r,...ks)}; }
  if(pairs.length>=2){ const p1=pairs[0].r,p2=pairs[1].r; const k=Math.max(...u.filter(v=>v!==p1&&v!==p2)); return {rank:3,name:'Two Pair', key:key(3,p1,p2,k)}; }
  if(pairs.length===1){ const k=u.filter(v=>v!==pairs[0].r).slice(0,3); return {rank:2,name:'One Pair', key:key(2,pairs[0].r,...k)}; }
  return {rank:1,name:'High Card', key:key(1,...u.slice(0,5))};
}

const holeSuited = h=> h[0][1]===h[1][1];
function holeConn(h){
  const v1=RVAL[h[0][0]], v2=RVAL[h[1][0]]; const hi=Math.max(v1,v2), lo=Math.min(v1,v2);
  return (hi-lo===1) || (hi===14 && lo===13) || (hi===14 && lo===2);
}
const holePair = h=> h[0][0]===h[1][0];
const holeAA = h=> h[0][0]==='A' && h[1][0]==='A';

function renderDeal(pack){
  $('#leftHand').innerHTML = pack.L.map(cardHtml).join('');
  $('#rightHand').innerHTML = pack.R.map(cardHtml).join('');
  $('#board').innerHTML = pack.board.map(cardHtml).join('');
}
function clearFlags(){ $$('.tile .flag').forEach(f=>{ f.classList.remove('win','lose'); }); }
function setFlag(code, win){ const tile = document.querySelector(`.tile[data-bet="${code}"] .flag`); if(!tile) return; tile.classList.add(win? 'win':'lose'); }
function updateTileAmounts(){ $$('.tile[data-bet]').forEach(t=>{ const code=t.dataset.bet; const amt=t.querySelector('[data-amt]'); const sinceEl=t.querySelector('[data-since]'); if(amt) amt.textContent = THB(bets[code]||0); if(sinceEl) sinceEl.textContent = `ยังไม่ออก: ${since[code]} ตา`; }); }

function pushHistory(symbol){
  history.unshift(symbol); if(history.length>10) history = history.slice(0,10);
  const wrap=$('#history'); wrap.innerHTML='';
  for(const s of history){ const b=document.createElement('div'); b.className='badge ' + (s==='L'?'l': s==='R'?'r':'t'); wrap.appendChild(b); }
}

// Betting
function tryBet(code){
  if(!PAY.hasOwnProperty(code)) return;
  if(chips < selectedChip) { log('ชิปไม่พอ'); return; }
  chips -= selectedChip; updateChips();
  bets[code] = (bets[code]||0) + selectedChip;
  undoStack.push({code, amount:selectedChip});
  updateTileAmounts();
}

// handle clicks on bet tiles only
document.addEventListener('click',(e)=>{
  const tile = e.target.closest('.tile[data-bet]');
  if(tile){ tryBet(tile.dataset.bet); }
});

document.querySelectorAll('.chip').forEach((btn,i)=>{
  if(i===0) btn.classList.add('active');
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.chip').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); selectedChip = Number(btn.dataset.v);
  });
});

document.getElementById('undo').addEventListener('click',()=>{
  const last = undoStack.pop(); if(!last) return;
  bets[last.code] -= last.amount; if(bets[last.code]<0) bets[last.code]=0;
  chips += last.amount; updateChips(); updateTileAmounts();
});
document.getElementById('clearBets').addEventListener('click',()=>{
  for(const k in bets) bets[k]=0; undoStack.length=0; updateTileAmounts();
});
document.getElementById('add10k').addEventListener('click',()=>{ chips+=10000; updateChips(); });
document.getElementById('add100k').addEventListener('click',()=>{ chips+=100000; updateChips(); });

// Round
function settle(pack){
  clearFlags();
  const roundStake = Object.values(bets).reduce((a,b)=>a+b,0);
  const L = eval7([...pack.L, ...pack.board]);
  const R = eval7([...pack.R, ...pack.board]);
  document.getElementById('leftRank').textContent = L.name;
  document.getElementById('rightRank').textContent = R.name;
  let winner='T';
  if(L.rank!==R.rank) winner = L.rank>R.rank? 'L':'R'; else winner = (L.key>R.key? 'L' : (L.key<R.key? 'R':'T'));
  document.getElementById('result').textContent = winner==='L'? 'COWBOY ชนะ' : winner==='R'? 'BULL ชนะ' : 'เสมอ';

  const winEval = winner==='L'? L : winner==='R'? R : null;
  const anyHas = (fn)=> fn(L) || fn(R);
  let winTotal=0;

  const ok = {
    LEFT_WIN: winner==='L',
    RIGHT_WIN: winner==='R',
    TIE: winner==='T',
    ANY_HOLE_SUITED_OR_CONN: (holeSuited(pack.L) || holeConn(pack.L) || holeSuited(pack.R) || holeConn(pack.R)),
    ANY_HOLE_PAIR: (holePair(pack.L) || holePair(pack.R)),
    ANY_HOLE_AA: (holeAA(pack.L) || holeAA(pack.R)),
    WIN_HIGH_OR_PAIR: !!winEval && (winEval.rank===1 || winEval.rank===2),
    WIN_TWO_PAIR: !!winEval && winEval.rank===3,
    WIN_TRIPS_STRAIGHT_FLUSH: !!winEval && (winEval.rank===4 || winEval.rank===5 || winEval.rank===6),
    WIN_FULL_HOUSE: !!winEval && winEval.rank===7,
    ANY_FOUR_OR_SF_OR_ROYAL: anyHas(ev=> ev.rank>=8)
  };

  for(const code of Object.keys(PAY)){
    if(ok[code]){ since[code]=0; setFlag(code,true); } else { since[code]++; setFlag(code,false); }
  }

  for(const code of Object.keys(PAY)){
    const st = bets[code]||0; if(st>0 && ok[code]){ const gain = Math.floor(st * PAY[code]); chips += gain; winTotal += gain; }
  }

  updateChips(); updateTileAmounts();
  const profit = winTotal - roundStake;
  const pfStr = (profit>=0? `กำไร ${THB(profit)}` : `ขาดทุน ${THB(-profit)}`);
  log(`ผล: ${document.getElementById('result').textContent} | ${L.name} vs ${R.name} | ได้คืน ${THB(winTotal)} ชิป (${pfStr})`);

  pushHistory(winner);
  for(const k in bets) bets[k]=0; undoStack.length=0; updateTileAmounts();
}

document.getElementById('deal').addEventListener('click',()=>{
  const pack=deal(); renderDeal(pack); settle(pack);
});

// init
(function init(){
  updateChips();
  const back='<div class="card">?</div>';
  document.getElementById('leftHand').innerHTML=back+back;
  document.getElementById('rightHand').innerHTML=back+back;
  document.getElementById('board').innerHTML=back.repeat(5);
  updateTileAmounts();
})();
