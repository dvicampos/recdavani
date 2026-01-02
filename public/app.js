document.addEventListener("DOMContentLoaded", () => {
  const $ = (q) => document.querySelector(q);

  // ===== UI refs =====
  const roomInput = $("#roomInput");
  const joinBtn = $("#joinBtn");
  const copyBtn = $("#copyBtn");

  const camBtn = $("#camBtn");
  const screenBtn = $("#screenBtn");   // Pantalla (desktop)
  const presentBtn = $("#presentBtn"); // Presentar (móvil: cámara trasera)
  const stopBtn = $("#stopBtn");
  const muteBtn = $("#muteBtn");

  const localVideo = $("#localVideo");
  const remotes = $("#remotes");
  const statusEl = $("#status");

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
      font: 600 13px ui-sans-serif, system-ui; box-shadow: 0 10px 30px rgba(0,0,0,.35);
      max-width: min(92vw, 520px); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function randId() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
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

    // Doble click = fullscreen
    localVideo.addEventListener("dblclick", async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await localVideo.requestFullscreen();
      } catch {}
    });
  }

  // Un poquito mejor ICE (sigue siendo “simple”)
  const iceConfig = {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
    ]
  };

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
    pingTimer = setInterval(() => {
      wsSend({ type: "ping", t: Date.now() });
    }, 20000);
  }
  function stopClientHeartbeat() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
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
        // msg.peers: [{id,name}]
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

  function scheduleReconnect() {
    reconnectTry++;
    const wait = Math.min(15000, 400 * Math.pow(2, reconnectTry));
    toast(`🔁 Reintentando conexión… (${Math.round(wait / 1000)}s)`, 1400);
    setTimeout(() => {
      if (!wsWanted) return;
      connectWS();
    }, wait);
  }

  // ===== Media =====
  let camStream = null;
  let screenStream = null;
  let localStream = null;
  let isMuted = false;

  async function setLocalPreview(stream) {
    if (!localVideo) return;
    localVideo.srcObject = stream || null;
    if (stream) {
      localVideo.onloadedmetadata = async () => {
        try { await localVideo.play(); } catch {}
      };
    }
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
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
        console.warn("getUserMedia fail:", e.name, e.message);
      }
    }

    if (!stream) {
      setStatus(`❌ No se pudo abrir cámara/mic: ${lastErr?.name || "error"}`);
      throw lastErr || new Error("camera failed");
    }

    camStream = stream;
    localStream = camStream;

    if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));

    await setLocalPreview(localStream);
    await replaceTracksAll();

    setStatus(preferBack ? "📱 Presentando (cámara trasera + mic)." : "🎥 Cámara + mic listos.");
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

    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch { micStream = null; }
    const micTrack = micStream ? micStream.getAudioTracks()[0] : null;

    let mixedAudioTrack = null;
    if (systemAudioTrack || micTrack) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
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

    const newStream = new MediaStream();
    if (screenVideoTrack) newStream.addTrack(screenVideoTrack);
    if (mixedAudioTrack) newStream.addTrack(mixedAudioTrack);

    screenStream = display;
    localStream = newStream;

    if (!systemAudioTrack) setStatus("🖥️ Pantalla sin audio de sistema (fallback a mic).");
    else setStatus("🖥️ Pantalla + audio (si el navegador lo permite).");

    if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));

    await setLocalPreview(localStream);
    await replaceTracksAll();

    if (screenVideoTrack) screenVideoTrack.onended = () => stopPresent();
  }

  async function stopPresent() {
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }
    if (camStream) {
      localStream = camStream;
      if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));
      await setLocalPreview(localStream);
      await replaceTracksAll();
      setStatus("↩️ Volviste a cámara.");
    } else {
      localStream = null;
      await setLocalPreview(null);
      await replaceTracksAll();
      setStatus("⛔ Sin stream.");
    }
  }

  async function stopAll() {
    if (!confirm("¿Detener cámara/pantalla y desconectar peers?")) return;

    if (camStream) camStream.getTracks().forEach(t => t.stop());
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    camStream = null; screenStream = null; localStream = null;

    await setLocalPreview(null);
    for (const pid of Array.from(peers.keys())) removePeer(pid);

    setStatus("🛑 Detenido.");
  }

  function toggleMute() {
    isMuted = !isMuted;
    if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
    setStatus(isMuted ? "🔇 Mute ON" : "🔊 Mute OFF");
    muteBtn && (muteBtn.querySelector(".dock__t") ? (muteBtn.querySelector(".dock__t").textContent = isMuted ? "Unmute" : "Mute") : null);
  }

  // ===== Present logic (smart) =====
  async function startPresentSmart() {
    if (!window.isSecureContext && location.hostname !== "localhost") {
      setStatus("❌ Necesitas HTTPS para cámara/pantalla en móvil.");
      alert("Abre el link con https (candadito). En móvil sin HTTPS no habrá permisos.");
      return;
    }

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

  // Room badge (sin tocar HTML: lo ponemos en el status)
  function setRoomBadgeCount(n) {
    // Solo un “detalle cute”: muestra participantes en status cuando está idle
    // (no pisa mensajes importantes)
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
    // Asegura posicionamiento
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

  // ===== Chat (inyectado, sin cambiar HTML) =====
  let chatUI = null;

  function ensureChatUI() {
    if (chatUI) return chatUI;

    const wrap = document.createElement("div");
    wrap.style.cssText = `
      position: fixed; right: 16px; bottom: 16px; z-index: 9998;
      width: min(360px, calc(100vw - 32px));
      font: 600 13px ui-sans-serif, system-ui;
    `;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "💬 Chat";
    btn.style.cssText = `
      width: 100%; padding: 10px 12px; border-radius: 14px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.08);
      color: rgba(255,255,255,.92);
      cursor: pointer;
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 16px 45px rgba(0,0,0,.45);
    `;

    const panel = document.createElement("div");
    panel.style.cssText = `
      margin-top: 10px; border-radius: 18px; overflow: hidden;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(0,0,0,.20);
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 18px 60px rgba(0,0,0,.45);
      display: none;
    `;

    const head = document.createElement("div");
    head.style.cssText = `
      padding: 10px 12px; display:flex; align-items:center; justify-content:space-between;
      border-bottom: 1px solid rgba(255,255,255,.08);
      color: rgba(255,255,255,.86);
    `;
    head.innerHTML = `<span>Chat de sala</span>`;

    const tools = document.createElement("div");
    tools.style.cssText = `display:flex; gap:8px; align-items:center;`;
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "✏️";
    rename.title = "Cambiar nombre";
    rename.style.cssText = miniIconBtnCss();
    rename.onclick = () => {
      const n = prompt("Tu nombre (máx 24):", nick);
      if (!n) return;
      setNick(n);
      nick = getNick();
      wsSend({ type: "rename", name: nick });
      toast(`🪪 Ahora eres ${nick}`);
    };

    const react = document.createElement("button");
    react.type = "button";
    react.textContent = "✨";
    react.title = "Reacción";
    react.style.cssText = miniIconBtnCss();
    react.onclick = () => {
      wsSend({ type: "reaction", emoji: "✨" });
      showReaction(clientId, "✨");
    };

    tools.appendChild(rename);
    tools.appendChild(react);
    head.appendChild(tools);

    const log = document.createElement("div");
    log.style.cssText = `
      max-height: 260px; overflow:auto; padding: 10px 12px;
      display:flex; flex-direction:column; gap: 8px;
    `;

    const form = document.createElement("form");
    form.style.cssText = `
      display:flex; gap: 10px; padding: 10px 12px;
      border-top: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.04);
    `;
    const input = document.createElement("input");
    input.placeholder = "Escribe algo… (Enter)";
    input.maxLength = 240;
    input.style.cssText = `
      flex:1; border: 1px solid rgba(255,255,255,.14);
      background: rgba(0,0,0,.18); color: rgba(255,255,255,.92);
      border-radius: 14px; padding: 10px 12px; outline:none;
    `;
    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Enviar";
    send.style.cssText = `
      padding: 10px 12px; border-radius: 14px; cursor:pointer;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.08);
      color: rgba(255,255,255,.92);
    `;

    form.appendChild(input);
    form.appendChild(send);

    panel.appendChild(head);
    panel.appendChild(log);
    panel.appendChild(form);

    btn.onclick = () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
      if (panel.style.display === "block") input.focus();
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      const text = String(input.value || "").trim();
      if (!text) return;
      input.value = "";
      wsSend({ type: "chat", text });
      addChatLine({ mine: true, name: nick, text, ts: Date.now() });
    };

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);

    chatUI = { wrap, btn, panel, log, input };
    return chatUI;
  }

  function miniIconBtnCss() {
    return `
      width: 34px; height: 34px; border-radius: 12px; cursor:pointer;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.08);
      color: rgba(255,255,255,.92);
    `;
  }

  function addChatLine({ mine, name, text, ts }) {
    const ui = ensureChatUI();
    const row = document.createElement("div");
    const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    row.style.cssText = `
      align-self: ${mine ? "flex-end" : "flex-start"};
      max-width: 85%;
      padding: 8px 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.12);
      background: ${mine ? "rgba(124,92,255,.20)" : "rgba(0,0,0,.22)"};
      color: rgba(255,255,255,.92);
      box-shadow: 0 10px 25px rgba(0,0,0,.25);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    `;
    row.innerHTML = `<div style="font-size:11px;color:rgba(255,255,255,.65);margin-bottom:4px;">
        ${escapeHtml(name)} • ${time}
      </div>
      <div style="font-size:13px;font-weight:650">${escapeHtml(text)}</div>`;
    ui.log.appendChild(row);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
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

    // doble click fullscreen
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

    // mini reacción rápida
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

  async function ensurePeer(peerId, name = null) {
    if (!peerId || peerId === clientId) return;
    if (peers.has(peerId)) {
      const st = peers.get(peerId);
      if (name && st && !st.name) {
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

    // Stats loop (bitrate + rtt) para “wow”
    startStatsLoop(peerId);
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
    st._statsTimer && clearInterval(st._statsTimer);
    st.cardEl?.remove();
    peers.delete(peerId);
  }

  function startStatsLoop(peerId) {
    const st = peers.get(peerId);
    if (!st || st._statsTimer) return;

    st._statsTimer = setInterval(async () => {
      try {
        const stats = await st.pc.getStats();
        let rtt = null;
        let bytes = null;
        let ts = null;

        stats.forEach((r) => {
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) {
            rtt = Math.round(r.currentRoundTripTime * 1000);
          }
          if (r.type === "outbound-rtp" && r.kind === "video") {
            bytes = r.bytesSent;
            ts = r.timestamp;
          }
        });

        let bitrate = null;
        if (bytes != null && ts != null) {
          if (st.lastTs) {
            const dt = (ts - st.lastTs) / 1000;
            const db = bytes - st.lastBytes;
            if (dt > 0 && db >= 0) bitrate = Math.round((db * 8) / dt / 1000); // kbps
          }
          st.lastBytes = bytes;
          st.lastTs = ts;
        }

        const ice = st.pc.iceConnectionState;
        const parts = [`ice:${ice}`];
        if (bitrate != null) parts.push(`${bitrate}kbps`);
        if (rtt != null) parts.push(`${rtt}ms`);
        st.stEl.textContent = parts.join(" • ");
      } catch {}
    }, 1800);
  }

  // ===== Room =====
  function joinRoom(newRoom) {
    roomId = (newRoom || "demo").trim() || "demo";

    const url = new URL(location.href);
    url.searchParams.set("room", roomId);
    history.replaceState(null, "", url.toString());

    for (const pid of Array.from(peers.keys())) removePeer(pid);

    wsWanted = true;
    if (ws) ws.close();
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
      // fallback
      prompt("Copia el link:", text);
    }
  }

  // ===== Keyboard shortcuts (wow) =====
  function bindHotkeys() {
    window.addEventListener("keydown", (e) => {
      if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;

      if (e.key === "m" || e.key === "M") toggleMute();
      if (e.key === "c" || e.key === "C") startCamera(false).catch(() => {});
      if (e.key === "p" || e.key === "P") startPresentSmart().catch(() => {});
      if (e.key === "Escape") stopAll().catch(() => {});
    });
  }

  // ===== Events =====
  joinBtn && (joinBtn.onclick = () => joinRoom(roomInput ? roomInput.value : roomId));
  copyBtn && (copyBtn.onclick = () => copyRoomLink());

  roomInput && roomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom(roomInput.value);
  });

  camBtn && (camBtn.onclick = () =>
    startCamera(false).catch((e) => setStatus(`❌ Cámara: ${e?.name || "error"}`))
  );

  // Desktop: Pantalla
  screenBtn && (screenBtn.onclick = () =>
    startPresentSmart().catch((e) => setStatus(`❌ Presentar: ${e?.name || "error"}`))
  );

  // Móvil: Presentar (trasera)
  presentBtn && (presentBtn.onclick = () =>
    startCamera(true).catch((e) => setStatus(`❌ Trasera: ${e?.name || "error"}`))
  );

  stopBtn && (stopBtn.onclick = () => stopAll());
  muteBtn && (muteBtn.onclick = () => toggleMute());

  bindHotkeys();
  ensureChatUI(); // aparece botón “Chat”

  // Boot
  joinRoom(roomId);
  if (isMobile()) setStatus("📱 Móvil: Presentar = cámara trasera (no hay pantalla real en web móvil).");
});
