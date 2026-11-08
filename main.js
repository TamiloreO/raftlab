// Visualiser for the deterministic Raft core in src/raft.js.
// The simulation owns time; this file only draws it and turns clicks into
// cluster events.

import { RaftCluster, LEADER, CANDIDATE } from "./src/raft.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const cluster = new RaftCluster({ seed: 20261108 });
window.cluster = cluster;

const TICKS_PER_SECOND = 6;
const NODE_RADIUS = 30;

let running = true;
let speed = 2;
let accumulator = 0;
let lastFrame = performance.now();
let lastPanelUpdate = 0;
let proposals = 0;

const COLORS = {
  leader: "#57e2a5",
  candidate: "#f4b860",
  follower: "#8fa3b8",
  dead: "#2c3846",
  vote: "#f4b860",
  append: "#6fa8ff",
  reply: "#63758a",
  partition: "rgba(255, 122, 144, 0.18)",
};

// ---------------------------------------------------------------- geometry

function positions(width, height) {
  const cx = width / 2;
  const cy = height / 2 - 6;
  const radius = Math.min(width * 0.3, height * 0.37);
  const map = new Map();
  cluster.nodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / cluster.nodes.length) * Math.PI * 2;
    map.set(node.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });
  return map;
}

function termColour(term) {
  const hue = (term * 47 + 200) % 360;
  return `hsl(${hue} 62% 58%)`;
}

// ----------------------------------------------------------------- drawing

function drawEdges(width, height, pos) {
  const ids = cluster.nodes.map((node) => node.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = pos.get(ids[i]);
      const b = pos.get(ids[j]);
      const linked = cluster.connected(ids[i], ids[j]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.setLineDash(linked ? [] : [4, 6]);
      ctx.strokeStyle = linked ? "rgba(255,255,255,0.06)" : COLORS.partition;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawMessages(pos) {
  for (const packet of cluster.messages) {
    const from = pos.get(packet.from);
    const to = pos.get(packet.to);
    if (!from || !to) continue;

    const span = Math.max(1, packet.due - packet.start);
    const progress = (cluster.tick - packet.start) / span;
    if (progress < 0 || progress > 1) continue;

    const x = from.x + (to.x - from.x) * progress;
    const y = from.y + (to.y - from.y) * progress;

    const type = packet.message.type;
    const colour = type.startsWith("RequestVote")
      ? COLORS.vote
      : type.startsWith("AppendEntriesReply")
        ? COLORS.reply
        : COLORS.append;

    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawLog(pos, node) {
  const anchor = pos.get(node.id);
  const entries = node.log.slice(1).slice(-9);
  const cell = 9;
  const width = entries.length * cell;
  const startX = anchor.x - width / 2;
  const y = anchor.y + NODE_RADIUS + 14;

  entries.forEach((entry, index) => {
    const x = startX + index * cell;
    const committed = entry.index <= node.commitIndex;
    ctx.fillStyle = termColour(entry.term);
    ctx.globalAlpha = committed ? 1 : 0.42;
    ctx.fillRect(x, y, cell - 2, 12);
    ctx.globalAlpha = 1;

    if (committed) {
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 3, 11);
    }
  });

}

function drawNode(pos, node, highestLeaderTerm) {
  const anchor = pos.get(node.id);
  const isStale = node.state === LEADER && node.currentTerm < highestLeaderTerm;

  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y, NODE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = node.alive ? "#0f1620" : "#080b0f";
  ctx.fill();

  const ring = !node.alive
    ? COLORS.dead
    : node.state === LEADER
      ? isStale
        ? "#ff7a90"
        : COLORS.leader
      : node.state === CANDIDATE
        ? COLORS.candidate
        : "#39485a";

  ctx.lineWidth = node.state === LEADER && node.alive ? 2.5 : 1.5;
  ctx.strokeStyle = ring;
  ctx.setLineDash(node.alive ? [] : [3, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = node.alive ? "#e8eef6" : "#526175";
  ctx.font = "600 17px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(node.id, anchor.x, anchor.y - 4);

  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.fillStyle = node.alive ? "#8698ac" : "#43505f";
  ctx.fillText(`t${node.currentTerm}`, anchor.x, anchor.y + 12);

  if (node.state === LEADER && node.alive) {
    ctx.fillStyle = isStale ? "#ff7a90" : COLORS.leader;
    ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(isStale ? "STALE" : "LEADER", anchor.x, anchor.y - NODE_RADIUS - 10);
  } else if (node.state === CANDIDATE) {
    ctx.fillStyle = COLORS.candidate;
    ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("CANDIDATE", anchor.x, anchor.y - NODE_RADIUS - 10);
  }

  drawLog(pos, node);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pos = positions(width, height);
  const leaderTerms = cluster.nodes.filter((n) => n.state === LEADER && n.alive).map((n) => n.currentTerm);
  const highestLeaderTerm = leaderTerms.length ? Math.max(...leaderTerms) : 0;

  drawEdges(width, height, pos);
  drawMessages(pos);
  for (const node of cluster.nodes) drawNode(pos, node, highestLeaderTerm);
}

// ------------------------------------------------------------------ panels

function updatePanels() {
  const leaders = cluster.nodes.filter((n) => n.state === LEADER && n.alive);
  leaders.sort((a, b) => b.currentTerm - a.currentTerm);
  const leader = leaders[0] || null;

  document.getElementById("stat-term").textContent = String(
    Math.max(...cluster.nodes.map((n) => n.currentTerm), 0),
  );
  document.getElementById("stat-leader").textContent = leader ? leader.id : "none";
  document.getElementById("stat-commit").textContent = String(
    Math.max(...cluster.nodes.map((n) => n.commitIndex), 0),
  );
  document.getElementById("stat-flight").textContent = String(cluster.messages.length);
  document.getElementById("stat-dropped").textContent = String(cluster.dropped);
  document.getElementById("stat-tick").textContent = String(cluster.tick);

  const trace = document.getElementById("trace");
  const recent = cluster.trace.slice(-7).reverse();
  trace.innerHTML = recent
    .map((entry) => `<li><time>${entry.tick}</time>${escapeHtml(entry.text)}</li>`)
    .join("");
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

// -------------------------------------------------------------- simulation

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (running) {
    accumulator += dt * TICKS_PER_SECOND * speed;
    let steps = 0;
    while (accumulator >= 1 && steps < 60) {
      cluster.step();
      accumulator -= 1;
      steps += 1;
    }
  }

  draw();

  if (now - lastPanelUpdate > 120) {
    updatePanels();
    lastPanelUpdate = now;
  }

  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ input

document.getElementById("play").addEventListener("click", (event) => {
  running = !running;
  event.currentTarget.textContent = running ? "Pause" : "Resume";
});

document.getElementById("split").addEventListener("click", () => {
  const leader = cluster.leader();
  const pool = cluster.nodes.map((n) => n.id);
  const first = leader ? leader.id : pool[0];
  const second = pool.find((id) => id !== first) ?? pool[1];
  const minority = [first, second];
  const majority = pool.filter((id) => !minority.includes(id));
  cluster.setPartitions([minority, majority]);
});

document.getElementById("heal").addEventListener("click", () => cluster.heal());

document.getElementById("propose").addEventListener("click", () => {
  proposals += 1;
  cluster.propose(`set k${proposals} ${proposals}`);
});

document.getElementById("speed").addEventListener("change", (event) => {
  speed = Number(event.target.value);
});

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const pos = positions(canvas.clientWidth, canvas.clientHeight);

  for (const node of cluster.nodes) {
    const anchor = pos.get(node.id);
    const distance = Math.hypot(anchor.x - x, anchor.y - y);
    if (distance <= NODE_RADIUS + 4) {
      if (node.alive) cluster.kill(node.id);
      else cluster.revive(node.id);
      return;
    }
  }
});

requestAnimationFrame(frame);
