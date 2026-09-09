// firebase-controller.js — NECIS Controller (FINAL)
// 🔥 Latency, totalSent/totalFailed, dan successRate sekarang SEMUA
// dihitung sekali oleh ESP32 dan dibaca apa adanya dari /stats — dashboard
// tidak lagi menghitung ulang dengan metode sendiri (lihat NECIS_v2.ino).

let currentWebState = false;
let shredTimerInterval = null;
let uvcTimerInterval = null;
let shredSecondsLeft = 0;
let uvcSecondsLeft = 0;
let isDeviceJammed = false;

let lastDataReceivedTime = 0;
let lastUptimeValue = -1;
let isDeviceOnline = false;
let watchdogInterval = null;

// ============================================================
//  STATISTIK
// ============================================================
let latencyHistory = [];
let totalSent = 0;
let totalFailed = 0;
let reconnectCount = 0;

// ── LOG SYSTEM ──
const LOG_STORAGE_KEY = 'necis_activity_logs_v1';

function getSavedLogs() {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveLogs(logs) {
  try {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logs));
  } catch (e) {
    console.error("Gagal menyimpan log", e);
  }
}

function renderActivityLogs() {
  const logBody = document.getElementById('activityLog');
  if (!logBody) return;
  const logs = getSavedLogs();
  if (logs.length === 0) {
    logBody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-4"><i class="fa-solid fa-inbox me-1"></i> Belum ada catatan aktivitas.</td></tr>`;
    return;
  }
  let html = '';
  let lastDateGroup = '';
  logs.forEach(log => {
    if (log.dateStr !== lastDateGroup) {
      lastDateGroup = log.dateStr;
      html += `<tr class="table-light fw-bold" style="background: rgba(13, 110, 253, 0.08);">
          <td colspan="3" style="padding: 8px 12px; color: var(--primary); font-size: 0.84rem;">
            <i class="fa-regular fa-calendar-days me-2"></i>${log.dateStr}
          </td>
        </tr>`;
    }
    const badge = log.isError ? '<span class="badge bg-danger">GAGAL</span>' : '<span class="badge bg-success">OK</span>';
    html += `<tr>
        <td style="padding:8px 12px; font-weight: 500; font-size: 0.85rem; color: var(--gray-600);">${log.timeStr}</td>
        <td style="padding:8px 12px; font-size: 0.88rem;">${log.msg}</td>
        <td style="padding:8px 12px;">${badge}</td>
      </tr>`;
  });
  logBody.innerHTML = html;
}

function addActivityLog(msg, isError = false) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const newEntry = {
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    timestamp: now.getTime(),
    dateStr: dateStr,
    timeStr: timeStr,
    msg: msg,
    isError: isError
  };
  const logs = getSavedLogs();
  logs.unshift(newEntry);
  if (logs.length > 200) logs.pop();
  saveLogs(logs);
  renderActivityLogs();
  console.log(`[LOG] ${msg}`);
}

function clearActivityLogs() {
  if (confirm("Hapus semua catatan aktivitas?")) {
    localStorage.removeItem(LOG_STORAGE_KEY);
    renderActivityLogs();
  }
}

// ── Perintah ──
function sendPowerCommand(state) {
  database.ref('/commands/power').set({ power: state })
    .then(() => {
      addActivityLog(`✅ Perintah daya ${state ? 'ON' : 'OFF'} terkirim`);
      if (state) startLocalTimers();
      else stopLocalTimers();
    })
    .catch(err => addActivityLog(`❌ Gagal kirim perintah: ${err.message}`, true));
}

function clearJamAlertWeb() {
  database.ref('/alerts/jam').remove()
    .then(() => {
      database.ref('/commands/clearJam').set({ clearJam: true });
      addActivityLog("✅ Perintah reset jam dikirim");
      document.getElementById('jamAlertBanner').style.display = 'none';
      isDeviceJammed = false;
    })
    .catch(err => addActivityLog(`❌ Gagal reset jam: ${err.message}`, true));
}

// ── Timer ──
function startLocalTimers() {
  stopLocalTimers();
  shredSecondsLeft = 30;
  updateTimerUI();
  shredTimerInterval = setInterval(() => {
    if (!isDeviceJammed && shredSecondsLeft > 0) {
      shredSecondsLeft--;
      updateTimerUI();
    } else if (shredSecondsLeft <= 0) {
      clearInterval(shredTimerInterval);
      shredTimerInterval = null;
      updateTimerUI();
    }
  }, 1000);
}

function stopLocalTimers() {
  if (shredTimerInterval) clearInterval(shredTimerInterval);
  shredTimerInterval = null;
  shredSecondsLeft = 0;
  updateTimerUI();
}

function updateTimerUI() {
  const sd = document.getElementById('shredderTimerDisplay');
  const sb = document.getElementById('shredderTimerBadge');
  const sp = document.getElementById('shredderProgressBar');
  const ud = document.getElementById('uvcTimerDisplay');
  const ub = document.getElementById('uvcTimerBadge');
  const up = document.getElementById('uvcProgressBar');

  if (sd) sd.innerText = `${shredSecondsLeft}s`;
  if (sp) {
    const pct = Math.round(((30 - shredSecondsLeft) / 30) * 100);
    sp.style.width = `${shredSecondsLeft > 0 ? (pct || 5) : 0}%`;
  }
  if (sb) {
    if (isDeviceJammed) {
      sb.className = 'badge bg-danger';
      sb.innerText = 'JAMMED (PAUSED)';
    } else if (shredSecondsLeft > 0) {
      sb.className = 'badge bg-primary';
      sb.innerText = 'RUNNING';
    } else {
      sb.className = 'badge bg-secondary';
      sb.innerText = 'IDLE';
    }
  }
  if (ud) ud.innerText = 'ON';
  if (up) up.style.width = '100%';
  if (ub) {
    ub.className = 'badge bg-success';
    ub.innerText = 'ON';
  }
}

// ── Watchdog ──
function startHeartbeatWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    if (isDeviceOnline && lastDataReceivedTime > 0 && (Date.now() - lastDataReceivedTime > 10000)) {
      isDeviceOnline = false;
      setDeviceOfflineUI();
    }
  }, 1000);
}

function setDeviceOfflineUI() {
  const ids = ['iotStatusText','iotBadgeText','iotBadge','sidebarStatus','deviceStatusText','motorSubtext',
               'deviceBadgeText','deviceBadge','powerBadgeText','powerBadge','motorIcon','motorStateBadge',
               'batteryPercent','voltageDisplay','batteryBar','batteryIconBox','needleCount','espUptime',
               'signalStrength','currentSSID','uvcTimerDisplay','uvcTimerBadge','uvcProgressBar',
               'avgLatency','minLatency','maxLatency','successRate','successCount','reconnectCount','lastReconnect'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'iotStatusText') el.innerText = 'Disconnected';
    else if (id === 'iotBadgeText') el.innerText = 'Offline';
    else if (id === 'iotBadge' || id === 'deviceBadge' || id === 'powerBadge' || id === 'sidebarStatus') el.className = 'badge-status offline';
    else if (id === 'deviceStatusText') el.innerText = 'OFF';
    else if (id === 'motorSubtext') el.innerText = 'Alat Disconnected';
    else if (id === 'deviceBadgeText') el.innerText = 'Disconnected';
    else if (id === 'powerBadgeText') el.innerText = 'OFFLINE';
    else if (id === 'motorIcon') el.className = 'fa-solid fa-gear text-secondary';
    else if (id === 'motorStateBadge') { el.className = 'badge bg-secondary'; el.innerText = 'OFFLINE'; }
    else if (id === 'batteryPercent') el.innerText = '--';
    else if (id === 'voltageDisplay') el.innerText = '-- V';
    else if (id === 'batteryBar') { el.style.width = '0%'; el.className = 'sg-progress-bar bg-secondary'; }
    else if (id === 'batteryIconBox') el.className = 'stat-icon blue';
    else if (id === 'needleCount') el.innerText = '--';
    else if (id === 'espUptime') el.innerText = '--:--:--';
    else if (id === 'signalStrength') el.innerText = '-- dBm';
    else if (id === 'currentSSID') el.innerText = 'Disconnected';
    else if (id === 'uvcTimerDisplay') el.innerText = 'OFF';
    else if (id === 'uvcTimerBadge') { el.className = 'badge bg-secondary'; el.innerText = 'OFF'; }
    else if (id === 'uvcProgressBar') el.style.width = '0%';
    else if (['avgLatency','minLatency','maxLatency','successRate','reconnectCount','lastReconnect'].includes(id)) el.innerText = '--';
    else if (id === 'successCount') el.innerText = '0 / 0 percobaan';
  });
  document.getElementById('powerToggle').checked = false;
  currentWebState = false;
}

// ============================================================
//  FUNGSI STATISTIK
// ============================================================

// 🔥 Latency: update tampilan
function updateLatencyUI(history) {
  if (history.length === 0) {
    document.getElementById('avgLatency').innerText = '--';
    document.getElementById('minLatency').innerText = '--';
    document.getElementById('maxLatency').innerText = '--';
    return;
  }
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  const min = Math.min(...history);
  const max = Math.max(...history);

  // Jika lebih dari 5 detik, tidak masuk akal → tampilkan --
  if (avg > 5000 || avg <= 0) {
    document.getElementById('avgLatency').innerText = '--';
    document.getElementById('minLatency').innerText = '--';
    document.getElementById('maxLatency').innerText = '--';
    return;
  }

  document.getElementById('avgLatency').innerText = Math.round(avg) + ' ms';
  document.getElementById('minLatency').innerText = Math.round(min) + ' ms';
  document.getElementById('maxLatency').innerText = Math.round(max) + ' ms';
}

// 🔥 Success rate — pakai angka dari ESP32 kalau ada (serverRate),
// fallback ke perhitungan lokal hanya kalau field itu belum terkirim.
function updateSuccessRate(serverRate) {
  const successful = totalSent - totalFailed;
  const rate = (typeof serverRate === 'number')
    ? serverRate
    : (totalSent > 0 ? (successful / totalSent * 100) : 0);
  document.getElementById('successRate').innerText = rate.toFixed(1);
  document.getElementById('successCount').innerText = successful + ' / ' + totalSent + ' percobaan';
}

// 🔥 Latency — langsung dari data.latency yang dikirim ESP32
// (round-trip time PATCH yang sebenarnya), bukan hasil hitungan sendiri.
function updatePushLatency(latencyMs) {
  if (typeof latencyMs !== 'number' || latencyMs < 0) {
    document.getElementById('avgLatency').innerText = '--';
    document.getElementById('minLatency').innerText = '--';
    document.getElementById('maxLatency').innerText = '--';
    return;
  }
  latencyHistory.push(latencyMs);
  if (latencyHistory.length > 30) latencyHistory.shift();
  updateLatencyUI(latencyHistory);
}

// 🔥 Listener tambahan
function initAdditionalListeners() {
  // Satu listener untuk /stats: totalSent, totalFailed, successRate, dan
  // latency semua di-update BERSAMAAN (ESP32 mengirimnya dalam satu PATCH),
  // jadi dashboard tidak pernah menampilkan kombinasi angka yang tanggung.
  database.ref('/stats').on('value', snap => {
    const s = snap.val() || {};
    totalSent = s.totalSent || 0;
    totalFailed = s.totalFailed || 0;
    updateSuccessRate(s.successRate);
    updatePushLatency(s.latency);
  });
  database.ref('/status/wifiReconnectCount').on('value', snap => {
    reconnectCount = snap.val() || 0;
    document.getElementById('reconnectCount').innerText = reconnectCount;
  });
  database.ref('/status/lastReconnectTime').on('value', snap => {
    const ts = snap.val();
    if (ts) {
      if (ts < 10000000000) {
        const sec = Math.floor(ts / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        document.getElementById('lastReconnect').innerText = `${h}h ${m}m ${s}s`;
      } else {
        document.getElementById('lastReconnect').innerText = new Date(ts).toLocaleString('id-ID');
      }
    } else {
      document.getElementById('lastReconnect').innerText = '--';
    }
  });
}

// ============================================================
//  LISTENER UTAMA /sensors
// ============================================================
function initFirebaseListeners() {
  startHeartbeatWatchdog();
  const sensorsRef = database.ref('/sensors');
  sensorsRef.on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      addActivityLog("⚠️ Menunggu sinyal dari ESP32...", false);
      setDeviceOfflineUI();
      return;
    }

    // Heartbeat
    const currentUptime = data.uptime !== undefined ? data.uptime : -1;
    if (currentUptime !== lastUptimeValue) {
      lastDataReceivedTime = Date.now();
      lastUptimeValue = currentUptime;
      isDeviceOnline = true;
    } else if (Date.now() - lastDataReceivedTime > 10000) {
      isDeviceOnline = false;
      setDeviceOfflineUI();
      return;
    }
    if (!isDeviceOnline) {
      setDeviceOfflineUI();
      return;
    }

    // ========== UPDATE UI ==========
    // UV-C
    document.getElementById('uvcTimerDisplay').innerText = 'ON';
    document.getElementById('uvcTimerBadge').className = 'badge bg-success';
    document.getElementById('uvcTimerBadge').innerText = 'ON';
    document.getElementById('uvcProgressBar').style.width = '100%';

    // Battery
    const battery = data.battery !== undefined ? data.battery : 0;
    const voltage = data.voltage || 0;
    document.getElementById('batteryPercent').innerText = battery;
    document.getElementById('voltageDisplay').innerText = voltage.toFixed(1) + ' V';
    const bar = document.getElementById('batteryBar');
    const iconBox = document.getElementById('batteryIconBox');
    if (bar) {
      bar.style.width = battery + '%';
      if (battery > 50) {
        bar.className = 'sg-progress-bar bg-success';
        if (iconBox) iconBox.className = 'stat-icon green';
      } else if (battery > 20) {
        bar.className = 'sg-progress-bar bg-warning';
        if (iconBox) iconBox.className = 'stat-icon cyan';
      } else {
        bar.className = 'sg-progress-bar bg-danger';
        if (iconBox) iconBox.className = 'stat-icon red';
      }
    }

    // Needle
    document.getElementById('needleCount').innerText = data.needleCount || 0;

    // Motor
    const motorOn = data.motorStatus === true;
    document.getElementById('deviceStatusText').innerText = motorOn ? 'ON' : 'OFF';
    document.getElementById('powerBadgeText').innerText = motorOn ? 'RUNNING' : 'STANDBY';
    document.getElementById('powerBadge').className = `badge-status ${motorOn ? 'online' : 'offline'}`;

    const badgeText = document.getElementById('deviceBadgeText');
    const badge = document.getElementById('deviceBadge');
    const subtext = document.getElementById('motorSubtext');
    const stateBadge = document.getElementById('motorStateBadge');

    if (motorOn) {
      if (badgeText) badgeText.innerText = 'Active';
      if (badge) badge.className = 'badge-status online';
      if (subtext) subtext.innerText = 'Shredder Running';
      if (stateBadge) { stateBadge.className = 'badge bg-primary fw-semibold'; stateBadge.innerText = 'SHREDDING'; }
    } else {
      if (badgeText) badgeText.innerText = 'Standby';
      if (badge) badge.className = 'badge-status online';
      if (subtext) subtext.innerText = 'Motor Siap (Standby)';
      if (stateBadge) { stateBadge.className = 'badge bg-secondary'; stateBadge.innerText = 'IDLE'; }
    }

    const icon = document.getElementById('motorIcon');
    if (icon) {
      icon.className = motorOn ? 'fa-solid fa-gear fa-spin text-primary' : 'fa-solid fa-gear text-secondary';
    }

    const toggle = document.getElementById('powerToggle');
    if (toggle && toggle.checked !== motorOn) toggle.checked = motorOn;
    currentWebState = motorOn;

    if (motorOn && shredSecondsLeft === 0 && !isDeviceJammed) {
      startLocalTimers();
    }

    // IoT status
    document.getElementById('iotStatusText').innerText = 'Connected';
    document.getElementById('iotBadgeText').innerText = 'Online';
    document.getElementById('iotBadge').className = 'badge-status online';
    document.getElementById('sidebarStatus').className = 'badge-status online';

    // Telemetri
    if (data.wifiSSID) {
      const el = document.getElementById('currentSSID');
      if (el) el.innerText = data.wifiSSID;
    }
    if (data.rssi) {
      const el = document.getElementById('signalStrength');
      if (el) el.innerText = data.rssi + ' dBm';
    }
    if (data.uptime !== undefined) {
      const el = document.getElementById('espUptime');
      if (el) {
        const h = Math.floor(data.uptime / 3600);
        const m = Math.floor((data.uptime % 3600) / 60);
        const s = Math.floor(data.uptime % 60);
        el.innerText = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
      }
    }

    // Catatan: latency sekarang datang lewat listener /stats
    // (initAdditionalListeners → updatePushLatency), bukan dari sini.

  }, (error) => {
    addActivityLog(`Error sensor: ${error.message}`, true);
    setDeviceOfflineUI();
  });

  // Anti-Jam
  database.ref('/alerts/jam').on('value', (snap) => {
    const alertData = snap.val();
    const banner = document.getElementById('jamAlertBanner');
    const retryElem = document.getElementById('jamRetryCount');
    const subtext = document.getElementById('motorSubtext');
    const stateBadge = document.getElementById('motorStateBadge');

    if (alertData && alertData.status === 'JAM_STUCK') {
      isDeviceJammed = true;
      if (banner) banner.style.display = 'block';
      if (retryElem) retryElem.innerText = `Retries: ${alertData.retries || 0} / 5`;
      if (subtext) subtext.innerText = 'Motor Macet! Auto Reverse';
      if (stateBadge) { stateBadge.className = 'badge bg-danger fw-bold'; stateBadge.innerText = 'JAMMED'; }
      addActivityLog(`⚠️ ALARM ANTI-JAM: Motor tersumbat! (Retry ${alertData.retries || 0})`, true);
      updateTimerUI();
    } else {
      isDeviceJammed = false;
      if (banner) banner.style.display = 'none';
      if (subtext && !currentWebState) subtext.innerText = 'Motor Siap (Standby)';
      if (stateBadge && !currentWebState) { stateBadge.className = 'badge bg-secondary'; stateBadge.innerText = 'IDLE'; }
      updateTimerUI();
    }
  });

  // Status WiFi
  database.ref('/status/wifi').on('value', (snap) => {
    const status = snap.val();
    const div = document.getElementById('wifiStatus');
    if (!div) return;
    if (status === 'connecting') {
      div.innerHTML = '<span class="text-warning small">⏳ Menghubungkan ke WiFi baru...</span>';
      div.style.display = 'block';
    } else if (status === 'connected') {
      div.innerHTML = '<span class="text-success small">✅ WiFi berhasil diubah!</span>';
      div.style.display = 'block';
      setTimeout(() => div.style.display = 'none', 3500);
    } else if (status === 'failed') {
      div.innerHTML = '<span class="text-danger small">❌ Gagal terhubung ke WiFi baru.</span>';
      div.style.display = 'block';
    } else {
      div.style.display = 'none';
    }
  });
}

// ── Fungsi lainnya ──
function resetNeedle() {
  database.ref('/commands/resetNeedle').set({ resetNeedle: true })
    .then(() => addActivityLog('📌 Perintah reset needle dikirim'))
    .catch(err => addActivityLog(`Gagal reset needle: ${err.message}`, true));
}

function restartESP() {
  if (confirm('Restart ESP32?')) {
    database.ref('/commands/restart').set({ restart: true })
      .then(() => addActivityLog('🔄 Perintah restart ESP32 dikirim'))
      .catch(err => addActivityLog(`Gagal restart: ${err.message}`, true));
  }
}

function setWiFi(ssid, password) {
  if (!ssid) { alert('SSID wajib diisi!'); return false; }
  database.ref('/commands/wifi').set({ ssid, password })
    .then(() => {
      addActivityLog(`📡 Perintah ganti WiFi ke "${ssid}" dikirim`);
      const div = document.getElementById('wifiStatus');
      if (div) {
        div.innerHTML = '<span class="text-info small">📡 Mengirim konfigurasi, ESP32 restart...</span>';
        div.style.display = 'block';
      }
    })
    .catch(err => addActivityLog(`Gagal kirim WiFi: ${err.message}`, true));
  return true;
}

// ============================================================
//  DOM READY
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  renderActivityLogs();
  setDeviceOfflineUI();

  if (typeof database === 'undefined') {
    console.error('Firebase tidak terdefinisi.');
    return;
  }

  initFirebaseListeners();
  initAdditionalListeners();

  document.getElementById('powerToggle')?.addEventListener('change', e => sendPowerCommand(e.target.checked));
  document.getElementById('startCycleBtn')?.addEventListener('click', () => sendPowerCommand(true));
  document.getElementById('resetNeedleBtn')?.addEventListener('click', resetNeedle);
  document.getElementById('reconnectBtn')?.addEventListener('click', restartESP);

  document.getElementById('wifiForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const ssid = document.getElementById('wifiSSID').value.trim();
    const pass = document.getElementById('wifiPassword').value;
    setWiFi(ssid, pass);
  });

  document.getElementById('togglePassBtn')?.addEventListener('click', () => {
    const inp = document.getElementById('wifiPassword');
    if (inp.type === 'password') {
      inp.type = 'text';
      document.getElementById('togglePassBtn').innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
    } else {
      inp.type = 'password';
      document.getElementById('togglePassBtn').innerHTML = '<i class="fa-solid fa-eye"></i>';
    }
  });

  addActivityLog('Dashboard NECIS Siap.');
});