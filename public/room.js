// couch room: one vidlink player per browser, kept in step by a tiny relay.
// vidlink tells us what its player does (postMessage events) but takes no
// commands, so to move someone's player we reload it with ?startAt=<seconds>.

const VIDLINK = "https://vidlink.pro";
const DRIFT_LIMIT = 3; // seconds apart before the pill turns magenta
const CURTAIN_CAP = 6000; // ms before the curtain lifts on its own
const SETTLE_CAP = 12000; // ms before we stop waiting for a reload to land

const roomId = location.pathname.split("/")[2];
const $ = (id) => document.getElementById(id);

// Who this browser is. The id survives renames; the name is what toasts show.
if (!localStorage.couchId) localStorage.couchId = crypto.randomUUID();
const me = { id: localStorage.couchId, name: localStorage.couchName || "" };

let ws = null;
let seated = false;
let room = null; // last state from the server
let raters = []; // browser ids that have rated, from the server
let clockOffset = 0; // server clock minus our clock, in ms
let peers = [];

// What our own player last reported.
const player = { filmId: null, time: 0, timeAt: 0, duration: 0, playing: false };

// Reload bookkeeping.
let loading = false;
let loadTarget = 0;
let loadPlaying = false;
let capTimer = null;
let settleTimer = null;
let quietUntil = 0; // ignore player events until this time (echoes of our own reload)
let lagEstimate = 3; // seconds a playing reload takes, refined after every reload
let measuring = false; // waiting for the first playback after a reload to refine lagEstimate

let peerPos = null; // { name, time, playing, at } from the other browser
let pendingFilm = null; // film waiting for the "switch?" confirm
let sendTimer = null;
const backdrops = {}; // tmdb id -> backdrop path, from vidlink's MEDIA_DATA

// ---------- small helpers ----------

function clock(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function show(sectionId) {
  for (const id of ["gate", "empty", "stage", "after"]) $(id).hidden = id !== sectionId;
}

// Where the room says the film is right now.
function roomTime() {
  if (!room || !room.film) return 0;
  if (!room.playing) return room.time;
  return room.time + (Date.now() + clockOffset - room.at) / 1000;
}

// Where our own player is right now. vidlink reports about once a second, so
// we fill the gap, but never by more than 1.5 s: a stalled player must look stalled.
function myTime() {
  if (!player.playing) return player.time;
  return player.time + Math.min(1.5, (Date.now() - player.timeAt) / 1000);
}

function otherPeer() {
  return peers.find((p) => p.id !== me.id) || null;
}

// "Fight Club" from "/movies/550-fight-club".
function titleFromSlug(slug) {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ---------- connection ----------

function connect() {
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(scheme + location.host + "/r/" + roomId + "/ws");
  ws.addEventListener("open", () => {
    if (seated) send({ type: "hello", id: me.id, name: me.name });
  });
  ws.addEventListener("message", (event) => onServer(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    setTimeout(connect, 1500); // laptop slept or wifi blinked: come back quietly
  });
}

function onServer(msg) {
  if (msg.type === "state") {
    clockOffset = msg.now - Date.now();
    applyState(msg);
  } else if (msg.type === "peers") {
    peers = msg.peers;
    const other = otherPeer();
    if (other) localStorage.couchPeer = other.name;
    if (!seated) renderGate();
    updatePill();
  } else if (msg.type === "pos") {
    peerPos = { name: msg.name, time: msg.time, playing: msg.playing, at: Date.now() };
    updatePill();
  } else if (msg.type === "pull") {
    // The other person is ahead and asked us to jump to them.
    reload(msg.time + (msg.playing ? lagEstimate : 0), msg.playing);
    toast(msg.name + " pulled you to " + clock(msg.time));
  }
}

function applyState(msg) {
  room = msg.state;
  raters = msg.raters || [];

  if (!seated) {
    renderGate();
    return;
  }

  if (!room.film) {
    player.filmId = null;
    $("player").src = "about:blank";
    renderEmpty();
    show("empty");
    return;
  }

  if (room.ended) {
    $("player").src = "about:blank";
    player.filmId = null;
    renderAfter();
    show("after");
    return;
  }

  show("stage");
  $("pill-film").textContent = room.film.title;

  const fromMe = msg.byId === me.id;
  const filmChanged = player.filmId !== room.film.id;
  const moved = ["play", "pause", "seek"].includes(msg.action);

  if (filmChanged) {
    reload(roomTime() + (room.playing ? lagEstimate : 0), room.playing);
  } else if (moved && !fromMe) {
    reload(roomTime() + (room.playing ? lagEstimate : 0), room.playing);
  }

  if (!fromMe && msg.by) {
    if (msg.action === "play") toast(msg.by + " pressed play at " + clock(room.time));
    if (msg.action === "pause") toast(msg.by + " paused at " + clock(room.time));
    if (msg.action === "seek") toast(msg.by + " jumped to " + clock(room.time));
    if (msg.action === "load") toast(msg.by + " put on " + room.film.title);
  }
  wake();
}

// ---------- the player ----------

function reload(target, playing) {
  // Always pass startAt, and above 1 (vidlink ignores 0 and 1): without it the
  // player resumes wherever this browser last stopped, not where the room is.
  target = Math.max(2, Math.floor(target));
  loading = true;
  loadTarget = target;
  loadPlaying = playing;

  // JW mode: vidlink's default player restores its own saved time over
  // startAt, which would undo every remote seek. The JW player honours startAt.
  const params = new URLSearchParams({
    player: "jw",
    autoplay: String(playing),
    primaryColor: "3DF5FF",
    secondaryColor: "1B2A3A",
    iconColor: "E8F1F5",
    title: "false",
    poster: "true",
  });
  params.set("startAt", String(target));
  $("player").src = VIDLINK + "/movie/" + room.film.id + "?" + params;
  if (player.filmId !== room.film.id) player.duration = 0;
  player.filmId = room.film.id;
  player.time = target;
  player.timeAt = Date.now();
  player.playing = false;

  $("curtain-time").textContent = clock(target);
  const line = $("curtain-line");
  line.replaceWith(line.cloneNode(true)); // restart the 6 s progress line
  $("curtain").classList.remove("gone");
  clearTimeout(capTimer);
  clearTimeout(settleTimer);

  // The curtain gives up after 6 s, but we keep ignoring the player's own
  // events until it lands, or a slow load would be mistaken for someone seeking.
  capTimer = setTimeout(hideCurtain, CURTAIN_CAP);
  settleTimer = setTimeout(settle, SETTLE_CAP);
}

function hideCurtain() {
  $("curtain").classList.add("gone");
}

function settle() {
  if (!loading) return;
  loading = false;
  clearTimeout(capTimer);
  clearTimeout(settleTimer);
  quietUntil = Date.now() + 1500;
  hideCurtain();
}

window.addEventListener("message", (event) => {
  if (event.origin !== VIDLINK) return;
  let data = event.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }
  if (!data || !room || !room.film) return;

  if (data.type === "MEDIA_DATA") {
    const media = data.data && data.data[room.film.id];
    if (media && media.backdrop_path) backdrops[room.film.id] = media.backdrop_path;
    return;
  }
  if (data.type !== "PLAYER_EVENT") return;

  const event_ = data.data.event;
  player.time = data.data.currentTime || 0;
  player.timeAt = Date.now();
  if (data.data.duration) player.duration = data.data.duration;
  if (event_ === "play") player.playing = true;
  if (event_ === "pause" || event_ === "ended") player.playing = false;
  updateClock();

  if (loading) {
    // The reload has landed when vidlink finishes its own jump to startAt
    // (seeked), or reports a time near where we sent it.
    const near = Math.abs(player.time - loadTarget) < 3;
    const landed = event_ === "seeked" || (event_ === "timeupdate" && near);
    if (landed) {
      measuring = loadPlaying;
      settle();
    }
    return;
  }

  // First real playback after a playing reload: how far behind the room did
  // we land? Add that to the guess for next time.
  if (measuring && event_ === "timeupdate" && player.playing && player.time > loadTarget + 0.5) {
    measuring = false;
    const behind = roomTime() - player.time;
    lagEstimate = Math.min(10, Math.max(1, lagEstimate + behind));
  }

  if (event_ === "ended") {
    send({ type: "ended" });
    return;
  }
  if (Date.now() < quietUntil) return;
  // A play while the room already plays is the player starting after a
  // buffer, not a person. Same for a pause while the room is paused.
  if (event_ === "play" && room.playing) return;
  if (event_ === "pause" && !room.playing) return;
  if (event_ === "play" || event_ === "pause" || event_ === "seeked") {
    wake();
    // Seeking fires pause/seeked/play in a burst; send only where it settles.
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      send({ type: "set", playing: player.playing, time: myTime() });
    }, 400);
  }
});

// Tell the other browser where we are, for the drift badge.
setInterval(() => {
  if (!seated || !room || !room.film || room.ended || loading) return;
  send({ type: "pos", time: myTime(), playing: player.playing });
  updateClock();
}, 3000);

// ---------- pill ----------

let sleepTimer = null;

function wake() {
  const pill = $("pill");
  pill.classList.remove("asleep");
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    if (!$("dot").classList.contains("drift")) pill.classList.add("asleep");
  }, 3000);
}

// Seconds we are ahead of the other person (negative: behind). Null if unknown.
function driftSeconds() {
  if (!peerPos || loading || !otherPeer()) return null;
  if (Date.now() - peerPos.at > 10000) return null; // stale report
  const theirs = peerPos.time + (peerPos.playing ? (Date.now() - peerPos.at) / 1000 : 0);
  return myTime() - theirs;
}

function updatePill() {
  const dot = $("dot");
  const status = $("status");
  const other = otherPeer();
  const drift = driftSeconds();
  dot.className = "dot";
  $("resync").hidden = true;

  if (!other) {
    dot.classList.add("waiting");
    status.textContent = "Waiting for " + (localStorage.couchPeer || "the other seat");
  } else if (drift !== null && Math.abs(drift) > DRIFT_LIMIT) {
    dot.classList.add("drift");
    const gap = Math.round(Math.abs(drift)) + " s";
    status.textContent = drift > 0 ? other.name + " is " + gap + " behind" : "You're " + gap + " behind";
    $("resync").hidden = false;
    wake();
  } else {
    status.textContent = "In sync with " + other.name;
  }
}

function updateClock() {
  if (!player.duration) {
    $("clock").textContent = clock(myTime());
    return;
  }
  $("clock").innerHTML = "";
  $("clock").append(clock(myTime()) + " ");
  const of = document.createElement("span");
  of.className = "of";
  of.textContent = "/ " + clock(player.duration);
  $("clock").append(of);
}

$("resync").addEventListener("click", () => {
  const drift = driftSeconds();
  if (drift === null) return;
  if (drift < 0) {
    // We are behind: jump ourselves to them.
    const theirs = peerPos.time + (peerPos.playing ? (Date.now() - peerPos.at) / 1000 : 0);
    reload(theirs + (peerPos.playing ? lagEstimate : 0), peerPos.playing);
  } else {
    // They are behind: pull them to us.
    send({ type: "pull", time: myTime(), playing: player.playing });
    toast("Pulling " + otherPeer().name + " to " + clock(myTime()));
  }
  peerPos = null;
  updatePill();
});

$("strip").addEventListener("mousemove", wake);
$("pill").addEventListener("mouseenter", wake);

$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

// ---------- toasts ----------

let toastTimer = null;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("gone");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("gone"), 2600);
}

// ---------- gate ----------

function renderGate() {
  $("gate-film").textContent = room && room.film && !room.ended ? "Tonight: " + room.film.title : "";
  const other = otherPeer();
  $("gate-peer").textContent = other ? other.name + " is already here." : "";
}

$("name-field").hidden = !!me.name;
$("name").value = me.name;

function sitDown() {
  if (!me.name) {
    const typed = $("name").value.trim();
    if (!typed) {
      $("name").focus();
      return;
    }
    me.name = typed;
    localStorage.couchName = typed;
  }
  seated = true;
  send({ type: "hello", id: me.id, name: me.name });
}

$("sit").addEventListener("click", sitDown);
$("name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") sitDown();
});

// ---------- empty room and pasting ----------

function renderEmpty() {
  if (room && room.last) {
    const date = new Date(room.last.finished).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    $("last").textContent = "Last time: " + room.last.title + ", finished " + date + ".";
  } else {
    $("last").textContent = "";
  }
}

document.addEventListener("paste", (event) => {
  if (!seated) return;
  const text = event.clipboardData.getData("text");
  const match = text.match(/1shows\.[a-z]+\/movies\/(\d+)(?:-([a-z0-9-]+))?/i);
  if (!match) {
    toast("That isn't a 1shows film link");
    return;
  }
  const film = { id: match[1], title: match[2] ? titleFromSlug(match[2]) : "Film " + match[1] };
  if (room && room.film && !room.ended && room.film.id !== film.id) {
    // Mid-film: ask before replacing what is playing.
    pendingFilm = film;
    $("confirm-text").textContent = "Switch to " + film.title + "?";
    $("confirm").hidden = false;
    $("confirm-yes").focus();
    return;
  }
  send({ type: "load", id: film.id, title: film.title });
});

$("confirm-yes").addEventListener("click", () => {
  if (pendingFilm) send({ type: "load", id: pendingFilm.id, title: pendingFilm.title });
  pendingFilm = null;
  $("confirm").hidden = true;
});
$("confirm-no").addEventListener("click", () => {
  pendingFilm = null;
  $("confirm").hidden = true;
});
document.addEventListener("keydown", (event) => {
  if ($("confirm").hidden) return;
  if (event.key === "Escape") $("confirm-no").click();
});

// ---------- after the film ----------

let detailsFor = null;

function renderAfter() {
  const film = room.film;
  if (detailsFor !== film.id) {
    detailsFor = film.id;
    $("after-title").textContent = film.title;
    for (const id of ["facts", "tagline", "plot", "about", "credits"]) $(id).textContent = "";
    $("backdrop").style.backgroundImage = backdrops[film.id]
      ? "url(https://image.tmdb.org/t/p/w1280" + backdrops[film.id] + ")"
      : "";
    loadDetails(film.id);
  }
  renderVerdict();
}

async function loadDetails(id) {
  let info;
  try {
    info = await (await fetch("/api/film/" + id)).json();
  } catch {
    return;
  }
  if (detailsFor !== id) return;
  if (info.title) $("after-title").textContent = info.title;
  if (!backdrops[id] && info.poster) $("backdrop").style.backgroundImage = "url(" + info.poster + ")";

  const facts = $("facts");
  const bits = [];
  if (info.year) bits.push(String(info.year));
  if (info.runtime) bits.push(Math.floor(info.runtime / 3600) + " h " + Math.round((info.runtime % 3600) / 60) + " min");
  if (info.genres.length) bits.push(info.genres.join(", "));
  for (const bit of bits) {
    const span = document.createElement("span");
    span.textContent = bit;
    facts.append(span);
  }

  $("tagline").textContent = info.tagline || "";
  $("plot").textContent = info.plot || "";
  $("about").textContent = info.about || "";

  const credits = $("credits");
  const rows = [
    [info.directors.length > 1 ? "Directors" : "Director", info.directors],
    ["Written by", info.writers],
    ["Starring", info.stars],
  ];
  for (const [label, names] of rows) {
    if (!names.length) continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = names.join(", ");
    credits.append(dt, dd);
  }
}

function renderVerdict() {
  const stars = $("stars");
  const mine = Number(localStorage["couchRating:" + room.film.id]) || 0;
  const iRated = raters.includes(me.id);
  stars.innerHTML = "";
  for (let n = 1; n <= 5; n++) {
    const button = document.createElement("button");
    button.textContent = String(n);
    button.setAttribute("aria-label", n + " out of 5");
    if (iRated && n === mine) button.classList.add("picked");
    button.addEventListener("click", () => {
      localStorage["couchRating:" + room.film.id] = n;
      send({ type: "rate", stars: n });
    });
    stars.append(button);
  }

  const revealed = room.ratings.length >= 2 && room.ratings.every((r) => r.stars !== null);
  $("reveal").hidden = !revealed;
  stars.hidden = revealed;
  if (revealed) {
    $("reveal").innerHTML = "";
    for (const r of room.ratings) {
      const box = document.createElement("div");
      const score = document.createElement("strong");
      score.textContent = String(r.stars);
      const who = document.createElement("span");
      who.textContent = r.name;
      box.append(score, who);
      $("reveal").append(box);
    }
    $("verdict-note").textContent = "Out of 5. Now argue.";
  } else if (iRated) {
    const other = otherPeer();
    $("verdict-note").textContent = "You picked " + mine + ". Waiting for " + (other ? other.name : "the other seat") + ".";
  } else {
    $("verdict-note").textContent = "Both scores stay hidden until you have both picked one.";
  }
}

$("done").addEventListener("click", () => send({ type: "done" }));

// ---------- start ----------

connect();
