const $ = (q) => document.querySelector(q);

const roomInput = $("#roomInput");
const joinBtn = $("#joinBtn");
const copyBtn = $("#copyBtn");
const camBtn = $("#camBtn");
const screenBtn = $("#screenBtn");
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

// STUN (para MVP). Si en ngrok y redes distintas sale ice: failed, es NAT (TURN).
const iceConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] }
  ]
};

// ===== WS =====
let ws = null;
function wsSend(data){
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function connectWS(){
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    setStatus(`✅ Conectado. ID: ${clientId.slice(0,8)}`);
    wsSend({ type:"join", roomId, clientId });
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "peers") {
      // el nuevo se conecta a existentes
      for (const pid of msg.peers) await ensurePeer(pid);
      // fuerza negociación inicial con existentes (solo el nuevo)
      for (const pid of msg.peers) await forceOffer(pid);
      return;
    }

    if (msg.type === "peer-joined") {
      // IMPORTANT: NO mandes offer aquí (evita choque)
      await ensurePeer(msg.clientId);
      return;
    }

    if (msg.type === "peer-left") {
      removePeer(msg.clientId);
      return;
    }

    if (msg.type === "signal") {
      await ensurePeer(msg.from);
      await onSignal(msg.from, msg.data);
      return;
    }
  };

  ws.onclose = () => setStatus("❌ WS desconectado.");
  ws.onerror = () => setStatus("⚠️ Error WS.");
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

async function startCamera(){
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { width:{ideal:1280}, height:{ideal:720} },
    audio: true
  });

  localStream = camStream;
  if (isMuted) localStream.getAudioTracks().forEach(t => t.enabled = false);

  await setLocalPreview(localStream);
  await replaceTracksAll();
  setStatus("🎥 Cámara/mic listos.");
}

async function startScreen() {
  // 1) Captura pantalla (intenta audio)
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: true
  });

  const screenVideoTrack = display.getVideoTracks()[0] || null;
  const systemAudioTrack = display.getAudioTracks()[0] || null;

  // 2) Captura micrófono (para fallback o mezcla)
  //    (si no quieres mic al compartir, puedes comentar esto)
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch (_) {
    micStream = null;
  }
  const micTrack = micStream ? micStream.getAudioTracks()[0] : null;

  // 3) Mezcla audio (system + mic) con AudioContext
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

  // 4) Construye el stream publicado
  const newStream = new MediaStream();
  if (screenVideoTrack) newStream.addTrack(screenVideoTrack);
  if (mixedAudioTrack) newStream.addTrack(mixedAudioTrack);

  // guardar para poder detener luego
  screenStream = display;

  localStream = newStream;
  if (isMuted) localStream.getAudioTracks().forEach(t => (t.enabled = false));

  await setLocalPreview(localStream);
  await replaceTracksAll();
  setStatus("🖥️ Compartiendo pantalla (audio mezclado si disponible).");

  // cuando dejas de compartir
  if (screenVideoTrack) {
    screenVideoTrack.onended = async () => {
      await stopScreen(true);
    };
  }
}


async function stopScreen(silent=false){
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  if (camStream) {
    localStream = camStream;
    if (isMuted) localStream.getAudioTracks().forEach(t => t.enabled = false);
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
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
  setStatus(isMuted ? "🔇 Mute ON" : "🔊 Mute OFF");
}

// ===== WebRTC (Perfect Negotiation) =====
const peers = new Map();
// peers.get(id) = { pc, polite, makingOffer, ignoreOffer, vSender, aSender, remoteStream, remoteEl, cardEl, stEl }

function isPoliteFor(peerId){
  // determinístico: uno es polite, el otro no
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

  // ✅ Para evitar negro por autoplay
  vid.muted = true;

  const actions = document.createElement("div");
  actions.className = "remoteActions";

  const listenBtn = document.createElement("button");
  listenBtn.className = "btn btn-ghost";
  listenBtn.textContent = "🔊 Escuchar";
  listenBtn.onclick = async () => {
    try {
      vid.muted = false;   // ✅ ahora sí habilita audio
      vid.volume = 1.0;
      await vid.play();    // ✅ gesto del usuario -> Chrome permite
      listenBtn.textContent = "🔇 Silenciar";
      listenBtn.onclick = async () => {
        vid.muted = true;
        listenBtn.textContent = "🔊 Escuchar";
        // re-asignar handler original
        listenBtn.onclick = async () => {
          try {
            vid.muted = false;
            vid.volume = 1.0;
            await vid.play();
            listenBtn.textContent = "🔇 Silenciar";
            listenBtn.onclick = () => {
              vid.muted = true;
              listenBtn.textContent = "🔊 Escuchar";
            };
          } catch {}
        };
      };
    } catch (e) {
      console.warn("No se pudo habilitar audio:", e);
      alert("Tu navegador bloqueó el audio. Dale click otra vez o revisa permisos/autoplay.");
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

  // transceivers para poder replaceTrack sin broncas
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

  // negociación automática (si algo cambia)
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

  // empuja tracks actuales (si ya existen)
  await replaceTracks(peerId);
}

// para que el nuevo dispare offer inicial a cada peer existente
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
    try { await st.pc.addIceCandidate(data.candidate); }
    catch {}
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

// ===== UI =====
joinBtn.onclick = () => joinRoom(roomInput.value);
copyBtn.onclick = () => copyRoomLink();

camBtn.onclick = async () => {
  try { await startCamera(); } catch(e) {
    console.error(e);
    setStatus("❌ No se pudo abrir cámara/mic (permisos).");
  }
};

screenBtn.onclick = async () => {
  try { await startScreen(); } catch(e) {
    console.error(e);
    setStatus("❌ No se pudo compartir pantalla (permisos).");
  }
};

stopBtn.onclick = async () => stopAll();
muteBtn.onclick = () => toggleMute();

// Boot
joinRoom(roomId);
