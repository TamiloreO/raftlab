// A deterministic Raft simulation.
//
// No timers, no threads, no network. Everything advances through tick(), which
// makes a run reproducible from a seed and lets tests assert on exact states.
// The browser visualiser drives the same code.

export const FOLLOWER = "follower";
export const CANDIDATE = "candidate";
export const LEADER = "leader";

/** Small seeded PRNG, so a run can be replayed exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = {
  vote: "RequestVote",
  voteReply: "RequestVoteReply",
  append: "AppendEntries",
  appendReply: "AppendEntriesReply",
};

class Node {
  constructor(id, options) {
    this.id = id;
    this.options = options;
    this.state = FOLLOWER;
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = []; // index 0 is a sentinel with term 0
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.leaderId = null;
    this.votes = new Set();
    this.nextIndex = new Map();
    this.matchIndex = new Map();
    this.electionDeadline = 0;
    this.heartbeatAt = 0;
    this.alive = true;
  }

  get lastIndex() {
    return this.log.length - 1;
  }

  get lastTerm() {
    return this.log[this.log.length - 1].term;
  }

  lastIndexAt(index) {
    return index <= 0 ? 0 : (this.log[index] ? this.log[index].term : -1);
  }
}

export class RaftCluster {
  /**
   * @param {object} options
   * @param {number} [options.size] number of nodes
   * @param {number} [options.seed]
   * @param {number} [options.electionTimeout] base ticks before an election
   * @param {number} [options.electionJitter] extra random ticks
   * @param {number} [options.heartbeat] ticks between heartbeats
   * @param {number} [options.latency] message delay in ticks
   * @param {number} [options.jitter] extra random delay
   */
  constructor(options = {}) {
    this.options = {
      size: 5,
      seed: 7,
      electionTimeout: 14,
      electionJitter: 20,
      heartbeat: 3,
      latency: 2,
      jitter: 2,
      ...options,
    };

    this.random = mulberry32(this.options.seed);
    this.tick = 0;
    this.nodes = [];
    this.messages = [];
    this.partitions = []; // array of arrays of node ids
    this.trace = [];
    this.delivered = 0;
    this.dropped = 0;

    for (let i = 0; i < this.options.size; i += 1) {
      const node = new Node(String.fromCharCode(65 + i), this.options);
      node.log = [{ index: 0, term: 0, command: null }];
      this.nodes.push(node);
    }

    this.nodes.forEach((node) => this.resetElectionTimer(node));
  }

  // ---------------------------------------------------------------- plumbing

  resetElectionTimer(node) {
    const { electionTimeout, electionJitter } = this.options;
    node.electionDeadline = this.tick + electionTimeout + Math.floor(this.random() * electionJitter);
  }

  /** Can these two nodes reach each other right now? */
  connected(fromId, toId) {
    if (this.partitions.length === 0) return true;
    for (const group of this.partitions) {
      const hasFrom = group.includes(fromId);
      const hasTo = group.includes(toId);
      if (hasFrom && hasTo) return true;
      if (hasFrom !== hasTo) return false;
    }
    return false;
  }

  send(from, to, message) {
    const delay = this.options.latency + Math.floor(this.random() * (this.options.jitter + 1));
    this.messages.push({ from: from.id, to: to.id, message, start: this.tick, due: this.tick + delay });
  }

  broadcast(node, message) {
    for (const peer of this.nodes) {
      if (peer.id !== node.id) this.send(node, peer, message);
    }
  }

  node(id) {
    return this.nodes.find((n) => n.id === id);
  }

  leader() {
    return this.nodes.find((n) => n.state === LEADER) || null;
  }

  /** Split the cluster into groups. `[["A","B"],["C","D","E"]]` or `[]` to heal. */
  setPartitions(groups) {
    this.partitions = groups.map((group) => [...group]);
  }

  heal() {
    this.partitions = [];
  }

  kill(id) {
    const node = this.node(id);
    if (node) {
      node.alive = false;
      node.state = FOLLOWER;
    }
  }

  revive(id) {
    const node = this.node(id);
    if (node) {
      node.alive = true;
      this.resetElectionTimer(node);
    }
  }

  // ------------------------------------------------------------- transitions

  becomeFollower(node, term, leaderId = null) {
    if (term > node.currentTerm) {
      node.currentTerm = term;
      node.votedFor = null;
    }
    if (node.state !== FOLLOWER) this.log(`${node.id} steps down at term ${node.currentTerm}`);
    node.state = FOLLOWER;
    node.leaderId = leaderId;
    node.votes.clear();
    this.resetElectionTimer(node);
  }

  becomeCandidate(node) {
    node.state = CANDIDATE;
    node.currentTerm += 1;
    node.votedFor = node.id;
    node.votes = new Set([node.id]);
    node.leaderId = null;
    this.resetElectionTimer(node);
    this.log(`${node.id} becomes candidate for term ${node.currentTerm}`);

    const lastIndex = node.lastIndex;
    const lastTerm = node.lastTerm;
    this.broadcast(node, {
      type: TYPES.vote,
      term: node.currentTerm,
      candidateId: node.id,
      lastLogIndex: lastIndex,
      lastLogTerm: lastTerm,
    });

    if (node.votes.size >= this.majority()) this.becomeLeader(node);
  }

  becomeLeader(node) {
    node.state = LEADER;
    node.leaderId = node.id;
    this.log(`${node.id} is leader for term ${node.currentTerm}`);
    for (const peer of this.nodes) {
      node.nextIndex.set(peer.id, node.lastIndex + 1);
      node.matchIndex.set(peer.id, 0);
    }
    node.matchIndex.set(node.id, node.lastIndex);
    node.heartbeatAt = this.tick;
    this.replicate(node);
  }

  /** Quorum is a majority of the cluster, not of the nodes currently alive. */
  majority() {
    return Math.floor(this.options.size / 2) + 1;
  }

  log(text) {
    this.trace.push({ tick: this.tick, text });
  }

  // ------------------------------------------------------------- replication

  replicate(node) {
    for (const peer of this.nodes) {
      if (peer.id === node.id || !peer.alive) continue;
      const next = node.nextIndex.get(peer.id) ?? node.lastIndex + 1;
      const prevIndex = next - 1;
      const prevTerm = node.lastIndexAt(prevIndex);
      const entries = node.log.slice(next);

      this.send(node, peer, {
        type: TYPES.append,
        term: node.currentTerm,
        leaderId: node.id,
        prevLogIndex: prevIndex,
        prevLogTerm: prevTerm,
        entries: entries.map((entry) => ({ ...entry })),
        leaderCommit: node.commitIndex,
      });
    }
  }

  advanceCommit(leader) {
    const indexes = this.nodes
      .map((n) => (n.id === leader.id ? leader.lastIndex : (leader.matchIndex.get(n.id) ?? 0)))
      .sort((a, b) => b - a);

    const majorityIndex = indexes[this.majority() - 1];
    if (
      majorityIndex > leader.commitIndex &&
      leader.lastIndexAt(majorityIndex) === leader.currentTerm
    ) {
      leader.commitIndex = majorityIndex;
      this.log(`${leader.id} commits up to ${majorityIndex}`);
    }
  }

  /** Append a command to the current leader. Returns the index or null. */
  propose(command) {
    const leader = this.leader();
    if (!leader || !leader.alive) return null;
    const entry = { index: leader.lastIndex + 1, term: leader.currentTerm, command };
    leader.log.push(entry);
    leader.matchIndex.set(leader.id, leader.lastIndex);
    this.log(`${leader.id} appends "${command}" at index ${entry.index}`);
    this.replicate(leader);
    // A single node cluster is its own quorum, so nothing will ever reply.
    this.advanceCommit(leader);
    return entry.index;
  }

  // ---------------------------------------------------------------- handlers

  handleVoteRequest(node, message) {
    if (message.term < node.currentTerm) {
      return { type: TYPES.voteReply, term: node.currentTerm, granted: false };
    }
    if (message.term > node.currentTerm) this.becomeFollower(node, message.term);

    const logOk =
      message.lastLogTerm > node.lastTerm ||
      (message.lastLogTerm === node.lastTerm && message.lastLogIndex >= node.lastIndex);

    const canVote = node.votedFor === null || node.votedFor === message.candidateId;
    const granted = canVote && logOk;

    if (granted) {
      node.votedFor = message.candidateId;
      this.resetElectionTimer(node);
    }

    return { type: TYPES.voteReply, term: node.currentTerm, granted };
  }

  handleVoteReply(node, message) {
    if (node.state !== CANDIDATE || message.term !== node.currentTerm) return;
    if (!message.granted) return;
    node.votes.add(message.from);
    if (node.votes.size >= this.majority()) this.becomeLeader(node);
  }

  handleAppend(node, message) {
    if (message.term < node.currentTerm) {
      return { type: TYPES.appendReply, term: node.currentTerm, success: false, matchIndex: 0 };
    }

    if (message.term > node.currentTerm || node.state !== FOLLOWER) {
      this.becomeFollower(node, message.term, message.leaderId);
    }
    node.leaderId = message.leaderId;
    this.resetElectionTimer(node);

    // Consistency check on the previous entry.
    if (message.prevLogIndex > 0) {
      const termAt = node.lastIndexAt(message.prevLogIndex);
      if (termAt !== message.prevLogTerm) {
        return { type: TYPES.appendReply, term: node.currentTerm, success: false, matchIndex: 0 };
      }
    }

    let inserted = 0;
    for (const entry of message.entries) {
      if (entry.index <= node.lastIndex) {
        if (node.log[entry.index].term !== entry.term) {
          node.log = node.log.slice(0, entry.index);
          node.log.push({ ...entry });
          inserted += 1;
        }
      } else {
        node.log.push({ ...entry });
        inserted += 1;
      }
    }

    if (message.leaderCommit > node.commitIndex) {
      node.commitIndex = Math.min(message.leaderCommit, node.lastIndex);
    }

    return {
      type: TYPES.appendReply,
      term: node.currentTerm,
      success: true,
      matchIndex: message.prevLogIndex + message.entries.length,
      inserted,
    };
  }

  handleAppendReply(node, message) {
    if (node.state !== LEADER || message.term !== node.currentTerm) return;

    if (message.success) {
      node.matchIndex.set(message.from, Math.max(node.matchIndex.get(message.from) ?? 0, message.matchIndex));
      node.nextIndex.set(message.from, (node.matchIndex.get(message.from) ?? 0) + 1);
      this.advanceCommit(node);
    } else {
      const next = Math.max(1, (node.nextIndex.get(message.from) ?? 1) - 1);
      node.nextIndex.set(message.from, next);
      this.replicate(node);
    }
  }

  // -------------------------------------------------------------------- tick

  step() {
    this.tick += 1;

    for (const node of this.nodes) {
      if (!node.alive) continue;

      if (node.state === LEADER) {
        if (this.tick - node.heartbeatAt >= this.options.heartbeat) {
          node.heartbeatAt = this.tick;
          this.replicate(node);
        }
      } else if (this.tick >= node.electionDeadline) {
        this.becomeCandidate(node);
      }
    }

    const due = this.messages.filter((m) => m.due <= this.tick);
    this.messages = this.messages.filter((m) => m.due > this.tick);

    for (const packet of due) {
      const to = this.node(packet.to);
      if (!to || !to.alive || !this.connected(packet.from, packet.to)) {
        this.dropped += 1;
        continue;
      }

      this.delivered += 1;
      const message = { ...packet.message, from: packet.from };
      let reply = null;

      if (message.type === TYPES.vote) reply = this.handleVoteRequest(to, message);
      else if (message.type === TYPES.voteReply) this.handleVoteReply(to, message);
      else if (message.type === TYPES.append) reply = this.handleAppend(to, message);
      else if (message.type === TYPES.appendReply) this.handleAppendReply(to, message);

      if (reply) this.send(to, this.node(packet.from), reply);
    }

    return this.tick;
  }

  run(ticks) {
    for (let i = 0; i < ticks; i += 1) this.step();
    return this;
  }

  /** Snapshot for tests and the UI. */
  snapshot() {
    return this.nodes.map((node) => ({
      id: node.id,
      state: node.state,
      term: node.currentTerm,
      votedFor: node.votedFor,
      commitIndex: node.commitIndex,
      lastIndex: node.lastIndex,
      alive: node.alive,
      log: node.log.map((entry) => ({ index: entry.index, term: entry.term, command: entry.command })),
    }));
  }
}
