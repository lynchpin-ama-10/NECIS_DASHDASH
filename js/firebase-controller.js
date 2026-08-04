// firebase-controller.js — NECIS Controller
// Synchronized with ESP32 (NECIS_v2.ino) & Realtime Firebase

let currentWebState = false;
let shredTimerInterval = null;
let uvcTimerInterval = null;
let shredSecondsLeft = 0;
let uvcSecondsLeft = 0;
let isDeviceJammed = false;

// Watchdog & Heartbeat tracking
let lastDataReceivedTime = 0;
let lastUptimeValue = -1;
let watchdogInterval = null;

// Helper: Tambah log ke tabel aktivitas
function addActivityLog(msg, isError = false) {
  const logBody = document.getElementById('activityLog');
  if (!logBody) return;
  const time = new Date().toLocaleTimeString();
  const statusBadge = isError 
    ? '<span class="badge bg-danger">GAGAL</span>' 
    : '<span class="badge bg-success">OK</span>';
  const row = `<tr>
    <td style="padding:8px 12px; font-weight: 500;">${time}</td>
    <td style="padding:8px 12px;">${msg}</td>
    <td style="padding:8px 12px;">${statusBadge}</td>
  </tr>`;
  logBody.insertAdjacentHTML('afterbegin', row);
  if (logBody.children.length > 25) logBody.lastElementChild.remove();
  console.log(`[LOG] ${msg}`);
}

function clearActivityLogs() {
  const logBody = document.getElementById('activityLog');
  if (logBody) logBody.innerHTML = '';
}

// Kirim perintah power / cycle ke Firebase
function sendPowerCommand(state) {
  const cmdRef = database.ref('/commands/power');
  return cmdRef.set({ power: state })
    .then(() => {
      addActivityLog(`✅ Perintah daya ${state ? 'ON (Start Cycle)' : 'OFF'} terkirim ke Firebase`);
      if (state) {
        startLocalTimers();
      } else {
        stopLocalTimers();
      }
    })
    .catch(err => {
      addActivityLog(`❌ Gagal kirim perintah: ${err.message}`, true);
    });
}

// Reset Anti-Jam alert dari website
function clearJamAlertWeb() {
  database.ref('/alerts/jam').remove()
    .then(() => {
      database.ref('/commands/clearJam').set({ clearJam: true });
      addActivityLog("✅ Perintah reset jam (Anti-Macet) dikirim ke alat");
      const banner = document.getElementById('jamAlertBanner');
      if (banner) banner.style.display = 'none';
      isDeviceJammed = false;
    })
    .catch(err => {
      addActivityLog(`❌ Gagal reset jam: ${err.message}`, true);
    });
}

// Control local timers matching ESP32 (Shredder 30s, UV-C 60s)
function startLocalTimers() {
  stopLocalTimers();
  shredSecondsLeft = 30;
  uvcSecondsLeft = 60;
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

  uvcTimerInterval = setInterval(() => {
    if (!isDeviceJammed && uvcSecondsLeft > 0) {
      uvcSecondsLeft--;
      updateTimerUI();
    } else if (uvcSecondsLeft <= 0) {
      clearInterval(uvcTimerInterval);
      uvcTimerInterval = null;
      updateTimerUI();
    }
  }, 1000);
}

function stopLocalTimers() {
  if (shredTimerInterval) clearInterval(shredTimerInterval);
  if (uvcTimerInterval) clearInterval(uvcTimerInterval);
  shredTimerInterval = null;
  uvcTimerInterval = null;
  shredSecondsLeft = 0;
  uvcSecondsLeft = 0;
  updateTimerUI();
}

function updateTimerUI() {
  const shredDisplay = document.getElementById('shredderTimerDisplay');
  const shredBadge = document.getElementById('shredderTimerBadge');
  const shredBar = document.getElementById('shredderProgressBar');

  const uvcDisplay = document.getElementById('uvcTimerDisplay');
  const uvcBadge = document.getElementById('uvcTimerBadge');
  const uvcBar = document.getElementById('uvcProgressBar');

  // Shredder UI
  if (shredDisplay) shredDisplay.innerText = `${shredSecondsLeft}s`;
  if (shredBar) {
    const pct = Math.round(((30 - shredSecondsLeft) / 30) * 100);
    shredBar.style.width = `${shredSecondsLeft > 0 ? (pct || 5) : 0}%`;
  }
  if (shredBadge) {
    if (isDeviceJammed) {
      shredBadge.className = 'badge bg-danger';
      shredBadge.innerText = 'JAMMED (PAUSED)';
    } else if (shredSecondsLeft > 0) {
      shredBadge.className = 'badge bg-primary';
      shredBadge.innerText = 'RUNNING';
    } else {
      shredBadge.className = 'badge bg-secondary';
      shredBadge.innerText = 'IDLE';
    }
  }

  // UV-C UI
  if (uvcDisplay) uvcDisplay.innerText = `${uvcSecondsLeft}s`;
  if (uvcBar) {
    const pct = Math.round(((60 - uvcSecondsLeft) / 60) * 100);
    uvcBar.style.width = `${uvcSecondsLeft > 0 ? (pct || 5) : 0}%`;
  }
  if (uvcBadge) {
    if (isDeviceJammed) {
      uvcBadge.className = 'badge bg-danger';
      uvcBadge.innerText = 'JAMMED (PAUSED)';
    } else if (uvcSecondsLeft > 0) {
      uvcBadge.className = 'badge bg-info text-dark';
      uvcBadge.innerText = 'STERILIZING';
    } else {
      uvcBadge.className = 'badge bg-secondary';
      uvcBadge.innerText = 'OFF';
    }
  }
}

// Watchdog Timer: Set Device to Disconnected if no heartbeat received for >7 seconds
function startHeartbeatWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    const now = Date.now();
    if (lastDataReceivedTime > 0 && (now - lastDataReceivedTime > 7000)) {
      setDeviceOfflineUI();
    }
  }, 2000);
}

function setDeviceOfflineUI() {
  const iotStatusText = document.getElementById('iotStatusText');
  const iotBadgeText = document.getElementById('iotBadgeText');
  const iotBadge = document.getElementById('iotBadge');
  const sidebarStatus = document.getElementById('sidebarStatus');

  if (iotStatusText) iotStatusText.innerText = "Disconnected";
  if (iotBadgeText) iotBadgeText.innerText = "Offline";
  if (iotBadge) iotBadge.className = "badge-status offline";
  if (sidebarStatus) sidebarStatus.className = "badge-status offline";

  // Motor status cards update
  const deviceStatusText = document.getElementById('deviceStatusText');
  const motorSubtext = document.getElementById('motorSubtext');
  const deviceBadgeText = document.getElementById('deviceBadgeText');
  const deviceBadge = document.getElementById('deviceBadge');
  const powerBadgeText = document.getElementById('powerBadgeText');
  const powerBadge = document.getElementById('powerBadge');
  const toggle = document.getElementById('powerToggle');
  const motorIcon = document.getElementById('motorIcon');
  const motorStateBadge = document.getElementById('motorStateBadge');

  if (deviceStatusText) deviceStatusText.innerText = "OFF";
  if (motorSubtext) motorSubtext.innerText = "Alat Disconnected";
  if (deviceBadgeText) deviceBadgeText.innerText = "Disconnected";
  if (deviceBadge) deviceBadge.className = "badge-status offline";
  if (powerBadgeText) powerBadgeText.innerText = "OFFLINE";
  if (powerBadge) powerBadge.className = "badge-status offline";
  if (toggle) toggle.checked = false;
  if (motorIcon) motorIcon.className = "fa-solid fa-gear text-secondary";
  if (motorStateBadge) {
    motorStateBadge.className = "badge bg-secondary";
    motorStateBadge.innerText = "OFFLINE";
  }

  // Battery icon box styling when offline / 0%
  const batteryIconBox = document.getElementById('batteryIconBox');
  if (batteryIconBox) batteryIconBox.className = "stat-icon blue";

  currentWebState = false;
}

// Inisialisasi listener data sensor (realtime)
function initFirebaseListeners() {
  startHeartbeatWatchdog();

  const sensorsRef = database.ref('/sensors');
  sensorsRef.on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      addActivityLog("⚠️ Menunggu sinyal awal dari ESP32...", false);
      setDeviceOfflineUI();
      return;
    }

    // Check if heartbeat / uptime has actually updated
    const currentUptime = data.uptime !== undefined ? data.uptime : -1;
    if (currentUptime !== lastUptimeValue) {
      lastDataReceivedTime = Date.now();
      lastUptimeValue = currentUptime;
    }

    // Check if packet is too old
    if (lastDataReceivedTime > 0 && (Date.now() - lastDataReceivedTime > 7000)) {
      setDeviceOfflineUI();
      return;
    }

    // 1. Update Battery & Voltage
    const battery = data.battery !== undefined ? data.battery : 0;
    const voltage = data.voltage || 0;
    
    document.getElementById('batteryPercent').innerText = battery;
    document.getElementById('voltageDisplay').innerText = (voltage).toFixed(1) + ' V';
    
    const batteryBar = document.getElementById('batteryBar');
    const batteryIconBox = document.getElementById('batteryIconBox');
    if (batteryBar) {
      batteryBar.style.width = battery + '%';
      if (battery > 50) {
        batteryBar.className = "sg-progress-bar bg-success";
        if (batteryIconBox) batteryIconBox.className = "stat-icon green";
      } else if (battery > 20) {
        batteryBar.className = "sg-progress-bar bg-warning";
        if (batteryIconBox) batteryIconBox.className = "stat-icon cyan";
      } else {
        batteryBar.className = "sg-progress-bar bg-danger";
        if (batteryIconBox) batteryIconBox.className = "stat-icon red";
      }
    }

    // 2. Needle count
    document.getElementById('needleCount').innerText = data.needleCount || 0;

    // 3. Motor status (dari ESP32)
    const motorOn = data.motorStatus === true;
    document.getElementById('deviceStatusText').innerText = motorOn ? "ON" : "OFF";
    document.getElementById('powerBadgeText').innerText = motorOn ? "RUNNING" : "STANDBY";
    document.getElementById('powerBadge').className = `badge-status ${motorOn ? 'online' : 'offline'}`;
    
    const deviceBadgeText = document.getElementById('deviceBadgeText');
    const deviceBadge = document.getElementById('deviceBadge');
    const motorSubtext = document.getElementById('motorSubtext');
    const motorStateBadge = document.getElementById('motorStateBadge');

    if (motorOn) {
      if (deviceBadgeText) deviceBadgeText.innerText = "Active";
      if (deviceBadge) deviceBadge.className = "badge-status online";
      if (motorSubtext) motorSubtext.innerText = "Shredder Running";
      if (motorStateBadge) {
        motorStateBadge.className = "badge bg-primary fw-semibold";
        motorStateBadge.innerText = "SHREDDING";
      }
    } else {
      if (deviceBadgeText) deviceBadgeText.innerText = "Standby";
      if (deviceBadge) deviceBadge.className = "badge-status online";
      if (motorSubtext) motorSubtext.innerText = "Motor Siap (Standby)";
      if (motorStateBadge) {
        motorStateBadge.className = "badge bg-secondary";
        motorStateBadge.innerText = "IDLE";
      }
    }

    const motorIcon = document.getElementById('motorIcon');
    if (motorIcon) {
      if (motorOn) {
        motorIcon.className = 'fa-solid fa-gear fa-spin text-primary';
      } else {
        motorIcon.className = 'fa-solid fa-gear text-secondary';
      }
    }

    // Toggle switch sync
    const toggle = document.getElementById('powerToggle');
    if (toggle && toggle.checked !== motorOn) {
      toggle.checked = motorOn;
    }
    currentWebState = motorOn;

    // Trigger local timers if motor turned ON remotely and timers aren't running
    if (motorOn && shredSecondsLeft === 0 && !isDeviceJammed) {
      startLocalTimers();
    }

    // 4. IoT Connection — Verified Active Heartbeat
    document.getElementById('iotStatusText').innerText = "Connected";
    document.getElementById('iotBadgeText').innerText = "Online";
    document.getElementById('iotBadge').className = "badge-status online";
    const sidebarStatus = document.getElementById('sidebarStatus');
    if (sidebarStatus) sidebarStatus.className = "badge-status online";

    // 5. Telemetri
    if (data.wifiSSID) {
      const ssidElem = document.getElementById('currentSSID');
      if (ssidElem) ssidElem.innerText = data.wifiSSID;
    }
    if (data.rssi) {
      const signalElem = document.getElementById('signalStrength');
      if (signalElem) signalElem.innerText = data.rssi + " dBm";
    }
    if (data.uptime !== undefined) {
      const uptimeElem = document.getElementById('espUptime');
      if (uptimeElem) {
        const hours = Math.floor(data.uptime / 3600);
        const minutes = Math.floor((data.uptime % 3600) / 60);
        const seconds = Math.floor(data.uptime % 60);
        uptimeElem.innerText = `${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
      }
    }

  }, (error) => {
    addActivityLog(`Error sensor: ${error.message}`, true);
    setDeviceOfflineUI();
  });

  // 6. Listener Alert Anti-Jam (/alerts/jam)
  database.ref('/alerts/jam').on('value', (snap) => {
    const alertData = snap.val();
    const banner = document.getElementById('jamAlertBanner');
    const retryCountElem = document.getElementById('jamRetryCount');
    const motorSubtext = document.getElementById('motorSubtext');
    const motorStateBadge = document.getElementById('motorStateBadge');

    if (alertData && alertData.status === "JAM_STUCK") {
      isDeviceJammed = true;
      if (banner) banner.style.display = 'block';
      if (retryCountElem) retryCountElem.innerText = `Retries: ${alertData.retries || 0} / 5`;
      if (motorSubtext) motorSubtext.innerText = "Motor Macet! Auto Reverse";
      if (motorStateBadge) {
        motorStateBadge.className = "badge bg-danger fw-bold";
        motorStateBadge.innerText = "JAMMED";
      }
      addActivityLog(`⚠️ ALARM ANTI-JAM: Motor tersumbat! (Retry ${alertData.retries || 0})`, true);
      updateTimerUI();
    } else {
      isDeviceJammed = false;
      if (banner) banner.style.display = 'none';
      if (motorSubtext && !currentWebState) motorSubtext.innerText = "Motor Siap (Standby)";
      if (motorStateBadge && !currentWebState) {
        motorStateBadge.className = "badge bg-secondary";
        motorStateBadge.innerText = "IDLE";
      }
      updateTimerUI();
    }
  });

  // 7. Listener status WiFi
  database.ref('/status/wifi').on('value', (snap) => {
    const status = snap.val();
    const wifiDiv = document.getElementById('wifiStatus');
    if (!wifiDiv) return;
    if (status === "connecting") {
      wifiDiv.innerHTML = '<span class="text-warning small">⏳ Menghubungkan ke WiFi baru...</span>';
      wifiDiv.style.display = 'block';
    } else if (status === "connected") {
      wifiDiv.innerHTML = '<span class="text-success small">✅ WiFi berhasil diubah!</span>';
      wifiDiv.style.display = 'block';
      setTimeout(() => wifiDiv.style.display = 'none', 3500);
    } else if (status === "failed") {
      wifiDiv.innerHTML = '<span class="text-danger small">❌ Gagal terhubung ke WiFi baru.</span>';
      wifiDiv.style.display = 'block';
    } else {
      wifiDiv.style.display = 'none';
    }
  });
}

// Reset needle count
function resetNeedle() {
  database.ref('/commands/resetNeedle').set({ resetNeedle: true })
    .then(() => addActivityLog("📌 Perintah reset needle dikirim"))
    .catch(err => addActivityLog(`Gagal reset needle: ${err.message}`, true));
}

// Restart ESP32
function restartESP() {
  if (confirm("Restart ESP32? Sistem akan terputus sejenak.")) {
    database.ref('/commands/restart').set({ restart: true })
      .then(() => addActivityLog("🔄 Perintah restart ESP32 dikirim"))
      .catch(err => addActivityLog(`Gagal restart: ${err.message}`, true));
  }
}

// Konfigurasi WiFi
function setWiFi(ssid, password) {
  if (!ssid) {
    alert("Nama SSID WiFi wajib diisi!");
    return false;
  }
  database.ref('/commands/wifi').set({ ssid: ssid, password: password })
    .then(() => {
      addActivityLog(`📡 Perintah ganti WiFi ke "${ssid}" dikirim. ESP32 akan restart`);
      const wifiDiv = document.getElementById('wifiStatus');
      if (wifiDiv) {
        wifiDiv.innerHTML = '<span class="text-info small">📡 Mengirim konfigurasi, ESP32 restart...</span>';
        wifiDiv.style.display = 'block';
      }
    })
    .catch(err => {
      addActivityLog(`Gagal kirim WiFi: ${err.message}`, true);
    });
  return true;
}

// Event Listeners DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  if (typeof database === 'undefined') {
    console.error("Firebase database tidak terdefinisi. Periksa firebase-config.js");
    return;
  }

  initFirebaseListeners();

  // Power Toggle
  const powerToggle = document.getElementById('powerToggle');
  if (powerToggle) {
    powerToggle.addEventListener('change', (e) => {
      sendPowerCommand(e.target.checked);
    });
  }

  // Start Cycle Button
  const startCycleBtn = document.getElementById('startCycleBtn');
  if (startCycleBtn) {
    startCycleBtn.addEventListener('click', () => {
      sendPowerCommand(true);
    });
  }

  // Reset Needle Button
  const resetBtn = document.getElementById('resetNeedleBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetNeedle);

  // Reconnect / Restart ESP Button
  const reconnectBtn = document.getElementById('reconnectBtn');
  if (reconnectBtn) reconnectBtn.addEventListener('click', restartESP);

  // WiFi Form
  const wifiForm = document.getElementById('wifiForm');
  if (wifiForm) {
    wifiForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const ssid = document.getElementById('wifiSSID').value.trim();
      const password = document.getElementById('wifiPassword').value;
      setWiFi(ssid, password);
    });
  }

  // Toggle Password Visibility
  const togglePassBtn = document.getElementById('togglePassBtn');
  if (togglePassBtn) {
    togglePassBtn.addEventListener('click', () => {
      const passInput = document.getElementById('wifiPassword');
      if (passInput.type === 'password') {
        passInput.type = 'text';
        togglePassBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
      } else {
        passInput.type = 'password';
        togglePassBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      }
    });
  }

  addActivityLog("Dashboard NECIS Siap. Menghubungkan ke Firebase...");
});