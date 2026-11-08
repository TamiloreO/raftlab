import test from "node:test";
import assert from "node:assert/strict";

import { RaftCluster, LEADER, FOLLOWER, CANDIDATE } from "../src/raft.js";

function leaders(cluster) {
  return cluster.nodes.filter((n) => n.state === LEADER);
}

/** Runs until a leader exists, so tests do not depend on election luck. */
function runUntilLeader(cluster, maxTicks = 300) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (cluster.leader()) return cluster.leader();
    cluster.step();
  }
  return cluster.leader();
}

test("a cluster elects exactly one leader", () => {
  const cluster = new RaftCluster({ seed: 3 });
  cluster.run(60);

  const elected = leaders(cluster);
  assert.equal(elected.length, 1, `expected one leader, got ${elected.length}`);

  // Everyone in the same term should agree on who leads.
  const term = elected[0].currentTerm;
  const followers = cluster.nodes.filter((n) => n.currentTerm === term && n.state !== LEADER);
  for (const node of followers) {
    assert.equal(node.leaderId, elected[0].id, `${node.id} should point at ${elected[0].id}`);
  }
});

test("the leader replicates entries and advances the commit index", () => {
  const cluster = new RaftCluster({ seed: 11 });
  const leader = runUntilLeader(cluster);
  assert.ok(leader, "a leader should exist");

  for (const command of ["set x 1", "set y 2", "set z 3"]) {
    assert.ok(cluster.propose(command) !== null, "proposal should be accepted");
    cluster.run(12);
  }

  assert.ok(leader.commitIndex >= 3, `commit index should reach 3, got ${leader.commitIndex}`);

  for (const node of cluster.nodes) {
    assert.ok(node.lastIndex >= 3, `${node.id} should have replicated at least 3 entries`);
    for (let index = 1; index <= 3; index += 1) {
      assert.equal(node.log[index].index, index, `${node.id} entry ${index} index`);
      assert.equal(node.log[index].term, leader.log[index].term, `${node.id} entry ${index} term`);
      assert.equal(node.log[index].command, leader.log[index].command, `${node.id} entry ${index} command`);
    }
  }
});

test("terms only move forward", () => {
  const cluster = new RaftCluster({ seed: 5 });
  const seen = cluster.nodes.map(() => 0);

  for (let i = 0; i < 120; i += 1) {
    cluster.step();
    cluster.nodes.forEach((node, index) => {
      assert.ok(node.currentTerm >= seen[index], `${node.id} term went backwards`);
      seen[index] = node.currentTerm;
    });
  }
});

test("at most one leader exists per term, even across partitions", () => {
  const cluster = new RaftCluster({ seed: 9 });
  const leadersByTerm = new Map();

  for (let i = 0; i < 200; i += 1) {
    if (i === 40) cluster.setPartitions([["A", "B"], ["C", "D", "E"]]);
    if (i === 120) cluster.heal();
    cluster.step();

    for (const node of cluster.nodes) {
      if (node.state !== LEADER) continue;
      const key = node.currentTerm;
      const existing = leadersByTerm.get(key);
      if (existing) {
        assert.equal(existing, node.id, `two leaders in term ${key}: ${existing} and ${node.id}`);
      }
      leadersByTerm.set(key, node.id);
    }
  }

  assert.ok(leadersByTerm.size > 1, "the scenario should produce more than one term");
});

test("a partitioned minority cannot elect a leader or commit", () => {
  const cluster = new RaftCluster({ seed: 4 });
  const leader = runUntilLeader(cluster);
  assert.ok(leader, "a leader should exist before partitioning");

  const isolated = [leader.id, cluster.nodes.find((n) => n.id !== leader.id).id];
  const others = cluster.nodes.map((n) => n.id).filter((id) => !isolated.includes(id));
  cluster.setPartitions([isolated, others]);

  const commitBefore = leader.commitIndex;
  cluster.propose("written while isolated");
  cluster.run(80);

  // The old leader cannot know it has been deposed, so it may still call itself
  // leader. What it cannot do is commit, because no majority can hear it.
  assert.equal(leader.commitIndex, commitBefore, "an isolated leader must not commit");

  const majorityLeader = cluster.nodes.find((n) => others.includes(n.id) && n.state === LEADER);
  assert.ok(majorityLeader, "the majority side should elect a leader");
  assert.ok(majorityLeader.currentTerm > leader.currentTerm, "the new leader needs a later term");

  // Nobody in the minority can win an election in a later term.
  for (const id of isolated) {
    const node = cluster.node(id);
    assert.ok(node.currentTerm <= leader.currentTerm, `${id} should not have advanced its term`);
  }

  // On heal, the stale leader steps down and the isolated entry is discarded.
  cluster.heal();
  cluster.run(120);
  assert.notEqual(cluster.node(leader.id).state, LEADER, "the stale leader should step down after healing");
  const finalLeader = cluster.leader();
  assert.ok(finalLeader, "one leader should remain");
  assert.ok(!finalLeader.log.some((entry) => entry.command === "written while isolated"),
    "an entry that never reached a majority must not be committed");
});

test("healing a partition converges the logs and loses nothing committed", () => {
  const cluster = new RaftCluster({ seed: 21 });
  runUntilLeader(cluster);
  cluster.propose("first");
  cluster.run(15);

  const leader = cluster.leader();
  const committedBefore = leader.commitIndex;
  assert.ok(committedBefore >= 1, "the first entry should commit before the partition");

  const snapshot = leader.log.slice(1, committedBefore + 1).map((entry) => ({ ...entry }));

  const others = cluster.nodes.filter((n) => n.id !== leader.id).map((n) => n.id);
  cluster.setPartitions([[leader.id], others]);
  cluster.propose("lost while isolated");
  cluster.run(60);
  cluster.heal();
  cluster.run(80);

  // The committed entry must survive at the same index and term everywhere.
  for (const node of cluster.nodes) {
    for (const entry of snapshot) {
      assert.ok(node.log[entry.index], `${node.id} is missing index ${entry.index}`);
      assert.equal(node.log[entry.index].term, entry.term, `${node.id} changed the term at ${entry.index}`);
      assert.equal(node.log[entry.index].command, entry.command, `${node.id} changed the command at ${entry.index}`);
    }
  }

  // The cluster should end up with one leader, and every committed entry must
  // agree across nodes. Uncommitted tails are allowed to differ: Raft only
  // guarantees the committed prefix, and conflicting suffixes are truncated
  // when the leader next writes over them.
  const finalLeader = cluster.leader();
  assert.ok(finalLeader, "the healed cluster should have a leader");
  const committed = finalLeader.commitIndex;

  for (const node of cluster.nodes) {
    assert.ok(node.log.length >= committed, `${node.id} is missing committed entries`);
    for (let i = 1; i <= committed; i += 1) {
      assert.equal(node.log[i].term, finalLeader.log[i].term, `${node.id} term mismatch at ${i}`);
      assert.equal(node.log[i].command, finalLeader.log[i].command, `${node.id} command mismatch at ${i}`);
    }
  }
});

test("the same seed produces the same run", () => {
  const run = () => {
    const cluster = new RaftCluster({ seed: 42 });
    cluster.run(30);
    cluster.propose("alpha");
    cluster.run(30);
    return JSON.stringify(cluster.snapshot());
  };

  assert.equal(run(), run());
});

test("a killed leader is replaced", () => {
  const cluster = new RaftCluster({ seed: 8 });
  cluster.run(40);

  const leader = cluster.leader();
  assert.ok(leader);
  cluster.kill(leader.id);
  cluster.run(80);

  const replacement = cluster.leader();
  assert.ok(replacement, "the cluster should elect a new leader");
  assert.notEqual(replacement.id, leader.id, "the dead node cannot come back as leader");

  // Revive it and check it rejoins as a follower rather than disrupting the cluster.
  cluster.revive(leader.id);
  cluster.run(40);
  const revived = cluster.node(leader.id);
  assert.notEqual(revived.state, LEADER, "a revived old leader should not assume leadership");
});

test("a conflicting suffix from an old term is truncated", () => {
  const cluster = new RaftCluster({ seed: 13 });
  const leader = runUntilLeader(cluster);
  cluster.propose("one");
  cluster.run(15);
  cluster.propose("two");
  cluster.run(15);

  const follower = cluster.nodes.find((n) => n.id !== leader.id);
  const staleIndex = leader.lastIndex + 1;

  // An entry the follower accepted in an earlier term that the leader never had.
  follower.log.push({ index: staleIndex, term: 1, command: "stale" });

  cluster.propose("three");
  cluster.run(40);

  assert.equal(follower.log[staleIndex].term, leader.log[staleIndex].term, "stale term should be replaced");
  assert.equal(follower.log[staleIndex].command, "three", "stale command should be replaced");
});

test("a single node cluster leads itself", () => {
  const cluster = new RaftCluster({ size: 1, seed: 2 });
  cluster.run(30);

  assert.equal(cluster.leader()?.id, "A");
  assert.equal(cluster.propose("solo"), 1);
  cluster.run(10);
  assert.equal(cluster.node("A").commitIndex, 1);
});
