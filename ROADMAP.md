# Roadmap

The simulation is honest about what it does not model. This is the work that closes the gap between "a good explainer" and "an implementation you would trust with data", in the order it is worth doing.

## Phase 1: make the simulation less forgiving (about 10 hours)

- [ ] Message reordering, so the network can deliver an `AppendEntries` reply before the request that caused it. Delay is already per message, so this is mostly about removing the FIFO assumption in the tests.
- [ ] Message loss at a configurable rate, independent of partitions.
- [ ] Clock skew: per node election timeouts that drift rather than being resampled from one shared stream.
- [ ] A "chaos" mode that partitions, kills and heals nodes on a timer, running for thousands of ticks, asserting the safety properties after every step.

Done when: a 10,000 tick chaos run never violates election safety or log matching, and the seed that broke it last week is in the test suite.

## Phase 2: persistence and compaction (about 14 hours)

- [ ] A storage interface: `currentTerm`, `votedFor` and the log, written before any reply is sent. In the browser, IndexedDB will do.
- [ ] Crash and restart in the visualiser, showing what survives and what is rebuilt.
- [ ] Snapshotting: compact a prefix of the log into a state snapshot, and send `InstallSnapshot` when a follower has fallen too far behind.
- [ ] A test that kills every node at once and checks the cluster still elects and recovers to the last committed entry.

Done when: a node can be killed at any point, restarted, and the committed log is unchanged.

## Phase 3: the parts real deployments need (about 16 hours)

- [ ] Pre-vote, so a partitioned node returning to the cluster does not disrupt it with a term bump.
- [ ] Membership changes with joint consensus, plus a visualiser scene for adding and removing a node.
- [ ] Linearizable reads: a leader lease or a read index round, with a test that a stale leader cannot answer.
- [ ] Client request table: exactly-once semantics for retried proposals, showing duplicate suppression.

Done when: the thesis's described extensions are all implemented and tested.

## Phase 4: make it a teaching tool (about 12 hours)

- [ ] Scrubbable timeline: drag back through the last 500 ticks and inspect any node's state at that moment.
- [ ] Shareable links: the seed, the partition schedule and the proposals encoded in the URL, so an instructor can hand out a specific failure.
- [ ] Guided scenarios: "split vote", "stale leader", "lost uncommitted entry", each with narration and a stop point.
- [ ] An export of the trace as a diagram, for slides.

Done when: someone can be handed a link and understand why Raft needs a majority without being told.

## Phase 5: prove it (about 8 hours)

- [ ] A model checker for the core: enumerate interleavings for a three node cluster over a bounded number of steps, and assert that no execution produces two leaders in a term or loses a committed entry.
- [ ] Property tests over random seeds, with shrinking to a minimal failing schedule.
- [ ] Publish the results in the README rather than claiming correctness.

Done when: the README can say what was checked, over how many executions, and what was not.

## Known limitations, stated plainly

- Messages are delivered in order; real links reorder.
- No persistence, so restart loses state.
- No snapshots, so the log grows without bound.
- No membership changes.
- The visualiser shows leadership and logs, not the full message payloads.

## Housekeeping

- [ ] GitHub Actions running `npm test` on push.
- [ ] Publish the core as an npm package (`raftlab-core`) so the simulation can be used without the UI.
