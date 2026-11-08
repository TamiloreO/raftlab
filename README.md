# raftlab

A Raft cluster you can watch, partition and break, running entirely in the browser.

![Five nodes, one leader at term 2, three committed entries](docs/demo.png)

## What it is

Raft is the consensus algorithm most distributed systems are built on, and it is unusually hard to learn from prose. Elections, log matching and what happens when a leader is cut off from the majority are all easier to understand when you can see them.

This is a simulation of a five node cluster with the properties that matter made visible: who is leader and in which term, which log entries are committed and which are still in flight, which nodes are cut off from which, and why an old leader keeps calling itself leader after it has been deposed.

The simulation is deterministic. No timers, no threads, no real network: every run advances through `tick()`, so a seed reproduces a run exactly and tests can assert on precise states. The browser app drives the same core that the tests exercise.

## Run it

```bash
git clone https://github.com/TamiloreO/raftlab.git
cd raftlab
python3 -m http.server 8080
```

Open http://localhost:8080/.

Click **Partition** to split the cluster so that the leader ends up in the minority, and watch a new leader take over in a later term while the old one keeps calling itself leader. Click **Heal** and it steps down. Click a node to stop it and restart it. **Propose** appends a command to the current leader's log.

## Run the tests

```bash
npm test
```

Ten tests, no dependencies, covering the safety properties rather than the happy path:

| Test | Property |
| --- | --- |
| One leader | A cluster settles on exactly one leader, and followers agree who it is |
| Replication | Entries reach every follower with matching index and term, and the commit index advances |
| Terms only increase | No node ever moves its term backwards |
| One leader per term | Across 200 ticks including a partition, no term ever has two leaders |
| Partitioned minority | It cannot commit, and it cannot win a later term. The majority side elects |
| Healing | The stale leader steps down, committed entries survive at the same index and term |
| Conflicting suffix | Entries from an old term are truncated when the leader overwrites them |
| Determinism | The same seed produces byte-identical state |
| Leader death | Killing the leader produces a replacement, and reviving the old one does not disrupt it |
| Single node | A one node cluster is its own quorum and commits immediately |

One thing the tests had to learn the hard way: a partitioned old leader keeps reporting itself as leader, and that is correct. It cannot know it has been deposed until it talks to a majority. The property to assert is that it cannot **commit**, not that it stops calling itself leader.

## How it works

```
src/raft.js   the algorithm: state, messages, elections, replication, partitions
test/         node:test suites for the safety properties
main.js       canvas visualiser, controls, no framework
index.html    markup
style.css     styling
```

The core exposes a `RaftCluster` with `step()`, `run(ticks)`, `propose(command)`, `setPartitions(groups)`, `heal()`, `kill(id)`, `revive(id)` and `snapshot()`. Time is measured in ticks: an election timeout of 14 to 34 ticks, a heartbeat every 3, and a message delay of 2 to 4 ticks. Those numbers are deliberately small so a viewer sees a full election in a couple of seconds, and everything about them is configurable.

Messages carry a `start` and `due` tick so the renderer can interpolate them along the edge, which is why packets move smoothly while the simulation itself is discrete.

## What the colours mean

| Element | Meaning |
| --- | --- |
| Green ring, LEADER | Current leader |
| Rose ring, STALE | A leader that has been superseded but does not know it yet, because it is cut off |
| Amber ring, CANDIDATE | Standing for election |
| Dashed line | The partition between those two nodes; messages across it are dropped |
| Log squares | Entries, coloured by term. White outline means committed. Dim means still in flight |

## Limits

No persistence, so a restart loses the log. No log compaction or snapshots, so the log grows forever. No membership changes, no pre-vote, no client request handling beyond appending to the leader. The network model drops messages across a partition but never reorders them, which is a simplification: real links reorder.

These are listed in [ROADMAP.md](ROADMAP.md) with the work required to fix each.

## License

[MIT](LICENSE) © Oluwatamilore Olufohunsi
