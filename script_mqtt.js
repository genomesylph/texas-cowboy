// script_mqtt.js — subscribe mini6 (6 เกมล่าสุดจริงจาก ESP32) + เงื่อนไข streak>=10 แสดงข้อความ
(function(){
  const cfg = window.MQTT_CONFIG || {};
  const client = mqtt.connect(cfg.BROKER_URL, {
    clientId: `web_${Math.random().toString(16).slice(2,8)}`,
    protocolVersion: 4, clean: true, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 15000
  });

  function renderMiniSeries(el, series, streak){
    if (!el) return;
    const n = Number(streak)||0;

    // ถ้าเกิน 10 ตา → ข้อความแทนจุด
    if (n >= 10) {
      el.classList.remove('mini-dots-wrap');
      el.textContent = `ยังไม่ออก: ${n} ตา`;
      return;
    }

    // series = [0/1 or false/true] ซ้าย->ขวา, ขวาสุด = ล่าสุด
    const arr = Array.isArray(series) ? series.map(v => !!v) : [];
    // ให้มี 6 ตัวเสมอ (ถ้าขาด เติม false ทางซ้าย)
    while (arr.length < 6) arr.unshift(false);
    if (arr.length > 6) arr.splice(0, arr.length - 6);

    el.classList.add('mini-dots-wrap');
    el.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mini-dots';
    arr.forEach((hit, i) => {
      const dot = document.createElement('i');
      dot.className = `mdot ${hit ? 'g' : 'r'}${i === arr.length - 1 ? ' latest' : ''}`;
      wrap.appendChild(dot);
    });
    el.appendChild(wrap);
  }

  client.on('connect', () => {
    client.subscribe(cfg.TOPIC_STATE,   { qos:0 });
    client.subscribe(cfg.TOPIC_REVEAL,  { qos:0 });
    client.subscribe(cfg.TOPIC_STREAKS, { qos:0 }); // ใช้ดูเงื่อนไข >=10
    client.subscribe(cfg.TOPIC_HISTORY, { qos:0 }); // 10 จุดบน
    client.subscribe('cowboy/stats/mini6', { qos:0 }); // <-- mini6 จาก ESP32
  });

  client.on('message', (topic, payload) => {
    try{
      const msg = JSON.parse(payload.toString());

      if (topic === cfg.TOPIC_STATE) {
        window.updateUIStateFromServer?.(msg);

      } else if (topic === cfg.TOPIC_REVEAL) {
        window.renderReveal?.(msg);

      } else if (topic === cfg.TOPIC_HISTORY) {
        const H = msg && msg.history;
        if (Array.isArray(H)) window.renderHistoryDots?.(H);

      } else if (topic === cfg.TOPIC_STREAKS) {
        // แค่เก็บ n ไว้ใน data-attr เพื่อให้ renderMiniSeries ตัดสินใจ >=10
        const s = msg && msg.streaks;
        if (s && typeof s === 'object') {
          Object.entries(s).forEach(([code, n]) => {
            const tile = document.querySelector(`.tile[data-bet="${code}"]`);
            if (tile) tile.dataset.streak = String(Number(n)||0);
          });
        }

      } else if (topic === 'cowboy/stats/mini6') {
        // { mini6: { CODE: [0/1,... max6], ... } }
        const m = msg && msg.mini6;
        if (m && typeof m === 'object') {
          Object.entries(m).forEach(([code, arr]) => {
            const tile = document.querySelector(`.tile[data-bet="${code}"]`);
            const el = tile?.querySelector('[data-since]');
            const streak = Number(tile?.dataset.streak || 0);
            if (el) renderMiniSeries(el, arr, streak);
          });
        }
      }
    }catch(e){
      console.error('[MQTT] message parse error', e);
    }
  });

  // ส่ง winners (เหมือนเดิม)
  window.mqttPublishWinners = function(winners, winnerSide){
    try{
      if (!Array.isArray(winners)) winners = [];
      const payload = JSON.stringify({ winners, winnerSide });
      client.publish(cfg.TOPIC_WINNERS, payload, { qos:0, retain:false });
    }catch(e){ console.error('publish winners failed', e); }
  };
})();
