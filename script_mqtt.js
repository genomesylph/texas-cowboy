// script_mqtt.js — sync streaks & history via MQTT (retain) + publish winners (with winnerSide)
(function(){
  const cfg = window.MQTT_CONFIG || {};
  const client = mqtt.connect(cfg.BROKER_URL, {
    clientId: `web_${Math.random().toString(16).slice(2,8)}`,
    protocolVersion: 4, clean: true, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 15000
  });

  let clientId = "";

  client.on('connect', () => {
    clientId = client.options?.clientId || clientId;
    console.log('[MQTT] connected', clientId);
    client.subscribe(cfg.TOPIC_STATE,   { qos: 0 });
    client.subscribe(cfg.TOPIC_REVEAL,  { qos: 0 });
    client.subscribe(cfg.TOPIC_STREAKS, { qos: 0 });
    client.subscribe(cfg.TOPIC_HISTORY, { qos: 0 });
  });

  client.on('reconnect', () => console.log('[MQTT] reconnecting...'));
  client.on('close',     () => console.log('[MQTT] closed'));
  client.on('error',     (e) => console.log('[MQTT] error', e));

  client.on('message', (topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());
      if (topic === cfg.TOPIC_STATE) {
        window.updateUIStateFromServer?.(msg);

      } else if (topic === cfg.TOPIC_REVEAL) {
        window.renderReveal?.(msg);

      } else if (topic === cfg.TOPIC_STREAKS) {
        // msg: { streaks: { CODE:number, ... } }
        const s = msg && msg.streaks;
        if (s && typeof s === 'object') {
          Object.entries(s).forEach(([code, n]) => {
            const tile = document.querySelector(`.tile[data-bet="${code}"]`);
            const el = tile?.querySelector('[data-since]');
            if (el) el.textContent = `ยังไม่ออก: ${n} ตา`;
          });
        }

      } else if (topic === cfg.TOPIC_HISTORY) {
        // msg: { history: [{roundId,winner:'L'|'R'|'S'}...] }
        const H = msg && msg.history;
        if (Array.isArray(H)) {
          window.renderHistoryDots?.(H);
        }
      }
    } catch (e) {
      console.error('[MQTT] message parse error', e);
    }
  });

  // Publish winners to ESP32 (include winnerSide so server can store correct history)
  window.mqttPublishWinners = function(winners, winnerSide){
    try{
      if (!Array.isArray(winners)) winners = [];
      const payload = JSON.stringify({ winners, winnerSide });
      client.publish(cfg.TOPIC_WINNERS, payload, { qos: 0, retain: false });
      console.log('[MQTT] winners published', payload);
    }catch(e){ console.error('publish winners failed', e); }
  };
})();
