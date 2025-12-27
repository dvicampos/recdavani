const $ = (q) => document.querySelector(q);

// UI
const roomInput = $("#roomInput");
const joinBtn = $("#joinBtn");
const copyBtn = $("#copyBtn");
const camBtn = $("#camBtn");
const screenBtn = $("#screenBtn");
const presentBtn = $("#presentBtn"); // nuevo
const stopBtn = $("#stopBtn");
const muteBtn = $("#muteBtn");

const localVideo = $("#localVideo");
const remotes = $("#remotes");
const statusEl = $("#status");

function setStatus(t) { statusEl.textContent = t || ""; }
function randId(){ return Math.random().toString(16).slice(2) + Date.now().toString(16); }

const clientId = randId();
let roomId = new URL(location.href).searchParams.get("room") || "demo";
roomInput.value = roomId;

localVideo.muted = true;
localVideo.playsInline = true;

// Detect helpers (web-only)
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
function supportsScreenShare() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && window.isSecureContext;
}
function mobileShareMessage() {
  return isIOS()
    ? "En iPhone/iPad la web no permite compartir pantalla. Usa “Presentar” (cámara trasera) o entra desde laptop."
    : "En navegadores móviles la web normalmente no permite compartir pantalla con audio de sistema. Usa “Presentar” (cámara trasera) o entra desde laptop.";
}

// ICE servers (STUN). TURN opcional si algún día lo agregas.
const iceConfig = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
};

// Disable screen share in mobile web (UX)
if (!supportsScreenShare() || isMobile()) {
  screenBtn.disabled = true;
  screenBtn.title = mobileShareMessage();
}

// ===== WS =====
let ws = null;
function wsSend(data){
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function connectWS(){
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    setStatus(`✅ Conectado • ${clientId.slice(0,8)}`);
    wsSend({ type:"join", roomId, clientId });
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "peers") {
      for (const pid of msg.peers) await ensurePeer(pid);
      for (const pid of msg.peers) await forceOffer(pid);
      return;
    }

    if (msg.type === "peer-joined") {
      await ensurePeer(msg.clientId); // no offer aquí
      return;
    }

    if (msg.type === "peer-left") {
      removePeer(msg.clientId);
      return;
    }

    if (msg.type === "signal") {
      await ensurePeer(msg.from);
      await onSignal(msg.from, msg.data);
    }
  };

  ws.onclose = () => setStatus("❌ WS desconectado");
  ws.onerror = () => setStatus("⚠️ Error WS");
}

// ===== Media =====
let camStream = null;
let screenStream = null;
let localStream = null;
let isMuted = false;

async function setLocalPreview(stream){
  localVideo.srcObject = stream || null;
  if (stream) {
    localVideo.onloadedmetadata = async () => {
      try { await localVideo.play(); } catch {}
    };
  }
}

async function startCamera(opts = { preferBack:false }) {
  const constraints = {
    video: opts.preferBack
      ? { facingMode: { ideal: "environment" }, width:{ideal:1280}, height:{ideal:720} }
      : { width:{ideal:1280}, height:{ideal:720} },
    audio: true
  };

  camStream = await navigator.mediaDevices.getUserMedia(constraints);
  localStream = camStream;

  if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));
  await setLocalPreview(localStream);
  await replaceTracksAll();

  setStatus(opts.preferBack ? "📡 Presentando con cámara trasera." : "🎥 Cámara/mic listos.");
}

async function startScreen(){
  // Desktop only (mobile disabled)
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate:{ideal:30, max:60} },
    audio: true
  });

  const screenVideoTrack = display.getVideoTracks()[0] || null;
  const systemAudioTrack = display.getAudioTracks()[0] || null;

  // Mic fallback / mix
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
      video: false
    });
  } catch {
    micStream = null;
  }
  const micTrack = micStream ? micStream.getAudioTracks()[0] : null;

  // Mix system + mic
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

  if (!systemAudioTrack) {
    setStatus("🖥️ Pantalla sin audio de sistema. Enviando micrófono como audio.");
  } else {
    setStatus("🖥️ Compartiendo pantalla + audio (si el navegador lo permite).");
  }

  if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));
  await setLocalPreview(localStream);
  await replaceTracksAll();

  if (screenVideoTrack) {
    screenVideoTrack.onended = async () => stopScreen(true);
  }
}

async function stopScreen(silent=false){
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (camStream) {
    localStream = camStream;
    if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));
    await setLocalPreview(localStream);
    await replaceTracksAll();
    if (!silent) setStatus("↩️ Volviste a cámara.");
  } else {
    localStream = null;
    await setLocalPreview(null);
    await replaceTracksAll();
    if (!silent) setStatus("⛔ Sin stream.");
  }
}

async function stopAll(){
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  camStream = null; screenStream = null; localStream = null;

  await setLocalPreview(null);
  for (const pid of Array.from(peers.keys())) removePeer(pid);

  setStatus("🛑 Detenido.");
}

function toggleMute(){
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
  muteBtn.querySelector(".dock__i").textContent = isMuted ? "🔊" : "🔇";
  setStatus(isMuted ? "🔇 Mute ON" : "🔊 Mute OFF");
}

// ===== WebRTC (Perfect Negotiation) =====
const peers = new Map();
// peers.get(id) => { pc, polite, makingOffer, ignoreOffer, vSender, aSender, remoteStream, remoteEl, cardEl, stEl }

function isPoliteFor(peerId){
  return clientId.localeCompare(peerId) > 0;
}

function createRemoteCard(peerId){
  const card = document.createElement("div");
  card.className = "remoteCard";

  const head = document.createElement("div");
  head.className = "remoteHeader";

  const left = document.createElement("span");
  left.textContent = `Peer: ${peerId.slice(0, 8)}`;

  const right = document.createElement("span");
  right.textContent = "ice: new";

  head.appendChild(left);
  head.appendChild(right);

  const vid = document.createElement("video");
  vid.className = "remoteVideo";
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = true; // autoplay safe

  const actions = document.createElement("div");
  actions.className = "remoteActions";

  const listenBtn = document.createElement("button");
  listenBtn.className = "btn btn--ghost";
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
        // volver a asignar handler
        listenBtn.onclick = async () => {
          try {
            vid.muted = false; vid.volume = 1; await vid.play();
            listenBtn.textContent = "🔇 Silenciar";
            listenBtn.onclick = () => { vid.muted = true; listenBtn.textContent = "🔊 Escuchar"; };
          } catch {}
        };
      };
    } catch {
      alert("El navegador bloqueó el audio. Toca otra vez “Escuchar”.");
    }
  };

  actions.appendChild(listenBtn);

  card.appendChild(head);
  card.appendChild(vid);
  card.appendChild(actions);

  remotes.appendChild(card);

  return { cardEl: card, remoteEl: vid, stEl: right };
}

async function ensurePeer(peerId){
  if (!peerId || peerId === clientId) return;
  if (peers.has(peerId)) return;

  const pc = new RTCPeerConnection(iceConfig);
  const ui = createRemoteCard(peerId);

  const st = {
    pc,
    polite: isPoliteFor(peerId),
    makingOffer: false,
    ignoreOffer: false,
    vSender: null,
    aSender: null,
    remoteStream: new MediaStream(),
    ...ui
  };
  peers.set(peerId, st);

  // transceivers
  const vTrans = pc.addTransceiver("video", { direction:"sendrecv" });
  const aTrans = pc.addTransceiver("audio", { direction:"sendrecv" });
  st.vSender = vTrans.sender;
  st.aSender = aTrans.sender;

  pc.ontrack = (ev) => {
    st.remoteStream.addTrack(ev.track);
    st.remoteEl.srcObject = st.remoteStream;
    st.remoteEl.onloadedmetadata = async () => {
      try { await st.remoteEl.play(); } catch {}
    };
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) wsSend({ type:"signal", to: peerId, data:{ kind:"ice", candidate: ev.candidate } });
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
      wsSend({ type:"signal", to: peerId, data:{ kind:"desc", desc: pc.localDescription } });
    } catch (e) {
      console.warn("negotiationneeded error", e);
    } finally {
      st.makingOffer = false;
    }
  };

  await replaceTracks(peerId);
}

async function forceOffer(peerId){
  const st = peers.get(peerId);
  if (!st) return;

  try {
    st.makingOffer = true;
    const offer = await st.pc.createOffer();
    if (st.pc.signalingState !== "stable") return;
    await st.pc.setLocalDescription(offer);
    wsSend({ type:"signal", to: peerId, data:{ kind:"desc", desc: st.pc.localDescription } });
  } catch (e) {
    console.warn("forceOffer error", e);
  } finally {
    st.makingOffer = false;
  }
}

async function onSignal(peerId, data){
  const st = peers.get(peerId);
  if (!st) return;

  if (data.kind === "ice") {
    try { await st.pc.addIceCandidate(data.candidate); } catch {}
    return;
  }

  if (data.kind === "desc") {
    const desc = data.desc;

    const offerCollision =
      desc.type === "offer" && (st.makingOffer || st.pc.signalingState !== "stable");

    st.ignoreOffer = !st.polite && offerCollision;
    if (st.ignoreOffer) return;

    try {
      await st.pc.setRemoteDescription(desc);

      if (desc.type === "offer") {
        await replaceTracks(peerId);
        const answer = await st.pc.createAnswer();
        await st.pc.setLocalDescription(answer);
        wsSend({ type:"signal", to: peerId, data:{ kind:"desc", desc: st.pc.localDescription } });
      }
    } catch (e) {
      console.warn("setRemoteDescription error", e);
    }
  }
}

async function replaceTracks(peerId){
  const st = peers.get(peerId);
  if (!st) return;

  const v = localStream ? localStream.getVideoTracks()[0] : null;
  const a = localStream ? localStream.getAudioTracks()[0] : null;

  try {
    if (st.vSender) await st.vSender.replaceTrack(v || null);
    if (st.aSender) await st.aSender.replaceTrack(a || null);
  } catch (e) {
    console.warn("replaceTrack error", e);
  }
}

async function replaceTracksAll(){
  for (const pid of peers.keys()) await replaceTracks(pid);
}

function removePeer(peerId){
  const st = peers.get(peerId);
  if (!st) return;
  try { st.pc.close(); } catch {}
  st.cardEl.remove();
  peers.delete(peerId);
}

// ===== Room =====
function joinRoom(newRoom){
  roomId = (newRoom || "demo").trim() || "demo";

  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  history.replaceState(null, "", url.toString());

  for (const pid of Array.from(peers.keys())) removePeer(pid);

  if (ws) ws.close();
  connectWS();

  setStatus(`🚪 Entrando a room: ${roomId}`);
}

function copyRoomLink(){
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  navigator.clipboard.writeText(url.toString());
  setStatus("🔗 Link copiado.");
}

// ===== Events =====
joinBtn.onclick = () => joinRoom(roomInput.value);
copyBtn.onclick = () => copyRoomLink();

camBtn.onclick = async () => {
  try { await startCamera({ preferBack:false }); }
  catch (e) {
    console.error(e);
    setStatus("❌ No se pudo abrir cámara/mic (permisos).");
  }
};

screenBtn.onclick = async () => {
  if (screenBtn.disabled) {
    setStatus(mobileShareMessage());
    alert(mobileShareMessage());
    return;
  }
  try { await startScreen(); }
  catch (e) {
    console.error(e);
    setStatus("❌ No se pudo compartir pantalla.");
    alert("No se pudo compartir pantalla. En web móvil normalmente no está soportado. Prueba en laptop.");
  }
};

presentBtn.onclick = async () => {
  try {
    // “Presentar” = cámara trasera (móvil) / o simplemente back cam en desktop si existe
    await startCamera({ preferBack:true });
  } catch (e) {
    console.error(e);
    setStatus("❌ No se pudo abrir cámara trasera.");
  }
};

stopBtn.onclick = async () => stopAll();
muteBtn.onclick = () => toggleMute();

// Boot
joinRoom(roomId);

// UX: si es móvil, sugiere Presentar
if (isMobile()) {
  setStatus("📱 Móvil detectado: usa “Presentar” (cámara trasera). Pantalla real no está disponible en web móvil.");
}
