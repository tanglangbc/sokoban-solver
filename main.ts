// Sokoban solver entry for sokoban-solver-01.
//
// A level is a 1-wide hallway with 1-4 rooms off it (6x6 slots, 3-4 boxes
// each). A box pushed through a door into the hallway can never return, so
// each room is independent and the level optimum is the sum of the room
// optima. The solver therefore splits the level into rooms, solves each room
// on its own with a push-optimal macro-push A*, and stitches the room
// solutions together with plain player walks through the hallway.
//
// Per room the search is over macro-push states: the sorted box positions
// plus the player's reachable region (flood fill over the room floor and the
// hallway cell just outside the door, which the player may stand on to push
// a box that starts on the door itself). The heuristic is the minimum
// assignment of boxes to goals by shortest-path floor distances (admissible:
// every push moves one box one step). Deadlock pruning: boxes on squares
// from which no pull sequence can reach a goal, and frozen 2x2 blocks of
// wall/box cells holding a box off its goal.
//
// The search is budgeted by node count, never by the wall clock, and every
// tie is broken deterministically, so two runs of the program write
// byte-identical answers. A run-wide node budget (150,000 expansions; the
// practice set needs ~2,500) keeps one pathological room from eating the 60s
// wall for the whole set. No dependencies, no network, plain erasable
// TypeScript for Node 22.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed move order: up, down, left, right. Deterministic tie-breaking everywhere.
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// Node budgets (expansions). Deterministic: the same input always expands the
// same nodes, so both grader runs produce identical output.
const ROOM_EXPANSION_CAP = 400_000;
const WHOLE_EXPANSION_CAP = 120_000;
// Run-wide budget: a pathological room must never eat the 60s wall for the
// whole set. Practice needs ~2,500 expansions in total, so 150,000 is 60x
// headroom; once spent, every further search bails out at once and the run
// still writes an answer file for every instance.
const GLOBAL_EXPANSION_CAP = 150_000;
let spentExpansions = 0;

interface Parsed {
  w: number;
  h: number;
  floor: boolean[]; // true where the player / a box may stand (# is false)
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Parsed {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const floor: boolean[] = new Array(w * h).fill(false);
  const goals: number[] = [];
  let boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      floor[i] = ch !== '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, floor, goals, boxes, player };
}

// Breadth-first walk on floor cells, treating `blocked` cells as walls.
// Returns the move string from `from` to `to`, or null when unreachable.
function walkPath(
  floor: boolean[],
  w: number,
  from: number,
  to: number,
  blocked: Set<number>,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(floor.length).fill(-2);
  const prevMove = new Array<string>(floor.length).fill('');
  prev[from] = -1;
  const queue: number[] = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy, letter] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const ni = ny * w + nx;
      if (ni >= floor.length || !floor[ni] || blocked.has(ni) || prev[ni] !== -2) continue;
      prev[ni] = cur;
      prevMove[ni] = letter;
      if (ni === to) {
        let moves = '';
        for (let t = ni; t !== from; t = prev[t]!) moves = prevMove[t]! + moves;
        return moves;
      }
      queue.push(ni);
    }
  }
  return null;
}

// Flood fill from `start` over floor cells not in `blocked`. Returns the
// reached cells and, for each, the shortest walk from `start` (parent map).
function flood(
  floor: boolean[],
  w: number,
  start: number,
  blocked: Set<number>,
): { reached: boolean[]; prev: Int32Array; prevMove: string[] } {
  const reached = new Array<boolean>(floor.length).fill(false);
  const prev = new Int32Array(floor.length).fill(-2);
  const prevMove = new Array<string>(floor.length).fill('');
  reached[start] = true;
  prev[start] = -1;
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy, letter] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const ni = ny * w + nx;
      if (ni >= floor.length || !floor[ni] || blocked.has(ni) || reached[ni]) continue;
      reached[ni] = true;
      prev[ni] = cur;
      prevMove[ni] = letter;
      queue.push(ni);
    }
  }
  return { reached, prev, prevMove };
}

function walkFromFlood(
  prev: Int32Array,
  prevMove: string[],
  from: number,
  to: number,
): string {
  let moves = '';
  for (let t = to; t !== from; t = prev[t]!) moves = prevMove[t]! + moves;
  return moves;
}

// All-pairs shortest-path distances on `floor` (boxes ignored), as a flat
// table dist[a * n + b]. Unreachable pairs stay at a large sentinel.
function allPairsDist(floor: boolean[], w: number): Int32Array {
  const n = floor.length;
  const INF = 1_000_000;
  const dist = new Int32Array(n * n).fill(INF);
  for (let s = 0; s < n; s++) {
    if (!floor[s]) continue;
    dist[s * n + s] = 0;
    const queue: number[] = [s];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w) continue;
        const ni = ny * w + nx;
        if (ni >= n || !floor[ni] || dist[s * n + ni] !== INF) continue;
        dist[s * n + ni] = dist[s * n + cur]! + 1;
        queue.push(ni);
      }
    }
  }
  return dist;
}

// Squares from which a box can be pushed onto a goal. Reverse the pushes:
// a box on p could have been pushed there from p-d, and that push needs the
// player standing at p-2d, so p-d is live when p-2d is floor the player may
// stand on (other boxes ignored: an over-approximation, so pruning a box on
// a non-live square is always sound).
// `boxFloor` is where a box may stand; `walkFloor` is where the player may
// stand (the room floor plus the hallway cell outside the door). Seeds are
// the goals.
function liveSquares(
  boxFloor: boolean[],
  walkFloor: boolean[],
  w: number,
  goals: number[],
): boolean[] {
  const n = boxFloor.length;
  const h = n / w;
  const live = new Array<boolean>(n).fill(false);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = true;
    queue.push(g);
  }
  let head = 0;
  while (head < queue.length) {
    const p = queue[head++]!;
    const px = p % w;
    const py = (p / w) | 0;
    for (const [dx, dy] of DIRS) {
      const fx = px - dx;
      const fy = py - dy;
      const bx = px - 2 * dx;
      const by = py - 2 * dy;
      if (fx < 0 || fy < 0 || bx < 0 || by < 0) continue;
      if (fx >= w || fy >= h || bx >= w || by >= h) continue;
      const from = fy * w + fx;
      const beyond = by * w + bx;
      if (!boxFloor[from] || !walkFloor[beyond] || live[from]) continue;
      live[from] = true;
      queue.push(from);
    }
  }
  return live;
}

// Minimum assignment of boxes to goals by table distance (brute force over
// permutations; at most 4 boxes). Admissible push lower bound.
function assignmentBound(
  boxes: number[],
  goals: number[],
  dist: Int32Array,
  n: number,
): number {
  const m = boxes.length;
  const perm = goals.slice(0, m);
  let best = Infinity;
  const rec = (k: number, sum: number): void => {
    if (sum >= best) return;
    if (k === m) {
      best = sum;
      return;
    }
    for (let j = k; j < m; j++) {
      [perm[k], perm[j]] = [perm[j]!, perm[k]!];
      const d = dist[boxes[k]! * n + perm[k]!]!;
      rec(k + 1, sum + (d >= 1_000_000 ? 10_000 : d));
      [perm[k], perm[j]] = [perm[j]!, perm[k]!];
    }
  };
  rec(0, 0);
  return best;
}

// Binary heap of [f, -g, seq, state]: smallest f first, deeper g first on
// ties, insertion order last, so the pop order is fully deterministic.
type HeapEntry = [number, number, number, number];
function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  return (
    a[0] < b[0] ||
    (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
  );
}
function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[p]!)) break;
    [heap[i], heap[p]] = [heap[p]!, heap[i]!];
    i = p;
  }
}
function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
      if (!heapLess(heap[c]!, heap[i]!)) break;
      [heap[i], heap[c]] = [heap[c]!, heap[i]!];
      i = c;
    }
  }
  return top;
}

interface RoomResult {
  moves: string;
  endPlayer: number;
  endBoxes: number[];
  pushes: number;
}

// Push-optimal A* for one room (or the whole level, when called with the
// level's floor for both floors). `boxFloor` is where boxes may stand (the
// room's cells); `walkFloor` adds the hallway cell just outside the door,
// where the player may stand but a box may never go. The player starts on
// `startPlayer` (that hallway cell). With `requireExit`, a solved state only
// counts when the player can still walk back out through `door`; the exit
// walk is then appended to the moves and endPlayer is the door.
// Returns null when the node budget runs out or the room is unsolvable.
function solveRoom(
  boxFloor: boolean[],
  walkFloor: boolean[],
  w: number,
  boxes0: number[],
  goals: number[],
  startPlayer: number,
  door: number,
  requireExit: boolean,
  cap: number,
): RoomResult | null {
  const n = boxFloor.length;
  const dist = allPairsDist(boxFloor, w);
  const live = liveSquares(boxFloor, walkFloor, w, goals);
  const goalSet = new Set(goals);
  const isGoal = (c: number): boolean => goalSet.has(c);

  // 2x2 windows that can freeze: every cell is a wall or a room cell (never
  // the entry cell, which is open floor a box can never occupy). A window is
  // frozen when all four cells are wall/box and one of the boxes is off its
  // goal: none of those boxes can ever move again.
  const windows: number[][] = [];
  const rows = (n / w) | 0;
  for (let y = 0; y + 1 < rows; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = y * w + x;
      const quad = [a, a + 1, a + w, a + w + 1];
      if (quad.every((c) => !walkFloor[c] || boxFloor[c])) windows.push(quad);
    }
  }
  const frozen = (boxes: number[]): boolean => {
    for (const quad of windows) {
      let allSolid = true;
      let badBox = false;
      for (const c of quad) {
        if (boxes.includes(c)) {
          if (!isGoal(c)) badBox = true;
        } else if (walkFloor[c]) {
          allSolid = false;
          break;
        }
      }
      if (allSolid && badBox) return true;
    }
    return false;
  };
  const dead = (boxes: number[]): boolean => {
    for (const b of boxes) if (!live[b]) return true;
    return frozen(boxes);
  };

  if (dead(boxes0)) return null;

  const h = (boxes: number[]): number => assignmentBound(boxes, goals, dist, n);

  // State storage. A state is (sorted boxes, player region representative):
  // the representative is the lowest cell of the player's reachable region,
  // so two states that differ only in where the player stands inside one
  // region collapse to one entry.
  const stBoxes: number[][] = [boxes0.slice().sort((a, b) => a - b)];
  const stPlayer: number[] = [startPlayer];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stSeg: string[] = [''];
  const stKey: string[] = [''];
  const best = new Map<string, number>();

  const regionRep = (boxes: number[], player: number): number => {
    const { reached } = flood(walkFloor, w, player, new Set(boxes));
    let rep = player;
    for (let i = 0; i < n; i++) if (reached[i] && i < rep) rep = i;
    return rep;
  };
  const keyOf = (boxes: number[], rep: number): string => boxes.join(',') + '|' + rep;

  stKey[0] = keyOf(stBoxes[0]!, regionRep(stBoxes[0]!, startPlayer));
  best.set(stKey[0]!, 0);

  const heap: HeapEntry[] = [];
  let seq = 0;
  heapPush(heap, [h(stBoxes[0]!), 0, seq++, 0]);

  let expanded = 0;
  while (heap.length > 0) {
    const [, negG, , s] = heapPop(heap);
    const g = -negG;
    if (best.get(stKey[s]!) !== s) continue; // superseded by a cheaper route
    const boxes = stBoxes[s]!;
    const player = stPlayer[s]!;
    const blocked = new Set(boxes);
    const { reached, prev, prevMove } = flood(walkFloor, w, player, blocked);
    if (boxes.every(isGoal)) {
      if (!requireExit || reached[door]) {
        let moves = '';
        for (let t = s; t > 0; t = stParent[t]!) moves = stSeg[t]! + moves;
        let endPlayer = player;
        if (requireExit) {
          moves += walkFromFlood(prev, prevMove, player, door);
          endPlayer = door;
        }
        return { moves, endPlayer, endBoxes: boxes.slice(), pushes: g };
      }
      // Solved but the player is trapped inside: do not expand this state.
      // (A longer route that leaves and re-enters is not worth chasing here;
      // the caller re-solves with requireExit when it sees the trap.)
      continue;
    }
    if (expanded >= cap || spentExpansions >= GLOBAL_EXPANSION_CAP) return null;
    expanded++;
    spentExpansions++;

    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (const [dx, dy, letter] of DIRS) {
        const tx = bx + dx;
        const ty = by + dy;
        const behindX = bx - dx;
        const behindY = by - dy;
        if (tx < 0 || ty < 0 || behindX < 0 || behindY < 0 || tx >= w || behindX >= w) continue;
        const target = ty * w + tx;
        const behind = behindY * w + behindX;
        if (target >= n || behind >= n) continue;
        if (!boxFloor[target] || blocked.has(target)) continue;
        if (!reached[behind]) continue;
        const nb = boxes.slice();
        nb[bi] = target;
        nb.sort((a, b2) => a - b2);
        if (dead(nb)) continue;
        const rep = regionRep(nb, b);
        const k = keyOf(nb, rep);
        const seenIdx = best.get(k);
        if (seenIdx !== undefined && stG[seenIdx]! <= g + 1) continue;
        const t = stBoxes.length;
        stBoxes.push(nb);
        stPlayer.push(b);
        stG.push(g + 1);
        stParent.push(s);
        stSeg.push(walkFromFlood(prev, prevMove, player, behind) + letter);
        stKey.push(k);
        best.set(k, t);
        heapPush(heap, [g + 1 + h(nb), -(g + 1), seq++, t]);
      }
    }
  }
  return null;
}

interface Room {
  cells: number[]; // room floor cells (global indices, includes the door)
  boxes: number[];
  goals: number[];
  doors: { door: number; entry: number }[]; // door cell + hallway cell outside it
}

// Split a level into rooms: connected floor components once the hallway row
// (the player's row) is removed. Each component is one room; its door is a
// component cell touching a hallway floor cell, and its entry is that hallway
// cell. A box may start on the door itself: the player pushes it from the
// entry cell, so the door cell stays part of the room.
function decompose(p: Parsed): Room[] | null {
  const hallRow = (p.player / p.w) | 0;
  const hallway = new Set<number>();
  for (let c = 0; c < p.w; c++) {
    const i = hallRow * p.w + c;
    if (p.floor[i]) hallway.add(i);
  }
  const seen = new Array<boolean>(p.w * p.h).fill(false);
  const rooms: Room[] = [];
  for (let i = 0; i < p.w * p.h; i++) {
    if (!p.floor[i] || hallway.has(i) || seen[i]) continue;
    const cells: number[] = [];
    const queue: number[] = [i];
    seen[i] = true;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
      cells.push(cur);
      const cx = cur % p.w;
      const cy = (cur / p.w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
        const ni = ny * p.w + nx;
        if (!p.floor[ni] || ny === hallRow || seen[ni]) continue;
        seen[ni] = true;
        queue.push(ni);
      }
    }
    const cellSet = new Set(cells);
    const boxes = p.boxes.filter((b) => cellSet.has(b));
    const goals = p.goals.filter((g) => cellSet.has(g));
    const doors: { door: number; entry: number }[] = [];
    for (const cell of cells) {
      const cx = cell % p.w;
      const cy = (cell / p.w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
        const ni = ny * p.w + nx;
        if (hallway.has(ni)) doors.push({ door: cell, entry: ni });
      }
    }
    if (doors.length === 0 || boxes.length === 0 || boxes.length !== goals.length) {
      return null;
    }
    rooms.push({ cells, boxes, goals, doors });
  }
  // Every box and goal must sit inside some room.
  const covered = new Set<number>();
  for (const r of rooms) for (const c of r.cells) covered.add(c);
  if (!p.boxes.every((b) => covered.has(b))) return null;
  if (!p.goals.every((g) => covered.has(g))) return null;
  // Deterministic room order: by first door cell (top rooms first, then by
  // column). Any order works — the hallway is always clear — this one keeps
  // the player's hallway walks short.
  rooms.sort((a, b) => a.doors[0]!.door - b.doors[0]!.door);
  return rooms;
}

function solveLevel(text: string): string {
  const p = parseLevel(text);
  const rooms = decompose(p);
  if (rooms !== null) {
    let moves = '';
    let cur = p.player;
    let boxesNow = p.boxes.slice();
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const isLast = ri === rooms.length - 1;
      const boxFloor: boolean[] = new Array(p.w * p.h).fill(false);
      for (const c of room.cells) boxFloor[c] = true;
      const roomBoxSet = new Set(room.boxes);
      let solved = false;
      for (const { door, entry } of room.doors) {
        const walkIn = walkPath(p.floor, p.w, cur, entry, new Set(boxesNow));
        if (walkIn === null) continue;
        const walkFloor = boxFloor.slice();
        walkFloor[entry] = true;
        const res = solveRoom(
          boxFloor, walkFloor, p.w, room.boxes, room.goals,
          entry, door, false, ROOM_EXPANSION_CAP,
        );
        if (res === null) continue;
        const boxesAfter = boxesNow
          .filter((b) => !roomBoxSet.has(b))
          .concat(res.endBoxes)
          .sort((a, b) => a - b);
        if (!isLast) {
          const exitWalk = walkPath(p.floor, p.w, res.endPlayer, door, new Set(boxesAfter));
          if (exitWalk === null) {
            // Solved but the player is trapped inside: re-solve requiring an
            // exit through the door (may cost extra pushes, still far better
            // than an unsolved room).
            const res2 = solveRoom(
              boxFloor, walkFloor, p.w, room.boxes, room.goals,
              entry, door, true, ROOM_EXPANSION_CAP,
            );
            if (res2 === null) continue;
            const boxesAfter2 = boxesNow
              .filter((b) => !roomBoxSet.has(b))
              .concat(res2.endBoxes)
              .sort((a, b) => a - b);
            moves += walkIn + res2.moves;
            cur = res2.endPlayer;
            boxesNow = boxesAfter2;
            solved = true;
            break;
          }
          moves += walkIn + res.moves + exitWalk;
          cur = door;
          boxesNow = boxesAfter;
          solved = true;
          break;
        }
        moves += walkIn + res.moves;
        cur = res.endPlayer;
        boxesNow = boxesAfter;
        solved = true;
        break;
      }
      if (!solved) {
        // This room cannot be solved: the level scores 0 either way, so stop
        // here with the legal moves built so far and save the node budget for
        // the remaining levels.
        return moves;
      }
    }
    return moves;
  }
  // Decomposition failed (unexpected level shape): push-optimal A* on the
  // whole level at once, with a small budget so it can never eat the run.
  const whole = solveRoom(
    p.floor, p.floor, p.w, p.boxes, p.goals,
    p.player, -1, false, WHOLE_EXPANSION_CAP,
  );
  if (whole !== null) return whole.moves;
  // Answered but unsolved: an empty solution is still a valid answer file.
  return '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
