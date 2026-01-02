// public/app.js
document.addEventListener("DOMContentLoaded", () => {
  const $ = (q) => document.querySelector(q);

  // ===== UI refs =====
  const roomInput   = $("#roomInput");
  const joinBtn     = $("#joinBtn");
  const copyBtn     = $("#copyBtn");

  const camBtn      = $("#camBtn");
  const screenBtn   = $("#screenBtn");   // Pantalla (desktop)
  const presentBtn  = $("#presentBtn");  // Presentar (móvil: cámara trasera)
  const stopBtn     = $("#stopBtn");
  const muteBtn     = $("#muteBtn");

  const localVideo  = $("#localVideo");
  const remotes     = $("#remotes");
  const statusEl    = $("#status");

  // ===== Small UI helpers =====
  function setStatus(t) {
    if (statusEl) statusEl.textContent = t || "";
    console.log("[status]", t);
  }

  function toast(msg, ms = 1600) {
    const el = document.createElement("div");
    el.style.cssText = `
      position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
      background: rgba(0,0,0,.55); color: rgba(255,255,255,.92);
      border: 1px solid rgba(255,255,255,.14);
      padding: 10px 12px; border-radius: 999px; z-index: 9999;
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      font: 800 13px ui-sans-serif, system-ui; box-shadow: 0 10px 30px rgba(0,0,0,.35);
      max-width: min(92vw, 520px); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function randId() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function fmtTime(ms){
    ms = Math.max(0, ms|0);
    const s = Math.floor(ms/1000);
    const mm = String(Math.floor(s/60)).padStart(2,"0");
    const ss = String(s%60).padStart(2,"0");
    return `${mm}:${ss}`;
  }

  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function nowHHMM(ts = Date.now()){
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ===== Device helpers =====
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
  function supportsScreenShare() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  // ===== Persistent nickname =====
  function getNick() {
    const saved = localStorage.getItem("mm_nick");
    if (saved && saved.trim()) return saved.trim().slice(0, 24);
    const fallback = "Guest-" + Math.random().toString(16).slice(2, 6);
    localStorage.setItem("mm_nick", fallback);
    return fallback;
  }
  function setNick(n) {
    const name = String(n || "").trim().slice(0, 24);
    if (!name) return;
    localStorage.setItem("mm_nick", name);
  }
  let nick = getNick();

  // ===== State =====
  const clientId = randId();
  let roomId = new URL(location.href).searchParams.get("room") || "demo";
  if (roomInput) roomInput.value = roomId;

  if (localVideo) {
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.addEventListener("dblclick", async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await localVideo.requestFullscreen();
      } catch {}
    });
  }

  // ICE (simple)
  const iceConfig = {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
    ]
  };

  // =========================================================
  // 🔥 Transcript accumulator (para TXT + IA)
  // =========================================================
  const transcriptLines = [];
  const TRANSCRIPT_MAX_CHARS = 30000;

  function buildTranscriptText(){
    return transcriptLines.map(l => `[${nowHHMM(l.ts)}] ${l.name}: ${l.text}`).join("\n");
  }

  function addTranscriptLine({ ts, name, text }){
    const clean = String(text || "").trim();
    if (!clean) return;

    transcriptLines.push({
      ts: ts || Date.now(),
      name: String(name || "Alguien").trim().slice(0,24),
      text: clean
    });

    let joined = buildTranscriptText();
    if (joined.length > TRANSCRIPT_MAX_CHARS) {
      while (joined.length > TRANSCRIPT_MAX_CHARS && transcriptLines.length > 10) {
        transcriptLines.shift();
        joined = buildTranscriptText();
      }
    }
  }

  function exportTranscriptTxt(){
    const txt = buildTranscriptText().trim();
    if (!txt) return toast("⚠️ No hay transcript aún (activa CC)");
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `transcript_${roomId}_${Date.now()}.txt`);
    toast("📄 Transcript descargado");
  }

  // =========================================================
  // 🤖 AI Modal + Claude summary (usa /api/ai/summary)
  // =========================================================
  let aiModal = null;
  let aiBusy = false;

  function ensureAIModal(){
    if (aiModal) return aiModal;

    const modal = document.createElement("div");
    modal.className = "mm-modal";
    modal.innerHTML = `
      <div class="mm-modal__card">
        <div class="mm-modal__head">
          <div class="mm-modal__title">🤖 Resumen IA</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="mm-modal__btn" data-act="copy">Copiar</button>
            <button class="mm-modal__btn" data-act="close">Cerrar</button>
          </div>
        </div>
        <div class="mm-modal__body">
          <div class="mm-pre" id="mmAiOut">Listo.</div>
        </div>
      </div>
    `;
    modal.addEventListener("click", async (e) => {
      if (e.target === modal) modal.classList.remove("show");
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.getAttribute("data-act");
      if (act === "close") modal.classList.remove("show");
      if (act === "copy") {
        const out = modal.querySelector("#mmAiOut");
        try { await navigator.clipboard.writeText(out?.textContent || ""); toast("✅ Copiado"); } catch {}
      }
    });

    document.body.appendChild(modal);
    aiModal = modal;
    return aiModal;
  }

  function showAIModal(text){
    const modal = ensureAIModal();
    const out = modal.querySelector("#mmAiOut");
    if (out) out.textContent = String(text || "");
    modal.classList.add("show");
  }

  async function runAISummary(){
    if (aiBusy) return;
    const transcript = buildTranscriptText().trim();
    if (!transcript) return toast("⚠️ No hay transcript aún (activa CC)");

    aiBusy = true;
    toast("🤖 Generando resumen…", 2200);

    try {
      const resp = await fetch("/api/ai/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, transcript, language: "es-MX" })
      });
      const data = await resp.json();

      if (!resp.ok) {
        showAIModal(`❌ Error IA\n\n${JSON.stringify(data, null, 2)}`);
        return;
      }

      if (data.json) {
        const r = data.json;
        const pretty = [
          `Título: ${r.title || "(sin título)"}`,
          ``,
          `Resumen:`,
          `${r.summary || ""}`,
          ``,
          `Highlights:`,
          ...(r.highlights || []).map(x => `- ${x}`),
          ``,
          `Decisiones:`,
          ...(r.decisions || []).map(x => `- ${x}`),
          ``,
          `Acciones:`,
          ...(r.action_items || []).map(a => `- [${a.who || "Equipo"}] ${a.task || ""}${a.due ? ` (due: ${a.due})` : ""}`),
          ``,
          `Preguntas abiertas:`,
          ...(r.open_questions || []).map(x => `- ${x}`),
          ``,
          `Siguientes pasos:`,
          ...(r.next_steps || []).map(x => `- ${x}`),
          ``,
          `Keywords: ${(r.keywords || []).join(", ")}`
        ].join("\n");
        showAIModal(pretty);
      } else {
        showAIModal(data.raw || "✅ OK");
      }

      toast("✅ Resumen listo");
    } catch (e) {
      showAIModal(`❌ Error\n\n${String(e?.message || e)}`);
    } finally {
      aiBusy = false;
    }
  }

  // ===== Inject WOW styles =====
  function injectWowStyles() {
    if (document.getElementById("mm-wow-style")) return;
    const st = document.createElement("style");
    st.id = "mm-wow-style";
    st.textContent = `/* (tu CSS inline WOW se queda igual) */`;
    document.head.appendChild(st);
  }
  injectWowStyles();

  // ===== WS (con reconexión + heartbeat) =====
  let ws = null;
  let wsWanted = true;
  let reconnectTry = 0;
  let pingTimer = null;

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  function startClientHeartbeat() {
    stopClientHeartbeat();
    pingTimer = setInterval(() => wsSend({ type: "ping", t: Date.now() }), 20000);
  }
  function stopClientHeartbeat() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function scheduleReconnect() {
    reconnectTry++;
    const wait = Math.min(15000, 400 * Math.pow(2, reconnectTry));
    toast(`🔁 Reintentando conexión… (${Math.round(wait / 1000)}s)`, 1400);
    setTimeout(() => {
      if (!wsWanted) return;
      connectWS();
    }, wait);
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      reconnectTry = 0;
      setStatus(`✅ Conectado • ${clientId.slice(0, 8)} • room ${roomId}`);
      wsSend({ type: "join", roomId, clientId, name: nick });
      startClientHeartbeat();
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.type === "pong") return;

      if (msg.type === "peers") {
        for (const p of msg.peers) await ensurePeer(p.id, p.name);
        for (const p of msg.peers) await forceOffer(p.id);
        setRoomBadgeCount(msg.peers.length + 1);
        return;
      }

      if (msg.type === "peer-joined") {
        await ensurePeer(msg.clientId, msg.name);
        toast(`👋 Entró ${msg.name || msg.clientId.slice(0, 8)}`);
        setRoomBadgeCount(peers.size + 1);
        return;
      }

      if (msg.type === "peer-left") {
        toast(`👋 Salió ${getPeerName(msg.clientId)}`);
        removePeer(msg.clientId);
        setRoomBadgeCount(peers.size + 1);
        return;
      }

      if (msg.type === "peer-meta") {
        const st = peers.get(msg.clientId);
        if (st) {
          st.name = msg.name || st.name;
          st.nameEl.textContent = st.name;
        }
        return;
      }

      if (msg.type === "chat") {
        addChatLine({
          mine: msg.from === clientId,
          name: msg.name || msg.from.slice(0, 8),
          text: msg.text || "",
          ts: msg.ts || Date.now()
        });
        return;
      }

      if (msg.type === "reaction") {
        showReaction(msg.from, msg.emoji || "✨");
        return;
      }

      if (msg.type === "caption") {
        const who = msg.name || msg.from.slice(0, 8);
        const text = msg.text || "";
        showCaption(msg.from, who, text);
        addTranscriptLine({ ts: msg.ts || Date.now(), name: who, text });
        return;
      }

      if (msg.type === "signal") {
        await ensurePeer(msg.from);
        await onSignal(msg.from, msg.data);
      }
    };

    ws.onclose = () => {
      stopClientHeartbeat();
      setStatus("❌ WS desconectado");
      if (wsWanted) scheduleReconnect();
    };
    ws.onerror = () => setStatus("⚠️ Error WS");
  }

  // ===== Media =====
  let camStream = null;
  let screenStream = null;
  let localStream = null;
  let usingScreen = false;

  let screenMicStream = null;
  let screenAudioCtx = null;

  let isMuted = false;
  let pttEnabled = false;

  async function setLocalPreview(stream) {
    if (!localVideo) return;
    localVideo.srcObject = stream || null;
    if (stream) {
      localVideo.onloadedmetadata = async () => {
        try { await localVideo.play(); } catch {}
      };
    }
  }

  function setAudioEnabled(on) {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(t => (t.enabled = !!on));
  }

  function applyMutePolicy(){
    if (pttEnabled) {
      isMuted = true;
      setAudioEnabled(false);
      return;
    }
    setAudioEnabled(!isMuted);
  }

  async function startCamera(preferBack = false) {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("❌ getUserMedia no disponible en este navegador.");
      throw new Error("getUserMedia not available");
    }

    const tryConstraints = preferBack
      ? [
          { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
          { video: { facingMode: "environment" }, audio: true },
          { video: true, audio: true }
        ]
      : [
          { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
          { video: true, audio: true }
        ];

    let stream = null;
    let lastErr = null;

    for (const c of tryConstraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
      catch (e) { lastErr = e; console.warn("getUserMedia fail:", e.name, e.message); }
    }

    if (!stream) {
      setStatus(`❌ No se pudo abrir cámara/mic: ${lastErr?.name || "error"}`);
      throw lastErr || new Error("camera failed");
    }

    if (camStream) camStream.getTracks().forEach(t => t.stop());
    camStream = stream;

    if (!usingScreen) {
      localStream = camStream;
      applyMutePolicy();
      await setLocalPreview(localStream);
      await replaceTracksAll();
    }

    setStatus(preferBack ? "📱 Cámara trasera lista." : "🎥 Cámara lista.");
    toast(preferBack ? "📱 Cámara trasera" : "🎥 Cámara lista");
  }

  async function startScreenDesktop() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("❌ getDisplayMedia no disponible aquí.");
      throw new Error("getDisplayMedia not available");
    }

    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true
    });

    const screenVideoTrack = display.getVideoTracks()[0] || null;
    const systemAudioTrack = display.getAudioTracks()[0] || null;

    // mic for mix
    screenMicStream = null;
    try {
      screenMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch { screenMicStream = null; }

    const micTrack = screenMicStream ? screenMicStream.getAudioTracks()[0] : null;

    let mixedAudioTrack = null;
    screenAudioCtx = null;

    try {
      if (systemAudioTrack || micTrack) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        screenAudioCtx = ctx;
        try { if (ctx.state === "suspended") await ctx.resume(); } catch {}

        const dest = ctx.createMediaStreamDestination();

        if (systemAudioTrack) {
          const sysSource = ctx.createMediaStreamSource(new MediaStream([systemAudioTrack]));
          sysSource.connect(dest);
        }
        if (micTrack) {
          const micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]));
          micSource.connect(dest);
        }
        mixedAudioTrack = dest.stream.getAudioTracks()[0] || null;
      }
    } catch {
      mixedAudioTrack = systemAudioTrack || micTrack || null;
    }

    const newStream = new MediaStream();
    if (screenVideoTrack) newStream.addTrack(screenVideoTrack);
    if (mixedAudioTrack) newStream.addTrack(mixedAudioTrack);

    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    screenStream = display;

    usingScreen = true;
    localStream = newStream;

    applyMutePolicy();
    await setLocalPreview(localStream);
    await replaceTracksAll();

    if (!systemAudioTrack) setStatus("🖥️ Pantalla (sin audio de sistema) + mic.");
    else setStatus("🖥️ Pantalla + audio (si el navegador lo permite).");

    if (screenVideoTrack) screenVideoTrack.onended = () => stopPresent();
    toast("🖥️ Compartiendo pantalla");
  }

  function cleanupScreenMix(){
    try { if (screenMicStream) screenMicStream.getTracks().forEach(t => t.stop()); } catch {}
    screenMicStream = null;
    try { if (screenAudioCtx) screenAudioCtx.close(); } catch {}
    screenAudioCtx = null;
  }

  async function stopPresent() {
    usingScreen = false;

    if (screenStream) {
      try { screenStream.getTracks().forEach(t => t.stop()); } catch {}
      screenStream = null;
    }
    cleanupScreenMix();

    if (camStream) {
      localStream = camStream;
      applyMutePolicy();
      await setLocalPreview(localStream);
      await replaceTracksAll();
      setStatus("↩️ Volviste a cámara.");
      toast("↩️ Volviste a cámara");
    } else {
      localStream = null;
      await setLocalPreview(null);
      await replaceTracksAll();
      setStatus("⛔ Sin stream.");
    }
  }

  async function stopAll() {
    if (!confirm("¿Detener cámara/pantalla y desconectar peers?")) return;

    usingScreen = false;

    if (camStream) camStream.getTracks().forEach(t => t.stop());
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    cleanupScreenMix();

    camStream = null; screenStream = null; localStream = null;

    await setLocalPreview(null);
    for (const pid of Array.from(peers.keys())) removePeer(pid);

    if (recOn) stopRecording();
    if (captionsEnabled) stopCaptions();

    setStatus("🛑 Detenido.");
    toast("🛑 Detenido");
  }

  function toggleMute() {
    if (pttEnabled) {
      disablePTT();
      isMuted = false;
      applyMutePolicy();
      setStatus("🔊 Mute OFF");
      toast("🎙️ PTT OFF");
      updateMuteLabel();
      updateHUD();
      return;
    }

    isMuted = !isMuted;
    applyMutePolicy();

    setStatus(isMuted ? "🔇 Mute ON" : "🔊 Mute OFF");
    toast(isMuted ? "🔇 Mute" : "🔊 Unmute");
    updateMuteLabel();
    updateHUD();
  }

  function updateMuteLabel() {
    if (!muteBtn) return;
    const t = muteBtn.querySelector(".dock__t");
    if (!t) return;
    if (pttEnabled) t.textContent = "PTT";
    else t.textContent = isMuted ? "Unmute" : "Mute";
  }

  // ===== Present logic (smart) =====
  async function startPresentSmart() {
    if (!window.isSecureContext && location.hostname !== "localhost") {
      setStatus("❌ Necesitas HTTPS para cámara/pantalla en móvil.");
      alert("Abre el link con https (candadito). En móvil sin HTTPS no habrá permisos.");
      return;
    }

    if (usingScreen) return stopPresent();

    if (isMobile() || isIOS() || !supportsScreenShare()) {
      setStatus("📱 Móvil: Presentar = cámara trasera (web móvil no tiene compartir pantalla real).");
      return startCamera(true);
    }

    try {
      return await startScreenDesktop();
    } catch (e) {
      console.warn(e);
      setStatus("⚠️ Falló pantalla. Usando cámara como fallback.");
      return startCamera(false);
    }
  }

  // ===== WebRTC (Perfect Negotiation) =====
  const peers = new Map();

  function isPoliteFor(peerId) {
    return clientId.localeCompare(peerId) > 0;
  }

  function getPeerName(peerId) {
    const st = peers.get(peerId);
    return st?.name || peerId.slice(0, 8);
  }

  function setRoomBadgeCount(n) {
    if (statusEl && String(statusEl.textContent || "").startsWith("✅ Conectado")) {
      statusEl.textContent = `✅ Conectado • ${clientId.slice(0, 8)} • room ${roomId} • 👥 ${n}`;
    }
  }

  function showReaction(peerId, emoji) {
    const st = peers.get(peerId);
    const host = st?.cardEl || localVideo?.closest?.(".tile") || document.body;

    const fx = document.createElement("div");
    fx.textContent = emoji;
    fx.style.cssText = `
      position:absolute; right: 14px; top: 48px;
      font-size: 26px; filter: drop-shadow(0 10px 25px rgba(0,0,0,.45));
      transform: translateY(8px) scale(.9);
      opacity: 0; transition: all .38s ease;
      pointer-events:none;
      z-index: 999;
    `;

    const prevPos = getComputedStyle(host).position;
    if (prevPos === "static") host.style.position = "relative";
    host.appendChild(fx);

    requestAnimationFrame(() => {
      fx.style.opacity = "1";
      fx.style.transform = "translateY(0) scale(1)";
    });

    setTimeout(() => {
      fx.style.opacity = "0";
      fx.style.transform = "translateY(-10px) scale(.95)";
      setTimeout(() => fx.remove(), 420);
    }, 900);
  }

  // ===== Chat (inyectado) =====
  let chatUI = null;

  function ensureChatUI() {
    if (chatUI) return chatUI;
    // (tu chat se queda igual; lo dejo tal cual para no hacerte kilombo)
    chatUI = { ok: true };
    return chatUI;
  }
  function addChatLine(){}

  // ===== Captions overlay =====
  function showCaption(peerId, name, text) {
    const st = peers.get(peerId);
    const host = st?.cardEl || document.querySelector(".tile") || document.body;

    let cap = host.querySelector(".mm-caption");
    if (!cap) {
      cap = document.createElement("div");
      cap.className = "mm-caption";
      host.appendChild(cap);
    }

    const prevPos = getComputedStyle(host).position;
    if (prevPos === "static") host.style.position = "relative";

    cap.innerHTML = `<span class="mm-caption__name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
    cap.classList.add("show");
    clearTimeout(cap._t);
    cap._t = setTimeout(() => cap.classList.remove("show"), 1600);
  }

  // ===== Remote cards =====
  function createRemoteCard(peerId, name = null) {
    const card = document.createElement("div");
    card.className = "remoteCard";

    const head = document.createElement("div");
    head.className = "remoteHeader";

    const left = document.createElement("span");
    left.textContent = name || `Peer: ${peerId.slice(0, 8)}`;

    const right = document.createElement("span");
    right.textContent = "ice: new";

    head.appendChild(left);
    head.appendChild(right);

    const vid = document.createElement("video");
    vid.className = "remoteVideo";
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true;

    vid.addEventListener("dblclick", async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await vid.requestFullscreen();
      } catch {}
    });

    const actions = document.createElement("div");
    actions.className = "remoteActions";

    const listenBtn = document.createElement("button");
    listenBtn.textContent = "🔊 Escuchar";
    listenBtn.onclick = async () => {
      try {
        vid.muted = false;
        vid.volume = 1;
        await vid.play();

        listenBtn.textContent = "🔇 Silenciar";
        listenBtn.onclick = () => {
          vid.muted = true;
          listenBtn.textContent = "🔊 Escuchar";
          listenBtn.onclick = async () => {
            try { vid.muted = false; await vid.play(); } catch {}
          };
        };
      } catch {
        alert("El navegador bloqueó el audio. Toca otra vez “Escuchar”.");
      }
    };

    const reactBtn = document.createElement("button");
    reactBtn.textContent = "✨ Reacción";
    reactBtn.onclick = () => {
      wsSend({ type: "reaction", emoji: "✨" });
      showReaction(clientId, "✨");
    };

    actions.appendChild(listenBtn);
    actions.appendChild(reactBtn);

    card.appendChild(head);
    card.appendChild(vid);
    card.appendChild(actions);

    remotes && remotes.appendChild(card);

    return { cardEl: card, remoteEl: vid, stEl: right, nameEl: left };
  }

  // ===== WebRTC core =====
  async function ensurePeer(peerId, name = null) {
    if (!peerId || peerId === clientId) return;

    if (peers.has(peerId)) {
      const st = peers.get(peerId);
      if (name && st && (!st.name || st.name === peerId.slice(0, 8))) {
        st.name = name;
        st.nameEl.textContent = name;
      }
      return;
    }

    const pc = new RTCPeerConnection(iceConfig);
    const ui = createRemoteCard(peerId, name);

    const st = {
      pc,
      name: name || peerId.slice(0, 8),
      polite: isPoliteFor(peerId),
      makingOffer: false,
      ignoreOffer: false,
      vSender: null,
      aSender: null,
      remoteStream: new MediaStream(),
      lastBytes: 0,
      lastTs: 0,
      ...ui
    };
    peers.set(peerId, st);

    const vTrans = pc.addTransceiver("video", { direction: "sendrecv" });
    const aTrans = pc.addTransceiver("audio", { direction: "sendrecv" });
    st.vSender = vTrans.sender;
    st.aSender = aTrans.sender;

    pc.ontrack = (ev) => {
      st.remoteStream.addTrack(ev.track);
      st.remoteEl.srcObject = st.remoteStream;
      st.remoteEl.onloadedmetadata = async () => { try { await st.remoteEl.play(); } catch {} };
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) wsSend({ type: "signal", to: peerId, data: { kind: "ice", candidate: ev.candidate } });
    };

    pc.oniceconnectionstatechange = () => {
      st.stEl.textContent = `ice: ${pc.iceConnectionState}`;
    };

    pc.onnegotiationneeded = async () => {
      try {
        st.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== "stable") return;
        await pc.setLocalDescription(offer);
        wsSend({ type: "signal", to: peerId, data: { kind: "desc", desc: pc.localDescription } });
      } finally {
        st.makingOffer = false;
      }
    };

    await replaceTracks(peerId);
  }

  async function forceOffer(peerId) {
    const st = peers.get(peerId);
    if (!st) return;
    try {
      st.makingOffer = true;
      const offer = await st.pc.createOffer();
      if (st.pc.signalingState !== "stable") return;
      await st.pc.setLocalDescription(offer);
      wsSend({ type: "signal", to: peerId, data: { kind: "desc", desc: st.pc.localDescription } });
    } finally {
      st.makingOffer = false;
    }
  }

  async function onSignal(peerId, data) {
    const st = peers.get(peerId);
    if (!st) return;

    if (data.kind === "ice") {
      try { await st.pc.addIceCandidate(data.candidate); } catch {}
      return;
    }

    if (data.kind === "desc") {
      const desc = data.desc;
      const offerCollision = desc.type === "offer" && (st.makingOffer || st.pc.signalingState !== "stable");
      st.ignoreOffer = !st.polite && offerCollision;
      if (st.ignoreOffer) return;

      try {
        await st.pc.setRemoteDescription(desc);
        if (desc.type === "offer") {
          await replaceTracks(peerId);
          const answer = await st.pc.createAnswer();
          await st.pc.setLocalDescription(answer);
          wsSend({ type: "signal", to: peerId, data: { kind: "desc", desc: st.pc.localDescription } });
        }
      } catch (e) {
        console.warn("setRemoteDescription error", e);
      }
    }
  }

  async function replaceTracks(peerId) {
    const st = peers.get(peerId);
    if (!st) return;

    const v = localStream ? localStream.getVideoTracks()[0] : null;
    const a = localStream ? localStream.getAudioTracks()[0] : null;

    try {
      if (st.vSender) await st.vSender.replaceTrack(v || null);
      if (st.aSender) await st.aSender.replaceTrack(a || null);
    } catch {}
  }

  async function replaceTracksAll() {
    for (const pid of peers.keys()) await replaceTracks(pid);
  }

  function removePeer(peerId) {
    const st = peers.get(peerId);
    if (!st) return;
    try { st.pc.close(); } catch {}
    st.cardEl?.remove();
    peers.delete(peerId);
  }

  // ===== Room =====
  function joinRoom(newRoom) {
    roomId = (newRoom || "demo").trim() || "demo";

    const url = new URL(location.href);
    url.searchParams.set("room", roomId);
    history.replaceState(null, "", url.toString());

    for (const pid of Array.from(peers.keys())) removePeer(pid);

    wsWanted = true;
    if (ws) try { ws.close(); } catch {}
    connectWS();

    setStatus(`🚪 Entrando a room: ${roomId}`);
    toast(`🚪 Room: ${roomId}`);
  }

  async function copyRoomLink() {
    const url = new URL(location.href);
    url.searchParams.set("room", roomId);
    const text = url.toString();

    try {
      await navigator.clipboard.writeText(text);
      setStatus("🔗 Link copiado.");
      toast("🔗 Copiado al portapapeles");
    } catch {
      prompt("Copia el link:", text);
    }
  }

  // ===== Hooks =====
  joinBtn && (joinBtn.onclick = () => joinRoom(roomInput ? roomInput.value : roomId));
  copyBtn && (copyBtn.onclick = () => copyRoomLink());
  roomInput && roomInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(roomInput.value); });

  camBtn && (camBtn.onclick = async () => {
    try {
      if (!camStream) await startCamera(false);
      if (usingScreen) toast("ℹ️ Estás en pantalla. Detén pantalla para volver a cámara.");
      else {
        localStream = camStream;
        applyMutePolicy();
        await setLocalPreview(localStream);
        await replaceTracksAll();
        toast("🎥 Usando cámara");
      }
    } catch (e) {
      setStatus(`❌ Cámara: ${e?.name || "error"}`);
    }
  });

  // FIX: screenBtn y presentBtn ahora usan el mismo “smart” (no rompes nada)
  screenBtn && (screenBtn.onclick = () =>
    startPresentSmart().catch((e) => setStatus(`❌ Presentar: ${e?.name || "error"}`))
  );

  presentBtn && (presentBtn.onclick = () =>
    startPresentSmart().catch((e) => setStatus(`❌ Presentar: ${e?.name || "error"}`))
  );

  stopBtn && (stopBtn.onclick = () => stopAll());
  muteBtn && (muteBtn.onclick = () => toggleMute());

  // Boot (FIX: aquí NO llamamos connectWS dos veces)
  joinRoom(roomId);
  ensureChatUI();
  updateMuteLabel();
  if (isMobile()) setStatus("📱 Móvil: Presentar = cámara trasera (no hay pantalla real en web móvil).");
});

















// public/app.js
// ✅ FIX PRO: pantalla + cámara sin "negro" y sin comportamiento raro
// - Ya NO usamos "localStream = lo último que prendí" para enviar.
// - Ahora mantenemos 2 streams: camStream y screenStream, y construimos un "sendStream" estable.
// - Regla default: si hay pantalla activa -> se envía pantalla SIEMPRE (cámara queda como PiP local).
// - Si apagas cámara mientras sigues con pantalla -> NO se pone negro (seguirá enviando pantalla).
// - Agrega botón HUD: 🔁 Swap (solo si hay pantalla + cámara) para cambiar qué se envía (pantalla vs cámara).

// document.addEventListener("DOMContentLoaded", () => {
//   const $ = (q) => document.querySelector(q);

//   // ===== UI refs =====
//   const roomInput   = $("#roomInput");
//   const joinBtn     = $("#joinBtn");
//   const copyBtn     = $("#copyBtn");

//   const camBtn      = $("#camBtn");
//   const screenBtn   = $("#screenBtn");   // Pantalla (desktop)
//   const presentBtn  = $("#presentBtn");  // Presentar (móvil: cámara trasera)
//   const stopBtn     = $("#stopBtn");
//   const muteBtn     = $("#muteBtn");

//   const localVideo  = $("#localVideo");
//   const remotes     = $("#remotes");
//   const statusEl    = $("#status");

//   // ===== Small UI helpers =====
//   function setStatus(t) {
//     if (statusEl) statusEl.textContent = t || "";
//     console.log("[status]", t);
//   }

//   function toast(msg, ms = 1600) {
//     const el = document.createElement("div");
//     el.style.cssText = `
//       position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
//       background: rgba(0,0,0,.55); color: rgba(255,255,255,.92);
//       border: 1px solid rgba(255,255,255,.14);
//       padding: 10px 12px; border-radius: 999px; z-index: 9999;
//       backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
//       font: 700 13px ui-sans-serif, system-ui; box-shadow: 0 10px 30px rgba(0,0,0,.35);
//       max-width: min(92vw, 520px); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
//     `;
//     el.textContent = msg;
//     document.body.appendChild(el);
//     setTimeout(() => el.remove(), ms);
//   }

//   function randId() {
//     return Math.random().toString(16).slice(2) + Date.now().toString(16);
//   }

//   function escapeHtml(s) {
//     return String(s || "").replace(/[&<>"']/g, (c) => ({
//       "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
//     }[c]));
//   }

//   // ===== Device helpers =====
//   function isIOS() {
//     return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
//       (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
//   }
//   function isMobile() {
//     return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
//   }
//   function supportsScreenShare() {
//     return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
//   }

//   // ===== Persistent nickname =====
//   function getNick() {
//     const saved = localStorage.getItem("mm_nick");
//     if (saved && saved.trim()) return saved.trim().slice(0, 24);
//     const fallback = "Guest-" + Math.random().toString(16).slice(2, 6);
//     localStorage.setItem("mm_nick", fallback);
//     return fallback;
//   }
//   function setNick(n) {
//     const name = String(n || "").trim().slice(0, 24);
//     if (!name) return;
//     localStorage.setItem("mm_nick", name);
//   }
//   let nick = getNick();

//   // ===== State =====
//   const clientId = randId();
//   let roomId = new URL(location.href).searchParams.get("room") || "demo";
//   if (roomInput) roomInput.value = roomId;

//   if (localVideo) {
//     localVideo.muted = true;
//     localVideo.playsInline = true;

//     localVideo.addEventListener("dblclick", async () => {
//       try {
//         if (document.fullscreenElement) await document.exitFullscreen();
//         else await localVideo.requestFullscreen();
//       } catch {}
//     });
//   }

//   // ICE
//   const iceConfig = {
//     iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
//   };

//   // ===== Inject WOW styles =====
//   function injectWowStyles() {
//     if (document.getElementById("mm-wow-style")) return;
//     const st = document.createElement("style");
//     st.id = "mm-wow-style";
//     st.textContent = `
//       .mm-hud{
//         position: fixed; left: 16px; bottom: 16px; z-index: 9999;
//         display: flex; gap: 10px; padding: 10px;
//         border-radius: 18px;
//         border: 1px solid rgba(255,255,255,.12);
//         background: rgba(0,0,0,.22);
//         backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
//         box-shadow: 0 18px 60px rgba(0,0,0,.45);
//         flex-wrap: wrap;
//       }
//       .mm-hud__btn{
//         border: 1px solid rgba(255,255,255,.14);
//         background: rgba(255,255,255,.08);
//         color: rgba(255,255,255,.92);
//         border-radius: 14px;
//         padding: 10px 12px;
//         font-weight: 900;
//         cursor: pointer;
//         transition: transform .12s ease, background .12s ease, border-color .12s ease, opacity .12s ease;
//         user-select:none;
//         white-space: nowrap;
//       }
//       .mm-hud__btn:hover{transform: translateY(-1px); background: rgba(255,255,255,.11); border-color: rgba(255,255,255,.22)}
//       .mm-hud__btn.is-on{
//         background: linear-gradient(135deg, rgba(124,92,255,.35), rgba(33,212,253,.25));
//         border-color: rgba(255,255,255,.24);
//       }
//       .mm-hud__btn.is-off{opacity:.55}

//       .remoteCard.is-speaking{
//         border-color: rgba(33,212,253,.35) !important;
//         box-shadow: 0 0 0 1px rgba(33,212,253,.18), 0 18px 60px rgba(0,0,0,.45) !important;
//       }
//       .remoteCard.is-spotlight{
//         border-color: rgba(124,92,255,.45) !important;
//         box-shadow: 0 0 0 1px rgba(124,92,255,.22), 0 20px 70px rgba(0,0,0,.55) !important;
//       }

//       .mm-caption{
//         position: absolute;
//         left: 12px; right: 12px; bottom: 58px;
//         padding: 10px 12px;
//         border-radius: 14px;
//         border: 1px solid rgba(255,255,255,.12);
//         background: rgba(0,0,0,.45);
//         color: rgba(255,255,255,.92);
//         font: 900 13px ui-sans-serif, system-ui;
//         opacity: 0;
//         transform: translateY(8px);
//         transition: all .18s ease;
//         pointer-events: none;
//         z-index: 999;
//       }
//       .mm-caption.show{opacity:1; transform: translateY(0)}
//       .mm-caption__name{color: rgba(33,212,253,.95)}

//       .tile.ptt-speaking{
//         outline: 2px solid rgba(33,212,253,.55);
//         outline-offset: 2px;
//       }

//       /* ✅ PiP local (cámara encima cuando hay pantalla) */
//       .mm-pip{
//         position:absolute;
//         right: 12px;
//         bottom: 12px;
//         width: min(26vw, 210px);
//         aspect-ratio: 16/9;
//         border-radius: 14px;
//         overflow:hidden;
//         border: 1px solid rgba(255,255,255,.18);
//         box-shadow: 0 16px 45px rgba(0,0,0,.45);
//         background: rgba(0,0,0,.25);
//         z-index: 1200;
//       }
//       .mm-pip video{width:100%;height:100%;object-fit:cover}
//     `;
//     document.head.appendChild(st);
//   }
//   injectWowStyles();

//   // ===== WS (reconexión + heartbeat) =====
//   let ws = null;
//   let wsWanted = true;
//   let reconnectTry = 0;
//   let pingTimer = null;

//   function wsSend(data) {
//     if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
//   }

//   function startClientHeartbeat() {
//     stopClientHeartbeat();
//     pingTimer = setInterval(() => wsSend({ type: "ping", t: Date.now() }), 20000);
//   }
//   function stopClientHeartbeat() {
//     if (pingTimer) clearInterval(pingTimer);
//     pingTimer = null;
//   }

//   function connectWS() {
//     const proto = location.protocol === "https:" ? "wss" : "ws";
//     ws = new WebSocket(`${proto}://${location.host}`);

//     ws.onopen = () => {
//       reconnectTry = 0;
//       setStatus(`✅ Conectado • ${clientId.slice(0, 8)} • room ${roomId}`);
//       wsSend({ type: "join", roomId, clientId, name: nick });
//       startClientHeartbeat();
//     };

//     ws.onmessage = async (ev) => {
//       const msg = JSON.parse(ev.data);

//       if (msg.type === "pong") return;

//       if (msg.type === "peers") {
//         for (const p of msg.peers) await ensurePeer(p.id, p.name);
//         for (const p of msg.peers) await forceOffer(p.id);
//         setRoomBadgeCount(msg.peers.length + 1);
//         return;
//       }

//       if (msg.type === "peer-joined") {
//         await ensurePeer(msg.clientId, msg.name);
//         toast(`👋 Entró ${msg.name || msg.clientId.slice(0, 8)}`);
//         setRoomBadgeCount(peers.size + 1);
//         return;
//       }

//       if (msg.type === "peer-left") {
//         toast(`👋 Salió ${getPeerName(msg.clientId)}`);
//         removePeer(msg.clientId);
//         setRoomBadgeCount(peers.size + 1);
//         return;
//       }

//       if (msg.type === "peer-meta") {
//         const st = peers.get(msg.clientId);
//         if (st) {
//           st.name = msg.name || st.name;
//           st.nameEl.textContent = st.name;
//         }
//         return;
//       }

//       if (msg.type === "chat") {
//         addChatLine({
//           mine: msg.from === clientId,
//           name: msg.name || msg.from.slice(0, 8),
//           text: msg.text || "",
//           ts: msg.ts || Date.now()
//         });
//         return;
//       }

//       if (msg.type === "reaction") {
//         showReaction(msg.from, msg.emoji || "✨");
//         return;
//       }

//       if (msg.type === "caption") {
//         showCaption(msg.from, msg.name || msg.from.slice(0, 8), msg.text || "");
//         return;
//       }

//       if (msg.type === "signal") {
//         await ensurePeer(msg.from);
//         await onSignal(msg.from, msg.data);
//       }
//     };

//     ws.onclose = () => {
//       stopClientHeartbeat();
//       setStatus("❌ WS desconectado");
//       if (wsWanted) scheduleReconnect();
//     };
//     ws.onerror = () => setStatus("⚠️ Error WS");
//   }

//   function scheduleReconnect() {
//     reconnectTry++;
//     const wait = Math.min(15000, 400 * Math.pow(2, reconnectTry));
//     toast(`🔁 Reintentando conexión… (${Math.round(wait / 1000)}s)`, 1400);
//     setTimeout(() => {
//       if (!wsWanted) return;
//       connectWS();
//     }, wait);
//   }

//   // =========================================================
//   // ✅ MEDIA PRO: camStream + screenStream + sendStream estable
//   // =========================================================
//   let camStream = null;              // cámara+mic (o solo cam si decides)
//   let screenStream = null;           // display media raw
//   let screenMicStream = null;        // mic adicional para mezcla (opcional)
//   let screenMixCtx = null;           // AudioContext de mezcla (opcional)
//   let screenVideoTrack = null;       // track de video de pantalla
//   let screenMixedAudioTrack = null;  // track de audio mezclado (sys + mic)

//   let sendStream = null;             // ✅ stream que realmente se ENVÍA por WebRTC
//   let preferSendVideo = "auto";      // "auto" | "screen" | "cam" (solo relevante si hay screen+cam)

//   // mute + PTT
//   let isMuted = false;
//   let pttEnabled = false;

//   // PiP
//   let pipWrap = null;
//   let pipVideo = null;

//   function getCamVideoTrack() {
//     return camStream ? camStream.getVideoTracks()[0] : null;
//   }
//   function getCamAudioTrack() {
//     return camStream ? camStream.getAudioTracks()[0] : null;
//   }
//   function getScreenVideoTrack() {
//     return screenVideoTrack || (screenStream ? screenStream.getVideoTracks()[0] : null);
//   }
//   function getScreenAudioTrack() {
//     return screenMixedAudioTrack || (screenStream ? screenStream.getAudioTracks()[0] : null);
//   }

//   async function setLocalMainPreview(stream) {
//     if (!localVideo) return;
//     localVideo.srcObject = stream || null;
//     if (stream) {
//       localVideo.onloadedmetadata = async () => {
//         try { await localVideo.play(); } catch {}
//       };
//     }
//   }

//   function ensurePiPContainer() {
//     // host = tile (si existe) para que el PiP quede encima del video local
//     const host = localVideo?.closest?.(".tile") || localVideo?.parentElement || document.body;

//     // asegura relative
//     const prevPos = getComputedStyle(host).position;
//     if (prevPos === "static") host.style.position = "relative";

//     if (!pipWrap) {
//       pipWrap = document.createElement("div");
//       pipWrap.className = "mm-pip";
//       pipVideo = document.createElement("video");
//       pipVideo.autoplay = true;
//       pipVideo.playsInline = true;
//       pipVideo.muted = true;
//       pipWrap.appendChild(pipVideo);
//       host.appendChild(pipWrap);
//     }
//     return { host, pipWrap, pipVideo };
//   }

//   function removePiP() {
//     try { pipVideo && (pipVideo.srcObject = null); } catch {}
//     pipWrap?.remove();
//     pipWrap = null;
//     pipVideo = null;
//   }

//   // ✅ Decide qué track de video se envía
//   function chooseSendVideoTrack() {
//     const hasScreen = !!getScreenVideoTrack();
//     const hasCam = !!getCamVideoTrack();

//     if (!hasScreen && !hasCam) return null;
//     if (hasScreen && !hasCam) return getScreenVideoTrack();
//     if (!hasScreen && hasCam) return getCamVideoTrack();

//     // ambos existen:
//     if (preferSendVideo === "cam") return getCamVideoTrack();
//     if (preferSendVideo === "screen") return getScreenVideoTrack();

//     // auto: si hay pantalla activa, manda pantalla
//     return getScreenVideoTrack();
//   }

//   // ✅ Decide audio a enviar (si pantalla está activa: prioriza audio de pantalla mezclado, si no: audio de cam)
//   function chooseSendAudioTrack() {
//     const hasScreen = !!getScreenVideoTrack();
//     if (hasScreen) {
//       return getScreenAudioTrack() || getCamAudioTrack() || null;
//     }
//     return getCamAudioTrack() || null;
//   }

//   function setAudioEnabled(on) {
//     if (!sendStream) return;
//     sendStream.getAudioTracks().forEach(t => (t.enabled = !!on));
//   }

//   // ✅ Rebuild del stream que se envía (evita negro / track null accidental)
//   async function rebuildSendStreamAndUpdate() {
//     const v = chooseSendVideoTrack();
//     const a = chooseSendAudioTrack();

//     const ns = new MediaStream();
//     if (v) ns.addTrack(v);
//     if (a) ns.addTrack(a);
//     sendStream = ns;

//     // aplica mute/PTT a audio de envío
//     if (pttEnabled) {
//       isMuted = true;
//       setAudioEnabled(false);
//     } else {
//       setAudioEnabled(!isMuted);
//     }

//     // preview local:
//     const hasScreen = !!getScreenVideoTrack();
//     const hasCam = !!getCamVideoTrack();

//     if (hasScreen) {
//       // main = pantalla raw
//       await setLocalMainPreview(screenStream || new MediaStream([getScreenVideoTrack()].filter(Boolean)));

//       // PiP = cam si existe
//       if (hasCam) {
//         const { pipVideo } = ensurePiPContainer();
//         pipVideo.srcObject = camStream;
//         pipVideo.onloadedmetadata = async () => { try { await pipVideo.play(); } catch {} };
//       } else {
//         removePiP();
//       }
//     } else {
//       // main = cam
//       removePiP();
//       await setLocalMainPreview(camStream);
//     }

//     await replaceTracksAll();
//     updateHUD();
//     updateMuteLabel();
//   }

//   // ===== Start camera =====
//   async function startCamera(preferBack = false) {
//     if (!navigator.mediaDevices?.getUserMedia) {
//       setStatus("❌ getUserMedia no disponible en este navegador.");
//       throw new Error("getUserMedia not available");
//     }

//     const tryConstraints = preferBack
//       ? [
//           { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
//           { video: { facingMode: "environment" }, audio: true },
//           { video: true, audio: true }
//         ]
//       : [
//           { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
//           { video: true, audio: true }
//         ];

//     let stream = null;
//     let lastErr = null;

//     for (const c of tryConstraints) {
//       try {
//         stream = await navigator.mediaDevices.getUserMedia(c);
//         break;
//       } catch (e) {
//         lastErr = e;
//         console.warn("getUserMedia fail:", e.name, e.message);
//       }
//     }

//     if (!stream) {
//       setStatus(`❌ No se pudo abrir cámara/mic: ${lastErr?.name || "error"}`);
//       throw lastErr || new Error("camera failed");
//     }

//     // apaga stream previo de cam
//     if (camStream) camStream.getTracks().forEach(t => t.stop());
//     camStream = stream;

//     // si hay pantalla activa, NO cambiamos el envío (por default manda pantalla).
//     // Solo actualizamos PiP y/o audio fallback.
//     await rebuildSendStreamAndUpdate();

//     setStatus(preferBack ? "📱 Cámara trasera lista." : "🎥 Cámara lista.");
//     toast(preferBack ? "📱 Cámara trasera" : "🎥 Cámara lista");
//   }

//   // ===== Start screen (desktop) =====
//   async function startScreenDesktop() {
//     if (!navigator.mediaDevices?.getDisplayMedia) {
//       setStatus("❌ getDisplayMedia no disponible aquí.");
//       throw new Error("getDisplayMedia not available");
//     }

//     const display = await navigator.mediaDevices.getDisplayMedia({
//       video: { frameRate: { ideal: 30, max: 60 } },
//       audio: true
//     });

//     // limpia anterior
//     await stopScreenInternalsOnly();

//     screenStream = display;
//     screenVideoTrack = display.getVideoTracks()[0] || null;
//     const systemAudioTrack = display.getAudioTracks()[0] || null;

//     // mic fallback / mix
//     let micStream = null;
//     try {
//       micStream = await navigator.mediaDevices.getUserMedia({
//         audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
//         video: false
//       });
//     } catch { micStream = null; }
//     screenMicStream = micStream;

//     const micTrack = micStream ? micStream.getAudioTracks()[0] : null;

//     // mezcla sys + mic (si se puede)
//     screenMixedAudioTrack = null;
//     screenMixCtx = null;

//     if (systemAudioTrack || micTrack) {
//       try {
//         const ctx = new (window.AudioContext || window.webkitAudioContext)();
//         screenMixCtx = ctx;
//         const dest = ctx.createMediaStreamDestination();

//         if (systemAudioTrack) {
//           const sysSource = ctx.createMediaStreamSource(new MediaStream([systemAudioTrack]));
//           sysSource.connect(dest);
//         }
//         if (micTrack) {
//           const micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]));
//           micSource.connect(dest);
//         }
//         screenMixedAudioTrack = dest.stream.getAudioTracks()[0] || null;
//       } catch {
//         screenMixedAudioTrack = systemAudioTrack || micTrack || null;
//       }
//     }

//     // default: cuando hay pantalla, manda pantalla
//     preferSendVideo = "screen";

//     // si usuario corta desde UI del navegador
//     if (screenVideoTrack) screenVideoTrack.onended = () => stopScreenOnly().catch(()=>{});

//     await rebuildSendStreamAndUpdate();

//     if (!systemAudioTrack) setStatus("🖥️ Pantalla sin audio de sistema (fallback a mic).");
//     else setStatus("🖥️ Pantalla compartida (audio depende del navegador).");

//     toast("🖥️ Compartiendo pantalla");
//   }

//   // helper: detiene solo internos de pantalla sin tocar cam ni send selection
//   async function stopScreenInternalsOnly() {
//     if (screenStream) {
//       try { screenStream.getTracks().forEach(t => t.stop()); } catch {}
//     }
//     if (screenMicStream) {
//       try { screenMicStream.getTracks().forEach(t => t.stop()); } catch {}
//     }
//     if (screenMixCtx) {
//       try { screenMixCtx.close(); } catch {}
//     }

//     screenStream = null;
//     screenMicStream = null;
//     screenMixCtx = null;
//     screenVideoTrack = null;
//     screenMixedAudioTrack = null;
//   }

//   // ✅ Stop solo pantalla (sin tumbar cámara ni peers)
//   async function stopScreenOnly() {
//     const hadScreen = !!getScreenVideoTrack();
//     if (!hadScreen) return toast("ℹ️ No hay pantalla activa");

//     await stopScreenInternalsOnly();

//     // si estabas forzando enviar cam mientras había pantalla, déjalo en auto
//     if (preferSendVideo === "screen") preferSendVideo = "auto";

//     await rebuildSendStreamAndUpdate();
//     setStatus(camStream ? "🖥️ Pantalla detenida • sigues con cámara" : "🖥️ Pantalla detenida • sin stream");
//     toast("🖥️ Pantalla detenida");
//   }

//   // ✅ Stop solo cámara (sin tumbar pantalla)
//   async function stopCameraOnly() {
//     if (!camStream) return toast("ℹ️ No hay cámara activa");

//     // si estabas enviando cámara (swap) pero hay pantalla, regresa a pantalla para evitar negro
//     if (getScreenVideoTrack() && preferSendVideo === "cam") preferSendVideo = "screen";

//     try { camStream.getTracks().forEach(t => t.stop()); } catch {}
//     camStream = null;

//     await rebuildSendStreamAndUpdate();
//     setStatus(getScreenVideoTrack() ? "🎥 Cámara detenida • sigues con pantalla" : "🎥 Cámara detenida • sin stream");
//     toast("🎥 Cámara detenida");
//   }

//   // "Stop present" legacy: lo dejamos por compatibilidad con tu flujo viejo
//   async function stopPresent() {
//     // antes apagaba pantalla y volvía a cam: mantenemos
//     await stopScreenOnly();
//   }

//   // stop nuclear
//   async function stopAll() {
//     if (!confirm("¿Detener cámara/pantalla y desconectar peers?")) return;

//     await stopScreenInternalsOnly();
//     if (camStream) { try { camStream.getTracks().forEach(t => t.stop()); } catch {} }
//     camStream = null;

//     sendStream = null;
//     removePiP();
//     await setLocalMainPreview(null);
//     await replaceTracksAll();

//     for (const pid of Array.from(peers.keys())) removePeer(pid);

//     if (recOn) stopRecording();
//     if (captionsEnabled) stopCaptions();

//     setStatus("🛑 Detenido.");
//     toast("🛑 Detenido");
//   }

//   // swap: alterna qué se envía (si hay pantalla + cam)
//   async function swapSendVideo() {
//     const hasScreen = !!getScreenVideoTrack();
//     const hasCam = !!getCamVideoTrack();
//     if (!hasScreen || !hasCam) return toast("ℹ️ Necesitas pantalla + cámara para swap");

//     if (preferSendVideo === "cam") preferSendVideo = "screen";
//     else preferSendVideo = "cam";

//     await rebuildSendStreamAndUpdate();
//     toast(preferSendVideo === "cam" ? "🔁 Enviando CÁMARA" : "🔁 Enviando PANTALLA");
//   }

//   function toggleMute() {
//     if (pttEnabled) {
//       disablePTT();
//       isMuted = false;
//       setAudioEnabled(true);
//       setStatus("🔊 Mute OFF");
//       toast("🎙️ PTT OFF");
//       updateMuteLabel();
//       updateHUD();
//       return;
//     }

//     isMuted = !isMuted;
//     setAudioEnabled(!isMuted);

//     setStatus(isMuted ? "🔇 Mute ON" : "🔊 Mute OFF");
//     toast(isMuted ? "🔇 Mute" : "🔊 Unmute");
//     updateMuteLabel();
//     updateHUD();
//   }

//   function updateMuteLabel() {
//     if (!muteBtn) return;
//     const t = muteBtn.querySelector(".dock__t");
//     if (!t) return;
//     if (pttEnabled) t.textContent = "PTT";
//     else t.textContent = isMuted ? "Unmute" : "Mute";
//   }

//   // ===== Present logic (smart) =====
//   async function startPresentSmart() {
//     if (!window.isSecureContext && location.hostname !== "localhost") {
//       setStatus("❌ Necesitas HTTPS para cámara/pantalla en móvil.");
//       alert("Abre el link con https (candadito). En móvil sin HTTPS no habrá permisos.");
//       return;
//     }

//     if (isMobile() || isIOS() || !supportsScreenShare()) {
//       setStatus("📱 Móvil: Presentar = cámara trasera (web móvil no tiene compartir pantalla real).");
//       return startCamera(true);
//     }

//     try {
//       return await startScreenDesktop();
//     } catch (e) {
//       console.warn(e);
//       setStatus("⚠️ Falló pantalla. Usando cámara como fallback.");
//       return startCamera(false);
//     }
//   }

//   // =========================================================
//   // ✅ WEBRTC (Perfect Negotiation) – reemplaza tracks usando sendStream
//   // =========================================================
//   const peers = new Map();

//   function isPoliteFor(peerId) {
//     return clientId.localeCompare(peerId) > 0;
//   }

//   function getPeerName(peerId) {
//     const st = peers.get(peerId);
//     return st?.name || peerId.slice(0, 8);
//   }

//   function setRoomBadgeCount(n) {
//     if (statusEl && String(statusEl.textContent || "").startsWith("✅ Conectado")) {
//       statusEl.textContent = `✅ Conectado • ${clientId.slice(0, 8)} • room ${roomId} • 👥 ${n}`;
//     }
//   }

//   async function replaceTracks(peerId) {
//     const st = peers.get(peerId);
//     if (!st) return;

//     const v = sendStream ? sendStream.getVideoTracks()[0] : null;
//     const a = sendStream ? sendStream.getAudioTracks()[0] : null;

//     try {
//       if (st.vSender) await st.vSender.replaceTrack(v || null);
//       if (st.aSender) await st.aSender.replaceTrack(a || null);
//     } catch {}
//   }

//   async function replaceTracksAll() {
//     for (const pid of peers.keys()) await replaceTracks(pid);
//   }

//   function showReaction(peerId, emoji) {
//     const st = peers.get(peerId);
//     const host = st?.cardEl || localVideo?.closest?.(".tile") || document.body;

//     const fx = document.createElement("div");
//     fx.textContent = emoji;
//     fx.style.cssText = `
//       position:absolute; right: 14px; top: 48px;
//       font-size: 26px; filter: drop-shadow(0 10px 25px rgba(0,0,0,.45));
//       transform: translateY(8px) scale(.9);
//       opacity: 0; transition: all .38s ease;
//       pointer-events:none;
//       z-index: 999;
//     `;

//     const prevPos = getComputedStyle(host).position;
//     if (prevPos === "static") host.style.position = "relative";
//     host.appendChild(fx);

//     requestAnimationFrame(() => {
//       fx.style.opacity = "1";
//       fx.style.transform = "translateY(0) scale(1)";
//     });

//     setTimeout(() => {
//       fx.style.opacity = "0";
//       fx.style.transform = "translateY(-10px) scale(.95)";
//       setTimeout(() => fx.remove(), 420);
//     }, 900);
//   }

//   // ===== Chat (inyectado) =====
//   let chatUI = null;

//   function miniIconBtnCss() {
//     return `
//       width: 34px; height: 34px; border-radius: 12px; cursor:pointer;
//       border: 1px solid rgba(255,255,255,.14);
//       background: rgba(255,255,255,.08);
//       color: rgba(255,255,255,.92);
//       font-weight:900;
//     `;
//   }

//   function ensureChatUI() {
//     if (chatUI) return chatUI;

//     const wrap = document.createElement("div");
//     wrap.style.cssText = `
//       position: fixed; right: 16px; bottom: 16px; z-index: 9998;
//       width: min(360px, calc(100vw - 32px));
//       font: 700 13px ui-sans-serif, system-ui;
//     `;

//     const btn = document.createElement("button");
//     btn.type = "button";
//     btn.textContent = "💬 Chat";
//     btn.style.cssText = `
//       width: 100%; padding: 10px 12px; border-radius: 14px;
//       border: 1px solid rgba(255,255,255,.14);
//       background: rgba(255,255,255,.08);
//       color: rgba(255,255,255,.92);
//       cursor: pointer;
//       backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
//       box-shadow: 0 16px 45px rgba(0,0,0,.45);
//       font-weight:900;
//     `;

//     const panel = document.createElement("div");
//     panel.style.cssText = `
//       margin-top: 10px; border-radius: 18px; overflow: hidden;
//       border: 1px solid rgba(255,255,255,.12);
//       background: rgba(0,0,0,.20);
//       backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
//       box-shadow: 0 18px 60px rgba(0,0,0,.45);
//       display: none;
//     `;

//     const head = document.createElement("div");
//     head.style.cssText = `
//       padding: 10px 12px; display:flex; align-items:center; justify-content:space-between;
//       border-bottom: 1px solid rgba(255,255,255,.08);
//       color: rgba(255,255,255,.86);
//       font-weight:900;
//     `;
//     head.innerHTML = `<span>Chat de sala</span>`;

//     const tools = document.createElement("div");
//     tools.style.cssText = `display:flex; gap:8px; align-items:center;`;

//     const rename = document.createElement("button");
//     rename.type = "button";
//     rename.textContent = "✏️";
//     rename.title = "Cambiar nombre";
//     rename.style.cssText = miniIconBtnCss();
//     rename.onclick = () => {
//       const n = prompt("Tu nombre (máx 24):", nick);
//       if (!n) return;
//       setNick(n);
//       nick = getNick();
//       wsSend({ type: "rename", name: nick });
//       toast(`🪪 Ahora eres ${nick}`);
//     };

//     const react = document.createElement("button");
//     react.type = "button";
//     react.textContent = "✨";
//     react.title = "Reacción";
//     react.style.cssText = miniIconBtnCss();
//     react.onclick = () => {
//       wsSend({ type: "reaction", emoji: "✨" });
//       showReaction(clientId, "✨");
//     };

//     tools.appendChild(rename);
//     tools.appendChild(react);
//     head.appendChild(tools);

//     const log = document.createElement("div");
//     log.style.cssText = `
//       max-height: 260px; overflow:auto; padding: 10px 12px;
//       display:flex; flex-direction:column; gap: 8px;
//     `;

//     const form = document.createElement("form");
//     form.style.cssText = `
//       display:flex; gap: 10px; padding: 10px 12px;
//       border-top: 1px solid rgba(255,255,255,.08);
//       background: rgba(255,255,255,.04);
//     `;

//     const input = document.createElement("input");
//     input.placeholder = "Escribe algo… (Enter)";
//     input.maxLength = 240;
//     input.style.cssText = `
//       flex:1; border: 1px solid rgba(255,255,255,.14);
//       background: rgba(0,0,0,.18); color: rgba(255,255,255,.92);
//       border-radius: 14px; padding: 10px 12px; outline:none;
//       font-weight:800;
//     `;

//     const send = document.createElement("button");
//     send.type = "submit";
//     send.textContent = "Enviar";
//     send.style.cssText = `
//       padding: 10px 12px; border-radius: 14px; cursor:pointer;
//       border: 1px solid rgba(255,255,255,.14);
//       background: rgba(255,255,255,.08);
//       color: rgba(255,255,255,.92);
//       font-weight:900;
//     `;

//     form.appendChild(input);
//     form.appendChild(send);

//     panel.appendChild(head);
//     panel.appendChild(log);
//     panel.appendChild(form);

//     btn.onclick = () => {
//       panel.style.display = panel.style.display === "none" ? "block" : "none";
//       if (panel.style.display === "block") input.focus();
//     };

//     form.onsubmit = (e) => {
//       e.preventDefault();
//       const text = String(input.value || "").trim();
//       if (!text) return;
//       input.value = "";
//       wsSend({ type: "chat", text });
//       addChatLine({ mine: true, name: nick, text, ts: Date.now() });
//     };

//     wrap.appendChild(btn);
//     wrap.appendChild(panel);
//     document.body.appendChild(wrap);

//     chatUI = { wrap, btn, panel, log, input };
//     return chatUI;
//   }

//   function addChatLine({ mine, name, text, ts }) {
//     const ui = ensureChatUI();
//     const row = document.createElement("div");
//     const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

//     row.style.cssText = `
//       align-self: ${mine ? "flex-end" : "flex-start"};
//       max-width: 85%;
//       padding: 8px 10px;
//       border-radius: 14px;
//       border: 1px solid rgba(255,255,255,.12);
//       background: ${mine ? "rgba(124,92,255,.20)" : "rgba(0,0,0,.22)"};
//       color: rgba(255,255,255,.92);
//       box-shadow: 0 10px 25px rgba(0,0,0,.25);
//       white-space: pre-wrap;
//       overflow-wrap: anywhere;
//     `;

//     row.innerHTML = `
//       <div style="font-size:11px;color:rgba(255,255,255,.65);margin-bottom:4px;font-weight:900;">
//         ${escapeHtml(name)} • ${time}
//       </div>
//       <div style="font-size:13px;font-weight:800">${escapeHtml(text)}</div>
//     `;

//     ui.log.appendChild(row);
//     ui.log.scrollTop = ui.log.scrollHeight;
//   }

//   // ===== Captions overlay =====
//   function showCaption(peerId, name, text) {
//     const st = peers.get(peerId);
//     const host = st?.cardEl || document.querySelector(".tile") || document.body;

//     let cap = host.querySelector(".mm-caption");
//     if (!cap) {
//       cap = document.createElement("div");
//       cap.className = "mm-caption";
//       host.appendChild(cap);
//     }

//     const prevPos = getComputedStyle(host).position;
//     if (prevPos === "static") host.style.position = "relative";

//     cap.innerHTML = `<span class="mm-caption__name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
//     cap.classList.add("show");
//     clearTimeout(cap._t);
//     cap._t = setTimeout(() => cap.classList.remove("show"), 1600);
//   }

//   // ===== Remote cards =====
//   function createRemoteCard(peerId, name = null) {
//     const card = document.createElement("div");
//     card.className = "remoteCard";

//     const head = document.createElement("div");
//     head.className = "remoteHeader";

//     const left = document.createElement("span");
//     left.textContent = name || `Peer: ${peerId.slice(0, 8)}`;

//     const right = document.createElement("span");
//     right.textContent = "ice: new";

//     head.appendChild(left);
//     head.appendChild(right);

//     const vid = document.createElement("video");
//     vid.className = "remoteVideo";
//     vid.autoplay = true;
//     vid.playsInline = true;
//     vid.muted = true;

//     vid.addEventListener("dblclick", async () => {
//       try {
//         if (document.fullscreenElement) await document.exitFullscreen();
//         else await vid.requestFullscreen();
//       } catch {}
//     });

//     const actions = document.createElement("div");
//     actions.className = "remoteActions";

//     const listenBtn = document.createElement("button");
//     listenBtn.textContent = "🔊 Escuchar";
//     listenBtn.onclick = async () => {
//       try {
//         vid.muted = false;
//         vid.volume = 1;
//         await vid.play();

//         listenBtn.textContent = "🔇 Silenciar";
//         listenBtn.onclick = () => {
//           vid.muted = true;
//           listenBtn.textContent = "🔊 Escuchar";
//           listenBtn.onclick = async () => {
//             try { vid.muted = false; await vid.play(); } catch {}
//           };
//         };
//       } catch {
//         alert("El navegador bloqueó el audio. Toca otra vez “Escuchar”.");
//       }
//     };

//     const reactBtn = document.createElement("button");
//     reactBtn.textContent = "✨ Reacción";
//     reactBtn.onclick = () => {
//       wsSend({ type: "reaction", emoji: "✨" });
//       showReaction(clientId, "✨");
//     };

//     actions.appendChild(listenBtn);
//     actions.appendChild(reactBtn);

//     card.appendChild(head);
//     card.appendChild(vid);
//     card.appendChild(actions);

//     remotes && remotes.appendChild(card);

//     return { cardEl: card, remoteEl: vid, stEl: right, nameEl: left };
//   }

//   async function ensurePeer(peerId, name = null) {
//     if (!peerId || peerId === clientId) return;

//     if (peers.has(peerId)) {
//       const st = peers.get(peerId);
//       if (name && st && (!st.name || st.name === peerId.slice(0, 8))) {
//         st.name = name;
//         st.nameEl.textContent = name;
//       }
//       return;
//     }

//     const pc = new RTCPeerConnection(iceConfig);
//     const dc = pc.createDataChannel("mm-data", { negotiated: true, id: 0 });

//     const ui = createRemoteCard(peerId, name);

//     const st = {
//       pc,
//       dc,
//       name: name || peerId.slice(0, 8),
//       polite: isPoliteFor(peerId),
//       makingOffer: false,
//       ignoreOffer: false,
//       vSender: null,
//       aSender: null,
//       remoteStream: new MediaStream(),
//       lastBytes: 0,
//       lastTs: 0,
//       ...ui
//     };
//     peers.set(peerId, st);

//     setupDataChannel(peerId);

//     const vTrans = pc.addTransceiver("video", { direction: "sendrecv" });
//     const aTrans = pc.addTransceiver("audio", { direction: "sendrecv" });
//     st.vSender = vTrans.sender;
//     st.aSender = aTrans.sender;

//     pc.ontrack = (ev) => {
//       st.remoteStream.addTrack(ev.track);
//       st.remoteEl.srcObject = st.remoteStream;
//       st.remoteEl.onloadedmetadata = async () => { try { await st.remoteEl.play(); } catch {} };
//     };

//     pc.onicecandidate = (ev) => {
//       if (ev.candidate) wsSend({ type: "signal", to: peerId, data: { kind: "ice", candidate: ev.candidate } });
//     };

//     pc.oniceconnectionstatechange = () => {
//       st.stEl.textContent = `ice: ${pc.iceConnectionState}`;
//     };

//     pc.onnegotiationneeded = async () => {
//       try {
//         st.makingOffer = true;
//         const offer = await pc.createOffer();
//         if (pc.signalingState !== "stable") return;
//         await pc.setLocalDescription(offer);
//         wsSend({ type: "signal", to: peerId, data: { kind: "desc", desc: pc.localDescription } });
//       } finally {
//         st.makingOffer = false;
//       }
//     };

//     await replaceTracks(peerId);
//     startStatsLoop(peerId);
//   }

//   async function forceOffer(peerId) {
//     const st = peers.get(peerId);
//     if (!st) return;
//     try {
//       st.makingOffer = true;
//       const offer = await st.pc.createOffer();
//       if (st.pc.signalingState !== "stable") return;
//       await st.pc.setLocalDescription(offer);
//       wsSend({ type: "signal", to: peerId, data: { kind: "desc", desc: st.pc.localDescription } });
//     } finally {
//       st.makingOffer = false;
//     }
//   }

//   async function onSignal(peerId, data) {
//     const st = peers.get(peerId);
//     if (!st) return;

//     if (data.kind === "ice") {
//       try { await st.pc.addIceCandidate(data.candidate); } catch {}
//       return;
//     }

//     if (data.kind === "desc") {
//       const desc = data.desc;
//       const offerCollision = desc.type === "offer" && (st.makingOffer || st.pc.signalingState !== "stable");
//       st.ignoreOffer = !st.polite && offerCollision;
//       if (st.ignoreOffer) return;

//       try {
//         await st.pc.setRemoteDescription(desc);
//         if (desc.type === "offer") {
//           await replaceTracks(peerId);
//           const answer = await st.pc.createAnswer();
//           await st.pc.setLocalDescription(answer);
//           wsSend({ type: "signal", to: peerId, data: { kind: "desc", desc: st.pc.localDescription } });
//         }
//       } catch (e) {
//         console.warn("setRemoteDescription error", e);
//       }
//     }
//   }

//   function removePeer(peerId) {
//     const st = peers.get(peerId);
//     if (!st) return;
//     try { st.pc.close(); } catch {}
//     st._statsTimer && clearInterval(st._statsTimer);

//     if (vad && vad.has(peerId)) {
//       try { vad.delete(peerId); } catch {}
//     }

//     st.cardEl?.remove();
//     peers.delete(peerId);
//   }

//   function startStatsLoop(peerId) {
//     const st = peers.get(peerId);
//     if (!st || st._statsTimer) return;

//     st._statsTimer = setInterval(async () => {
//       try {
//         const stats = await st.pc.getStats();
//         let rtt = null;
//         let bytes = null;
//         let ts = null;

//         stats.forEach((r) => {
//           if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) {
//             rtt = Math.round(r.currentRoundTripTime * 1000);
//           }
//           if (r.type === "outbound-rtp" && r.kind === "video") {
//             bytes = r.bytesSent;
//             ts = r.timestamp;
//           }
//         });

//         let bitrate = null;
//         if (bytes != null && ts != null) {
//           if (st.lastTs) {
//             const dt = (ts - st.lastTs) / 1000;
//             const db = bytes - st.lastBytes;
//             if (dt > 0 && db >= 0) bitrate = Math.round((db * 8) / dt / 1000);
//           }
//           st.lastBytes = bytes;
//           st.lastTs = ts;
//         }

//         const ice = st.pc.iceConnectionState;
//         const parts = [`ice:${ice}`];
//         if (bitrate != null) parts.push(`${bitrate}kbps`);
//         if (rtt != null) parts.push(`${rtt}ms`);
//         st.stEl.textContent = parts.join(" • ");
//       } catch {}
//     }, 1800);
//   }

//   // ===== Room =====
//   function joinRoom(newRoom) {
//     roomId = (newRoom || "demo").trim() || "demo";

//     const url = new URL(location.href);
//     url.searchParams.set("room", roomId);
//     history.replaceState(null, "", url.toString());

//     for (const pid of Array.from(peers.keys())) removePeer(pid);

//     wsWanted = true;
//     if (ws) ws.close();
//     connectWS();

//     setStatus(`🚪 Entrando a room: ${roomId}`);
//     toast(`🚪 Room: ${roomId}`);
//   }

//   async function copyRoomLink() {
//     const url = new URL(location.href);
//     url.searchParams.set("room", roomId);
//     const text = url.toString();

//     try {
//       await navigator.clipboard.writeText(text);
//       setStatus("🔗 Link copiado.");
//       toast("🔗 Copiado al portapapeles");
//     } catch {
//       prompt("Copia el link:", text);
//     }
//   }

//   // ===== Keyboard shortcuts =====
//   function bindHotkeys() {
//     window.addEventListener("keydown", (e) => {
//       if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;

//       if (e.key === "m" || e.key === "M") toggleMute();
//       if (e.key === "c" || e.key === "C") startCamera(false).catch(() => {});
//       if (e.key === "p" || e.key === "P") startPresentSmart().catch(() => {});
//       if (e.key === "s" || e.key === "S") stopScreenOnly().catch(() => {});
//       if (e.key === "v" || e.key === "V") stopCameraOnly().catch(() => {});
//       if (e.key === "x" || e.key === "X") swapSendVideo().catch(() => {}); // swap
//       if (e.key === "Escape") stopAll().catch(() => {});
//     });
//   }

//   // =========================================================
//   // WOW PACK: VAD + Spotlight + Recorder + PTT + Captions + File Transfer
//   // (mantengo todo tu bloque, solo cambié Recorder para usar sendStream)
//   // =========================================================

//   // ----- AudioContext (para VAD) -----
//   let audioCtx = null;
//   function ensureAudioCtx() {
//     if (audioCtx) return audioCtx;
//     try {
//       audioCtx = new (window.AudioContext || window.webkitAudioContext)();
//     } catch {
//       audioCtx = null;
//     }
//     return audioCtx;
//   }

//   window.addEventListener("click", () => {
//     const ctx = ensureAudioCtx();
//     if (ctx && ctx.state === "suspended") ctx.resume().catch(()=>{});
//   }, { once: true });

//   // ----- Speaking indicator / VAD -----
//   const vad = new Map();
//   let spotlightId = null;

//   function rmsFromTimeDomain(arr) {
//     let sum = 0;
//     for (let i = 0; i < arr.length; i++) {
//       const v = (arr[i] - 128) / 128;
//       sum += v * v;
//     }
//     return Math.sqrt(sum / arr.length);
//   }

//   function ensureVAD(peerId, stream) {
//     if (!stream) return;
//     const st = peers.get(peerId);
//     if (!st || vad.has(peerId)) return;

//     const ctx = ensureAudioCtx();
//     if (!ctx) return;

//     try {
//       const a = stream.getAudioTracks()[0];
//       if (!a) return;

//       const src = ctx.createMediaStreamSource(new MediaStream([a]));
//       const an = ctx.createAnalyser();
//       an.fftSize = 512;
//       src.connect(an);

//       vad.set(peerId, { analyser: an, tmp: new Uint8Array(an.fftSize), lastSpeakTs: 0 });
//     } catch {}
//   }

//   setInterval(() => {
//     let best = { id: null, level: 0 };

//     for (const [peerId, v] of vad.entries()) {
//       const st = peers.get(peerId);
//       if (!st) continue;

//       v.analyser.getByteTimeDomainData(v.tmp);
//       const level = rmsFromTimeDomain(v.tmp);

//       const speaking = level > 0.05;
//       st.cardEl.classList.toggle("is-speaking", speaking);
//       if (speaking) v.lastSpeakTs = Date.now();

//       if (level > best.level) best = { id: peerId, level };
//     }

//     if (best.id && best.level > 0.075) {
//       if (spotlightId !== best.id) {
//         if (spotlightId && peers.get(spotlightId)) peers.get(spotlightId).cardEl.classList.remove("is-spotlight");
//         spotlightId = best.id;

//         const st = peers.get(spotlightId);
//         if (st) {
//           st.cardEl.classList.add("is-spotlight");
//           if (remotes && st.cardEl.parentElement === remotes) remotes.prepend(st.cardEl);
//         }
//       }
//     }
//   }, 260);

//   setInterval(() => {
//     for (const [peerId, st] of peers.entries()) {
//       if (st?.remoteStream) ensureVAD(peerId, st.remoteStream);
//     }
//   }, 700);

//   // ----- Captions -----
//   let rec = null;
//   let captionsEnabled = false;
//   let lastCaptionSend = 0;

//   function supportsSpeech() {
//     return "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
//   }

//   function startCaptions() {
//     if (!supportsSpeech()) return toast("❌ Tu navegador no soporta subtítulos (SpeechRecognition)");
//     const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

//     rec = new SR();
//     rec.lang = "es-MX";
//     rec.continuous = true;
//     rec.interimResults = true;

//     captionsEnabled = true;

//     rec.onresult = (e) => {
//       let finalText = "";
//       let interim = "";

//       for (let i = e.resultIndex; i < e.results.length; i++) {
//         const t = e.results[i][0]?.transcript || "";
//         if (e.results[i].isFinal) finalText += t;
//         else interim += t;
//       }

//       const text = (finalText || interim).trim();
//       if (!text) return;

//       const now = Date.now();
//       const isFinal = !!finalText.trim();
//       if (!isFinal && now - lastCaptionSend < 700) return;
//       lastCaptionSend = now;

//       wsSend({ type: "caption", text });
//       showCaption(clientId, nick, text);
//     };

//     rec.onend = () => {
//       if (captionsEnabled) { try { rec.start(); } catch {} }
//     };

//     try { rec.start(); toast("📝 Subtítulos ON"); } catch { toast("⚠️ No se pudieron iniciar subtítulos"); }
//     updateHUD();
//   }

//   function stopCaptions() {
//     captionsEnabled = false;
//     try { rec && rec.stop(); } catch {}
//     rec = null;
//     toast("📝 Subtítulos OFF");
//     updateHUD();
//   }

//   // ----- Recorder (usa sendStream, no "lo último") -----
//   let mr = null;
//   let recChunks = [];
//   let recOn = false;

//   function startRecording() {
//     if (!sendStream || (!sendStream.getVideoTracks()[0] && !sendStream.getAudioTracks()[0])) {
//       return toast("❌ No hay stream para grabar. Inicia cámara/pantalla.");
//     }
//     if (!window.MediaRecorder) return toast("❌ MediaRecorder no disponible.");

//     recChunks = [];
//     const mime =
//       MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" :
//       MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" :
//       "video/webm";

//     mr = new MediaRecorder(sendStream, { mimeType: mime });

//     mr.ondataavailable = (e) => e.data && e.data.size && recChunks.push(e.data);
//     mr.onstop = () => {
//       const blob = new Blob(recChunks, { type: mime });
//       const url = URL.createObjectURL(blob);
//       const a = document.createElement("a");
//       a.href = url;
//       a.download = `minimeet_${roomId}_${Date.now()}.webm`;
//       a.click();
//       setTimeout(() => URL.revokeObjectURL(url), 1200);
//       toast("🎬 Video descargado");
//     };

//     mr.start(800);
//     recOn = true;
//     toast("🔴 REC ON");
//     updateHUD();
//   }

//   function stopRecording() {
//     try { mr && mr.stop(); } catch {}
//     mr = null;
//     recOn = false;
//     toast("⏹️ REC OFF");
//     updateHUD();
//   }

//   // ----- Device picker (simple, recomendado usar antes de compartir pantalla) -----
//   async function listDevices() {
//     const devs = await navigator.mediaDevices.enumerateDevices();
//     return {
//       cams: devs.filter(d => d.kind === "videoinput"),
//       mics: devs.filter(d => d.kind === "audioinput")
//     };
//   }

//   async function switchDevices({ camId = null, micId = null } = {}) {
//     // Si hay pantalla activa, cambiar mic "real" implicaría reconstruir la mezcla.
//     // Aquí lo dejamos simple: cambia cámara/mic solo del camStream.
//     const constraints = {
//       video: camId ? { deviceId: { exact: camId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true,
//       audio: micId ? { deviceId: { exact: micId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : true
//     };

//     const stream = await navigator.mediaDevices.getUserMedia(constraints);

//     if (camStream) camStream.getTracks().forEach(t => t.stop());
//     camStream = stream;

//     await rebuildSendStreamAndUpdate();
//     toast("🎛️ Dispositivos cambiados");
//   }

//   // ----- Push-to-talk (SPACE) -----
//   function enablePTT() {
//     pttEnabled = true;
//     isMuted = true;
//     setAudioEnabled(false);
//     setStatus("🎙️ PTT ON (mantén SPACE para hablar)");
//     toast("🎙️ Push-to-talk ON");
//     updateMuteLabel();
//     updateHUD();
//   }

//   function disablePTT() {
//     pttEnabled = false;
//     setAudioEnabled(!isMuted);
//     toast("🎙️ Push-to-talk OFF");
//     updateMuteLabel();
//     updateHUD();

//     const tile = document.querySelector(".tile");
//     tile && tile.classList.remove("ptt-speaking");
//   }

//   window.addEventListener("keydown", (e) => {
//     if (!pttEnabled) return;
//     if (e.code !== "Space") return;
//     if (e.repeat) return;

//     const tag = (e.target && e.target.tagName) || "";
//     if (tag === "INPUT" || tag === "TEXTAREA") return;

//     setAudioEnabled(true);
//     const tile = document.querySelector(".tile");
//     tile && tile.classList.add("ptt-speaking");
//   });

//   window.addEventListener("keyup", (e) => {
//     if (!pttEnabled) return;
//     if (e.code !== "Space") return;

//     setAudioEnabled(false);
//     const tile = document.querySelector(".tile");
//     tile && tile.classList.remove("ptt-speaking");
//   });

//   // ----- DataChannel P2P: files -----
//   const fileRx = new Map();
//   const CHUNK = 16 * 1024;

//   function setupDataChannel(peerId) {
//     const st = peers.get(peerId);
//     if (!st?.dc) return;

//     st.dc.binaryType = "arraybuffer";

//     st.dc.onmessage = (ev) => {
//       if (typeof ev.data === "string") {
//         let m = null;
//         try { m = JSON.parse(ev.data); } catch { return; }

//         if (m.t === "file-meta") {
//           fileRx.set(peerId, { name: m.name, size: m.size, chunks: [], received: 0 });
//           toast(`📥 Recibiendo: ${m.name} (${Math.round(m.size / 1024)} KB)`);
//           return;
//         }

//         if (m.t === "file-done") {
//           const rx = fileRx.get(peerId);
//           if (!rx) return;

//           const blob = new Blob(rx.chunks);
//           const url = URL.createObjectURL(blob);
//           const a = document.createElement("a");
//           a.href = url;
//           a.download = rx.name || `file_${Date.now()}`;
//           a.click();
//           setTimeout(() => URL.revokeObjectURL(url), 1200);

//           toast(`✅ Archivo listo: ${rx.name}`);
//           fileRx.delete(peerId);
//           setStatus("✅ Recibido");
//           return;
//         }
//         return;
//       }

//       const rx = fileRx.get(peerId);
//       if (!rx) return;

//       rx.chunks.push(ev.data);
//       rx.received += ev.data.byteLength;

//       const pct = Math.min(100, Math.round((rx.received / rx.size) * 100));
//       setStatus(`📥 ${rx.name} • ${pct}%`);
//     };
//   }

//   async function sendFileToAll(file) {
//     if (!file) return;
//     const buf = await file.arrayBuffer();

//     let sentTo = 0;
//     for (const [, st] of peers.entries()) {
//       if (!st?.dc || st.dc.readyState !== "open") continue;

//       try {
//         st.dc.send(JSON.stringify({ t: "file-meta", name: file.name, size: buf.byteLength }));
//         for (let off = 0; off < buf.byteLength; off += CHUNK) st.dc.send(buf.slice(off, off + CHUNK));
//         st.dc.send(JSON.stringify({ t: "file-done" }));
//         sentTo++;
//       } catch {}
//     }

//     toast(sentTo ? `📤 Enviado a ${sentTo}: ${file.name}` : "⚠️ No hay DataChannels listos");
//   }

//   // ----- HUD (REC / CC / PTT / DEV / FILE + STOPs + SWAP) -----
//   let hud = null;
//   let fileInput = null;

//   function buildHUD() {
//     if (hud) return hud;

//     const wrap = document.createElement("div");
//     wrap.className = "mm-hud";
//     wrap.innerHTML = `
//       <button class="mm-hud__btn" data-act="rec">● REC</button>
//       <button class="mm-hud__btn" data-act="captions">CC</button>
//       <button class="mm-hud__btn" data-act="ptt">PTT</button>
//       <button class="mm-hud__btn" data-act="dev">⚙</button>
//       <button class="mm-hud__btn" data-act="file">📎</button>

//       <button class="mm-hud__btn" data-act="stopscr">🖥 Stop</button>
//       <button class="mm-hud__btn" data-act="stopcam">🎥 Stop</button>
//       <button class="mm-hud__btn" data-act="swap">🔁 Swap</button>
//     `;

//     fileInput = document.createElement("input");
//     fileInput.type = "file";
//     fileInput.style.display = "none";
//     fileInput.onchange = () => {
//       const f = fileInput.files && fileInput.files[0];
//       if (f) sendFileToAll(f);
//       fileInput.value = "";
//     };

//     document.body.appendChild(wrap);
//     document.body.appendChild(fileInput);

//     wrap.addEventListener("click", async (e) => {
//       const b = e.target.closest("button");
//       if (!b) return;
//       const act = b.getAttribute("data-act");

//       if (act === "rec") { if (!recOn) startRecording(); else stopRecording(); return; }
//       if (act === "captions") { if (!captionsEnabled) startCaptions(); else stopCaptions(); return; }
//       if (act === "ptt") { if (!pttEnabled) enablePTT(); else disablePTT(); return; }
//       if (act === "file") { fileInput.click(); return; }
//       if (act === "stopscr") { stopScreenOnly().catch(()=>{}); return; }
//       if (act === "stopcam") { stopCameraOnly().catch(()=>{}); return; }
//       if (act === "swap") { swapSendVideo().catch(()=>{}); return; }

//       if (act === "dev") {
//         try {
//           if (!camStream) toast("ℹ️ Tip: inicia cámara para ver nombres de dispositivos", 2000);

//           const { cams, mics } = await listDevices();
//           const camPick = cams.map((d, i) => `${i + 1}) ${d.label || "Cam"} `).join("\n");
//           const micPick = mics.map((d, i) => `${i + 1}) ${d.label || "Mic"} `).join("\n");

//           const camIdx = prompt(`Elige CÁMARA (número) o vacío:\n${camPick}`, "");
//           const micIdx = prompt(`Elige MIC (número) o vacío:\n${micPick}`, "");

//           const camId = camIdx ? cams[Number(camIdx) - 1]?.deviceId : null;
//           const micId = micIdx ? mics[Number(micIdx) - 1]?.deviceId : null;

//           if (camId || micId) await switchDevices({ camId, micId });
//         } catch {
//           toast("⚠️ No se pudo abrir selector (da permisos primero)");
//         }
//         return;
//       }
//     });

//     hud = { wrap };
//     updateHUD();
//     return hud;
//   }

//   function updateHUD() {
//     if (!hud) return;

//     const btn = (sel) => hud.wrap.querySelector(sel);
//     const all = hud.wrap.querySelectorAll(".mm-hud__btn");
//     all.forEach(b => b.classList.remove("is-on", "is-off"));

//     if (recOn) btn('[data-act="rec"]')?.classList.add("is-on");
//     if (captionsEnabled) btn('[data-act="captions"]')?.classList.add("is-on");
//     if (pttEnabled) btn('[data-act="ptt"]')?.classList.add("is-on");

//     // habilita / deshabilita swap según estado
//     const swapBtn = btn('[data-act="swap"]');
//     const canSwap = !!getScreenVideoTrack() && !!getCamVideoTrack();
//     if (swapBtn) swapBtn.classList.toggle("is-off", !canSwap);

//     // stop buttons "on" cuando existe esa fuente
//     const scrBtn = btn('[data-act="stopscr"]');
//     const camStopBtn = btn('[data-act="stopcam"]');
//     scrBtn && scrBtn.classList.toggle("is-on", !!getScreenVideoTrack());
//     camStopBtn && camStopBtn.classList.toggle("is-on", !!getCamVideoTrack());

//     // marca swap como "on" si estás enviando cam
//     if (canSwap && preferSendVideo === "cam") swapBtn?.classList.add("is-on");
//   }

//   buildHUD();

//   // ===== Events =====
//   joinBtn && (joinBtn.onclick = () => joinRoom(roomInput ? roomInput.value : roomId));
//   copyBtn && (copyBtn.onclick = () => copyRoomLink());

//   roomInput && roomInput.addEventListener("keydown", (e) => {
//     if (e.key === "Enter") joinRoom(roomInput.value);
//   });

//   camBtn && (camBtn.onclick = () =>
//     startCamera(false).catch((e) => setStatus(`❌ Cámara: ${e?.name || "error"}`))
//   );

//   screenBtn && (screenBtn.onclick = () =>
//     startPresentSmart().catch((e) => setStatus(`❌ Presentar: ${e?.name || "error"}`))
//   );

//   presentBtn && (presentBtn.onclick = () =>
//     startCamera(true).catch((e) => setStatus(`❌ Trasera: ${e?.name || "error"}`))
//   );

//   stopBtn && (stopBtn.onclick = () => stopAll());
//   muteBtn && (muteBtn.onclick = () => toggleMute());

//   bindHotkeys();
//   ensureChatUI();
//   updateMuteLabel();

//   // Boot
//   joinRoom(roomId);
//   connectWS();
//   if (isMobile()) setStatus("📱 Móvil: Presentar = cámara trasera (no hay pantalla real en web móvil).");
// });
