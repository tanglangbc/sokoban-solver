# Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/tanglangbc/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/tanglangbc/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Built for [make.fun](https://make.fun/?ref=NVRADX) — entry for [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121).

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty.

## How it works

A level is a hallway with 1-4 rooms off it. A box pushed through a door into
the hallway can never return, so each room is independent and the level
optimum is the sum of the room optima. The solver therefore:

1. splits the level into rooms (connected floor regions off the hallway row),
2. solves each room on its own with a push-optimal A* over macro-push
   states (sorted box positions + the player's reachable region), using a
   minimum-assignment box-to-goal heuristic and deadlock pruning (dead
   squares from reverse-push reachability, frozen 2x2 blocks),
3. stitches the room solutions together with plain player walks through
   the hallway.

Two details matter. A box may start on a room's door cell: the player
enters from the hallway cell just outside the door, which the room search
treats as floor the player may stand on (so that box can be pushed in from
the hallway) but never as a square a box may occupy. And after solving a
room the player must be able to walk back out through its door to reach
the next room: the solver first takes the push-optimal solution and checks
the exit walk, and only if the player is trapped inside does it re-solve
that room requiring an exit (which may cost extra pushes, still far better
than an unsolved room).

If a room cannot be solved within its node budget, the solver stops with
the legal moves built so far (the level scores 0 either way) and saves the
budget for the remaining levels. Only when a level does not decompose into
rooms at all does it fall back to a push-optimal A* on the whole level;
if that fails too it writes an empty solution (still a valid answer file).

The search is budgeted by node count, never by the wall clock, so two runs
produce byte-identical output.

## Run

```sh
node main.ts
```

Reads `/input/<id>/level.txt` for `i001`..`i005` and writes
`/output/<id>/solution.txt` (or set `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR` to override the directories). Node 22+, no
dependencies, no network.
