// Visualiser for the deterministic Raft core in src/raft.js.
//
// The drawing follows the industrial wayfinding language from style-labs:
// nodes are sign plates, states are sign families, partitions are zones, and
// messages are route arrows rather than dots.

import { RaftCluster, LEADER, CANDIDATE } from "./src/raft.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const cluster = new RaftCluster({ seed: 20261108 });
window.cluster = cluster;

const TICKS_PER_SECOND = 6;
const PLATE_W = 118;
const PLATE_H = 66;
const HEAD_H = 22;

const COLOURS = {
  paper: "#f2efe6",
  card: "#ffffff",
  ink: "#101010",
  yellow: "#f5c400",
  warn: "#c8452f",
  grey: "#6f6a5f",
  hair: "#d6d1c3",
  dead: "#b9b3a4",
};

let running = true;
let speed = 2;
let accumulator = 0;
let lastFrame = performance.now();
let lastPanelUpdate = 0;
let proposals = 0;

// ---------------------------------------------------------------- geometry

function positions(width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width * 0.32, height * 0.38);
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

function label(text, x, y, size, colour, weight = 800, align = "center") {
  ctx.font = `${weight} ${size}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

// ----------------------------------------------------------------- drawing

function drawGrid(width, height) {
  ctx.fillStyle = COLOURS.paper;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(16,16,16,0.05)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }
}

function drawZones(pos, width, height) {
  if (cluster.partitions.length < 2) return;

  cluster.partitions.forEach((group, index) => {
    const points = group.map((id) => pos.get(id)).filter(Boolean);
    if (points.length === 0) return;

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const pad = 56;
    const left = Math.max(10, Math.min(...xs) - pad);
    const right = Math.min(width - 10, Math.max(...xs) + pad);
    const top = Math.max(10, Math.min(...ys) - pad);
    const bottom = Math.min(height - 10, Math.max(...ys) + pad);

    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = "rgba(16,16,16,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.restore();

    ctx.fillStyle = COLOURS.ink;
    ctx.fillRect(left, top, 74, 19);
    label(`ZONE ${index + 1}`, left + 8, top + 10, 10, COLOURS.yellow, 800, "left");
  });
}

function drawEdges(pos) {
  const ids = cluster.nodes.map((node) => node.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = pos.get(ids[i]);
      const b = pos.get(ids[j]);
      const linked = cluster.connected(ids[i], ids[j]);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.setLineDash(linked ? [] : [5, 6]);
      ctx.strokeStyle = linked ? "rgba(16,16,16,0.22)" : "rgba(200,69,47,0.42)";
      ctx.lineWidth = linked ? 1 : 1.5;
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

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;

    // Start and end clear of the plates so arrows read as routes between signs.
    const startX = from.x + ux * (PLATE_W * 0.6);
    const startY = from.y + uy * (PLATE_H * 0.55);
    const x = startX + (to.x - ux * (PLATE_W * 0.6) - startX) * progress;
    const y = startY + (to.y - uy * (PLATE_H * 0.55) - startY) * progress;

    const type = packet.message.type;
    const colour = type.startsWith("RequestVote")
      ? "#b98a00"
      : type.startsWith("AppendEntriesReply")
        ? COLOURS.grey
        : COLOURS.ink;

    const tail = 13;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - ux * tail, y - uy * tail);
    ctx.lineTo(x, y);
    ctx.stroke();

    // Arrowhead
    const head = 6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - ux * head - uy * head * 0.7, y - uy * head + ux * head * 0.7);
    ctx.lineTo(x - ux * head + uy * head * 0.7, y - uy * head - ux * head * 0.7);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
  }
}

function plateStyle(node, isStale) {
  if (!node.alive) {
    return { body: COLOURS.paper, header: COLOURS.dead, text: COLOURS.ink, headerText: COLOURS.ink, state: "OFFLINE", stateColour: COLOURS.grey };
  }

  if (isStale) {
    return { body: COLOURS.ink, header: COLOURS.warn, text: "#ffffff", headerText: "#ffffff", state: "STALE LEADER", stateColour: COLOURS.warn };
  }

  if (node.state === LEADER) {
    return { body: COLOURS.ink, header: COLOURS.yellow, text: "#ffffff", headerText: COLOURS.ink, state: "LEADER", stateColour: COLOURS.ink };
  }

  if (node.state === CANDIDATE) {
    return { body: COLOURS.yellow, header: COLOURS.ink, text: COLOURS.ink, headerText: "#ffffff", state: "CANDIDATE", stateColour: COLOURS.ink };
  }

  return { body: COLOURS.card, header: COLOURS.ink, text: COLOURS.ink, headerText: "#ffffff", state: "FOLLOWER", stateColour: COLOURS.grey };
}

function drawNode(pos, node, isStale) {
  const anchor = pos.get(node.id);
  const style = plateStyle(node, isStale);

  const left = anchor.x - PLATE_W / 2;
  const top = anchor.y - PLATE_H / 2;

  // Body
  ctx.fillStyle = style.body;
  ctx.fillRect(left, top, PLATE_W, PLATE_H);

  // Header strip
  ctx.fillStyle = style.header;
  ctx.fillRect(left, top, PLATE_W, HEAD_H);

  // Border
  ctx.strokeStyle = COLOURS.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(left + 1, top + 1, PLATE_W - 2, PLATE_H - 2);

  // Id in the header, term and commit in the body
  label(node.id, left + 12, top + HEAD_H / 2 + 1, 15, style.headerText, 800, "left");
  label(style.state, left + PLATE_W - 10, top + HEAD_H / 2 + 1, 8, style.headerText, 800, "right");

  const termText = `TERM ${node.currentTerm}`;
  const commitText = `COMMIT ${node.commitIndex}`;
  label(termText, left + 12, top + HEAD_H + 15, 10, style.text, 700, "left");
  label(commitText, left + 12, top + HEAD_H + 32, 10, style.text, 700, "left");

  if (!node.alive) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top + HEAD_H, PLATE_W, PLATE_H - HEAD_H);
    ctx.clip();
    ctx.strokeStyle = "rgba(16,16,16,0.25)";
    ctx.lineWidth = 2;
    for (let i = -PLATE_H; i < PLATE_W; i += 12) {
      ctx.beginPath();
      ctx.moveTo(left + i, top + PLATE_H);
      ctx.lineTo(left + i + PLATE_H, top + HEAD_H);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLog(anchor, node);
}

function drawLog(anchor, node) {
  const entries = node.log.slice(1).slice(-10);
  if (entries.length === 0) return;

  const cell = 9;
  const width = entries.length * cell;
  const startX = anchor.x - width / 2;
  const y = anchor.y + PLATE_H / 2 + 6;

  entries.forEach((entry, index) => {
    const x = startX + index * cell;
    const committed = entry.index <= node.commitIndex;

    ctx.fillStyle = committed ? COLOURS.ink : COLOURS.card;
    ctx.fillRect(x, y, cell - 2, 12);

    ctx.strokeStyle = COLOURS.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cell - 3, 11);
  });
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
  drawGrid(width, height);

  const pos = positions(width, height);
  const leaderTerms = cluster.nodes.filter((n) => n.state === LEADER && n.alive).map((n) => n.currentTerm);
  const highestLeaderTerm = leaderTerms.length ? Math.max(...leaderTerms) : 0;

  drawZones(pos, width, height);
  drawEdges(pos);
  drawMessages(pos);

  for (const node of cluster.nodes) {
    const isStale = node.state === LEADER && node.currentTerm < highestLeaderTerm;
    drawNode(pos, node, isStale);
  }
}

// ------------------------------------------------------------------ panels

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}

function updatePanels() {
  const leaders = cluster.nodes
    .filter((n) => n.state === LEADER && n.alive)
    .sort((a, b) => b.currentTerm - a.currentTerm);
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
  document.getElementById("stat-tick-head").textContent = String(cluster.tick);

  const trace = document.getElementById("trace");
  const recent = cluster.trace.slice(-7).reverse();
  trace.innerHTML = recent
    .map((entry) => `<li><time>${entry.tick}</time>${escapeHtml(entry.text)}</li>`)
    .join("");
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
    const inside =
      Math.abs(anchor.x - x) <= PLATE_W / 2 + 4 && Math.abs(anchor.y - y) <= PLATE_H / 2 + 4;
    if (inside) {
      if (node.alive) cluster.kill(node.id);
      else cluster.revive(node.id);
      return;
    }
  }
});

requestAnimationFrame(frame);
