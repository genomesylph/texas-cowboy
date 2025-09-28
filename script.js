// ===== Configs =====
const PAY = {
  LEFT_WIN: 2.0, RIGHT_WIN: 2.0, TIE: 20.0,
  ANY_HOLE_SUITED_OR_CONN: 1.66, ANY_HOLE_PAIR: 8.5, ANY_HOLE_AA: 100.0,
  WIN_HIGH_OR_PAIR: 2.2, WIN_TWO_PAIR: 3.1, WIN_TRIPS_STRAIGHT_FLUSH: 4.7,
  WIN_FULL_HOUSE: 20.0, ANY_FOUR_OR_SF_OR_ROYAL: 248.0
};

let chips = 1000;
let selectedChip = 100;
const bets = Object.fromEntries(Object.keys(PAY).map(k=>[k,0]));
window.bets = bets; // bind global to the same object

const since = Object.fromEntries(Object.keys(PAY).map(k=>[k,0]));
let history = [];
const undoStack = [];

const $ = q=>document.querySelector(q);
const $$ = q=>Array.from(document.querySelectorAll(q));
const THB = n=>Math.floor(n).toLocaleString('th-TH');

// log แสดงบรรทัดล่าสุดเท่านั้น
const log = (t) => { $('#log').textContent = t; };

const updateChips = ()=> $('#chips').textContent = THB(chips);

// Cards
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

// Evaluate best of 7
// 9 SF, 8 Quads, 7 FH, 6 Flush, 5 Straight, 4 Trips, 3 TwoPair, 2 Pair, 1 High
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

  if(sfHi){
    // แจ้งเตือนเมื่อเป็นสเตรทฟลัช/รอยัล (จะทำให้ side bet ×248 ติดด้วย)
    return {rank:9,name: sfHi===14? 'รอยัลฟลัช':'สเตรทฟลัช', key:key(9,sfHi)};
  }
  if(four){
    const kick=Math.max(...u.filter(v=>v!==four.r));
    return {rank:8,name:'โฟร์การ์ด', key:key(8,four.r,kick)};
  }
  if(trips.length && (pairs.length || trips.length>1)){ const t=trips[0].r; const p=pairs.length?pairs[0].r:trips[1].r; return {rank:7,name:'ฟูลเฮาส์', key:key(7,t,p)}; }
  if(flushSuit) return {rank:6,name:'ฟลัช', key:key(6)};
  if(sHi) return {rank:5,name:'สเตรท', key:key(5,sHi)};
  if(trips.length){ const ks=u.filter(v=>v!==trips[0].r).slice(0,2); return {rank:4,name:'ตอง', key:key(4,trips[0].r,...ks)}; }
  if(pairs.length>=2){ const p1=pairs[0].r,p2=pairs[1].r; const k=Math.max(...u.filter(v=>v!==p1&&v!==p2)); return {rank:3,name:'สองคู่', key:key(3,p1,p2,k)}; }
  if(pairs.length===1){ const k=u.filter(v=>v!==pairs[0].r).slice(0,3); return {rank:2,name:'หนึ่งคู่', key:key(2,pairs[0].r,...k)}; }
  return {rank:1,name:'ไพ่สูง', key:key(1,...u.slice(0,5))};
}

// Hole-card side bet helpers
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
function pushHistory(symbol){
  history.unshift(symbol);
  if (history.length > 10) history.splice(10);
  const wrap = $('#history'); wrap.innerHTML = '';
  history.forEach((s, i) => {
    const b = document.createElement('div');
    b.className = 'badge ' + (s === 'L' ? 'l' : s === 'R' ? 'r' : 't') + (i === 0 ? ' latest' : '');
    wrap.appendChild(b);
  });
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
document.getElementById('add1k').addEventListener('click',()=>{ chips+=1000; updateChips(); });
document.getElementById('add10k').addEventListener('click',()=>{ chips+=10000; updateChips(); });

// Round
function settle(pack){
  clearFlags();
  const roundStake = Object.values(bets).reduce((a,b)=>a+b,0);

  const L = eval7([...pack.L, ...pack.board]);
  const R = eval7([...pack.R, ...pack.board]);

  $('#leftRank').textContent = L.name;
  $('#rightRank').textContent = R.name;

  // ใครชนะ
  let winner='T';
  if (L.rank !== R.rank) winner = (L.rank > R.rank ? 'L' : 'R');
  else winner = (L.key > R.key ? 'L' : (L.key < R.key ? 'R' : 'T'));

  $('#result').textContent = (winner==='L' ? 'COWBOY ชนะ' : (winner==='R' ? 'BULL ชนะ' : 'เสมอ'));

  // กำหนด rank สำหรับกลุ่ม "ไพ่ของผู้ชนะ"
  const winRank = (winner==='T') ? L.rank : (winner==='L' ? L.rank : R.rank);

  

  // mapping จ่ายรางวัล
  const ok = {
    // ผู้ชนะซ้าย/ขวา/เสมอ (มีไว้เผื่อคุณมี PAY สำหรับอันนี้)
    LEFT_WIN:  (winner === 'L'),
    RIGHT_WIN: (winner === 'R'),
    TIE:       (winner === 'T'),

    // ฝั่งใดก็ได้ / พิเศษ
    ANY_HOLE_SUITED_OR_CONN: (holeSuited(pack.L) || holeConn(pack.L) || holeSuited(pack.R) || holeConn(pack.R)),
    ANY_HOLE_PAIR:           (holePair(pack.L) || holePair(pack.R)),
    ANY_HOLE_AA:             (holeAA(pack.L) || holeAA(pack.R)),

    // ไพ่ของผู้ชนะ (หรือ rank ที่เสมอกัน)
    WIN_HIGH_OR_PAIR:         (winRank === 1 || winRank === 2),
    WIN_TWO_PAIR:             (winRank === 3),
    WIN_TRIPS_STRAIGHT_FLUSH: (winRank === 4 || winRank === 5 || winRank === 6),
    WIN_FULL_HOUSE:           (winRank === 7),

    // ×248: ฝั่งใดฝั่งหนึ่งได้ Quads/Straight Flush/Royal
    ANY_FOUR_OR_SF_OR_ROYAL: (L.rank >= 8 || R.rank >= 8)
  };

  // ตั้งธงชนะ/แพ้ + นับ "ยังไม่ออก"
  for (const code of Object.keys(PAY)) {
    if (ok[code]) { since[code]=0; setFlag(code,true); }
    else          { since[code]++; setFlag(code,false); }
  }

  // คิดเงิน
  let winTotal = 0;
  for (const code of Object.keys(PAY)) {
    const st = bets[code] || 0;
    if (st > 0 && ok[code]) {
      const gain = Math.floor(st * PAY[code]);
      chips += gain; winTotal += gain;
    }
  }

  updateChips(); updateTileAmounts();
  const profit = winTotal - roundStake;
  const pfStr = (profit>=0 ? `กำไร ${THB(profit)}` : `ขาดทุน ${THB(-profit)}`);
  log(`ผล: ${$('#result').textContent} | ${L.name} vs ${R.name} | ได้คืน ${THB(winTotal)} ชิป (${pfStr})`);

  // >>> ส่งผลไป ESP32 ให้เก็บสถิติกลาง (แก้ตรงนี้)
  try {
    const winners = Object.keys(PAY).filter(code => ok[code]);
    // ฝั่งที่ชนะสำหรับ history: ใช้ 'S' แทนเสมอ (ไม่ใช้ 'T')
    const winnerSide = (winner === 'L' ? 'L' : (winner === 'R' ? 'R' : 'S'));
    if (window.mqttPublishWinners) window.mqttPublishWinners(winners, winnerSide);
  } catch(e) {
    console.warn('cannot publish winners', e);
  }

  // ล้างเดิมพัน
  for (const k in bets) bets[k]=0;
  undoStack.length = 0;
  updateTileAmounts();
}


$('#deal').addEventListener('click',()=>{
  const pack=deal(); renderDeal(pack); settle(pack);
});

// init
(function init(){
  updateChips();
  const back='<div class="card">?</div>';
  $('#leftHand').innerHTML=back+back;
  $('#rightHand').innerHTML=back+back;
  $('#board').innerHTML=back.repeat(5);
  updateTileAmounts();
})();


// === MQTT helpers (Step 1) ===
window.renderReveal = ({roundId, L, R, board}) => {
  try {
    const suit = s => ({s:'♠',h:'♥',d:'♦',c:'♣'}[s] || s);
    const norm = c => (c && c.length>=2) ? (c[0] + suit(c[1])) : c;
    const pack = { L: (L||[]).map(norm), R: (R||[]).map(norm), board: (board||[]).map(norm) };
    if (typeof renderDeal === 'function') renderDeal(pack);
    if (typeof settle     === 'function') settle(pack);
  } catch(e){ console.error('renderReveal error:', e); }
};

// อัปเดตสถานะจาก ESP32 — เริ่ม flip แค่ครั้งเดียวตอนเข้า FLIP
window.__lastPhase = window.__lastPhase ?? null;

window.updateUIStateFromServer = function(state){
  const { phase, countdown, roundId } = state || {};

  // เปลี่ยนเฟสครั้งแรก/ครั้งใหม่ ค่อยจัดหน้า UI
  if (phase !== window.__lastPhase) {
    if (phase === 'BETTING') {
      // --- วาง "ไพ่หงายหลัง" แบบนิ่ง ๆ 2-2-5 ---
      const left  = document.querySelector('#leftHand');
      const right = document.querySelector('#rightHand');
      const board = document.querySelector('#board');
      if (left && right && board) {
        left.replaceChildren(); right.replaceChildren(); board.replaceChildren();
        const makeBack = () => {
          const c = document.createElement('div');
          c.className = 'card3d';
          // animation:none; และคงหมุนที่ 0deg เพื่อให้เห็น "หลังไพ่" ตลอด
          c.innerHTML = `
            <div class="inner" style="animation:none; transform:rotateY(0deg)">
              <div class="face back"></div>
              <div class="face front"></div>
            </div>`;
          return c;
        };
        // มือซ้าย/ขวา อย่างละ 2 ใบ
        left.append(makeBack(), makeBack());
        right.append(makeBack(), makeBack());
        // บอร์ด 5 ใบ
        for (let i = 0; i < 5; i++) board.appendChild(makeBack());
      }

    } else if (phase === 'FLIP') {
      // --- เริ่มอนิเมชันพลิกไพ่ 4 วิ ---
      // (placeholder จะถูกล้างและแทนที่ด้วยไพ่จริงใน renderReveal)
      if (typeof window.mountFlipPlaceholders === 'function') {
        window.mountFlipPlaceholders();
      }

    } else if (phase === 'RESULT') {
      // ไม่ต้องทำอะไรที่นี่ ให้ renderReveal(msg) มาจัดการเปิดไพ่จริงและคิดผล
      // (ถ้าอยากเคลียร์ placeholder เผื่อเหตุการณ์มาก่อน ก็ทำเผื่อได้)
      // document.querySelector('#leftHand')?.replaceChildren();
      // document.querySelector('#rightHand')?.replaceChildren();
      // document.querySelector('#board')?.replaceChildren();
    }

    window.__lastPhase = phase;
  }

  // อัปเดตข้อความสถานะ/นาฬิกาถอยหลัง (ถ้ามี element)
  const phaseName = phase==='BETTING' ? 'เปิดให้แทง'
                  : phase==='FLIP'    ? 'กำลังพลิกไพ่'
                  : phase==='RESULT'  ? 'แสดงผล'
                  : (phase || '');

  const phaseEl = document.getElementById('phaseLabel');
  if (phaseEl) phaseEl.textContent = phaseName;

  const cdEl = document.getElementById('countdown');
  if (cdEl) cdEl.textContent = String(countdown ?? '');

  // log เดิมเพื่อดีบัก
  if (typeof log === 'function') {
    log(`${phaseName} - เหลือ ${countdown} วิ (รอบ #${roundId})`);
  }
};

// วาง placeholder การ์ดหลัง (2 ใบซ้าย, 2 ใบขวา, 5 ใบกลาง) พร้อม delay ไล่จังหวะ
window.mountFlipPlaceholders = function(){
  const left  = document.querySelector('#leftHand');
  const right = document.querySelector('#rightHand');
  const board = document.querySelector('#board');
  if (!left || !right || !board) return;

  // เคลียร์ของเก่าก่อน กันซ้อน
  left.replaceChildren(); right.replaceChildren(); board.replaceChildren();

  const makeCard = (delay=0) => {
    const c = document.createElement('div');
    c.className = 'card3d';
    c.innerHTML = `
      <div class="inner" style="--flip-delay:${delay}ms">
        <div class="face back"></div>
        <div class="face front"></div>
      </div>`;
    return c;
  };

  // ซ้าย–ขวา: 2 ใบ (สลับดีเลย์เล็กน้อย)
  left.appendChild(makeCard(0));
  left.appendChild(makeCard(120));
  right.appendChild(makeCard(0));
  right.appendChild(makeCard(120));

  // กระดาน: 5 ใบ (ไล่ดีเลย์ให้ไหล)
  const delays = [0, 90, 180, 270, 360];
  delays.forEach(d => board.appendChild(makeCard(d)));
};


/* === render 10-dot history === */
window.renderHistoryDots = function(H){
  const wrap = document.getElementById('history');
  if (!wrap) return;
  wrap.innerHTML = '';
  const last10 = H.slice(-10);
  last10.forEach((entry, idx) => {
    const d = document.createElement('div');
    const w = (entry && entry.winner || '').toUpperCase();
    d.className = 'dot ' + (w==='L'?'l':w==='R'?'r':'s');
    d.title = `รอบ #${entry.roundId} : ${w==='L'?'ซ้ายชนะ':w==='R'?'ขวาชนะ':'เสมอ'}`;

    // ครอบ [] ถ้าเป็นจุดสุดท้าย
    if (idx === last10.length - 1) {
      const leftBracket = document.createElement('span');
      leftBracket.textContent = '[';
      const rightBracket = document.createElement('span');
      rightBracket.textContent = ']';

      wrap.appendChild(leftBracket);
      wrap.appendChild(d);
      wrap.appendChild(rightBracket);
    } else {
      wrap.appendChild(d);
    }
  });
};
document.getElementById('deal')?.remove();



/* === patched: keep mini 6-dots after UI updates === */
// === UPDATE ONLY AMOUNTS; DO NOT TOUCH [data-since] ===
// === UPDATE ONLY AMOUNTS; DO NOT TOUCH [data-since] ===
function updateTileAmounts(){
  document.querySelectorAll('.tile[data-bet]').forEach(tile => {
    const code  = tile.dataset.bet;
    const amtEl = tile.querySelector('[data-amt]') || tile.querySelector('.amt') || tile.querySelector('.bet-amt');
    if (!amtEl) return;
    const val = Number((typeof bets !== 'undefined' && bets && bets[code]) ? bets[code] : 0);
    if (typeof THB === 'function') amtEl.textContent = THB(val);
    else amtEl.textContent = String(val);
  });
}
window.updateTileAmounts = updateTileAmounts;
;
function updateTimeAmount(){
  document.querySelectorAll('.tile[data-bet]').forEach(tile => {
    const code = tile.dataset.bet;

    // รองรับหลายชื่อ selector: [data-amt] | .amt | .bet-amt
    const amtEl =
      tile.querySelector('[data-amt]') ||
      tile.querySelector('.amt') ||
      tile.querySelector('.bet-amt');

    if (!amtEl) return;

    const val = Number(window.bets[code] || 0);

    // ถ้ามี THB() ก็ format ด้วย ไม่งั้นแสดงเลขดิบ
    amtEl.textContent = (typeof THB === 'function') ? THB(val) : String(val);
  });
}
// ให้ global ชี้ตัวจริงเสมอ (กันไปเรียก stub)
window.updateTileAmounts = updateTileAmounts;


// --- Reset ผลช่วงเปิดให้แทง ---
function resetRoundUIForBetting(){
  // เคลียร์ข้อความผล
  const ids = ['leftRank', 'rightRank', 'result'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '–';
  });
  // ถ้าต้องการให้คาดว่าเป็น “หลังไพ่” ให้เติม class/สัญลักษณ์เองได้:
  // เช่น ซ่อนกระดาน/ไพ่บนโต๊ะ:
  // const board = document.getElementById('boardCards');
  // if (board) board.classList.add('is-hidden'); // หรือ board.innerHTML = '';
}

(function(){
  // เก็บสถานะเฟสล่าสุดเพื่อกันรีเซ็ตซ้ำโดยไม่จำเป็น
  let __lastPhaseForReset = null;

  // เก็บของเดิมไว้แล้วพันทับ
  const __oldUpdate = window.updateUIStateFromServer || function(){};

  window.updateUIStateFromServer = function(state){
    try{
      const phase = state && state.phase;
      // เข้า BETTING ครั้งแรกของรอบ → รีเซ็ตข้อความผล
      if (phase === 'BETTING' && __lastPhaseForReset !== 'BETTING'){
        resetRoundUIForBetting();
      }
      __lastPhaseForReset = phase;
    }catch(e){ console.warn('resetRoundUI error:', e); }

    // ทำงานเดิมต่อ
    __oldUpdate(state);
  };
})();


