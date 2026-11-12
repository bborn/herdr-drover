// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, nextCommand, exec, home, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const EMOJI = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u;
// How long a dragged file has to rest on an agent before Herdr switches to it.
const SPRING_MS = 600;
// How far an agent's row has to move before it's picked up to drop on another space.
const LIFT_PX = 4;

// Runs a command through the command line, which (unlike run) says what it made.
async function doCmd(name, args) {
  const r = await exec(`${home()}/.local/bin/herdr-app`, ["do", name, JSON.stringify(args)]);
  try { return JSON.parse(r.stdout); } catch { return { error: r.stderr || r.stdout }; }
}

// Moves an agent's terminal to another space (an id) or a new one ("new"), as a
// tab of its own, still running. The program keeps working in its own folder;
// only where Herdr shows it changes. A terminal lives on one machine, so it
// can only move between spaces on that machine.
async function moveAgent(address, target, cx) {
  const a = agents().find((x) => x.address === address);
  if (!a || target === a.space) return;
  const from = spaces().find((s) => s.id === a.space);
  const tab = from?.tabs.find((t) => t.id === a.tab);
  const keepName = tab?.named && tab.panes === 1 ? tab.name : null;
  let to = target === "new" ? null : spaces().find((s) => s.id === target);
  if (target !== "new" && !to) return;
  if (to && (to.machine ?? null) !== (from?.machine ?? null)) {
    notify({ title: "Can't move it there", body: `${to.name} is on ${to.machine ?? "this computer"}, and the agent runs on ${from?.machine ?? "this computer"}.`, level: "info", timeout: 4000 });
    return;
  }
  let extra = null;
  if (target === "new") {
    const folder = panes().find((p) => p.pane === a.pane)?.cwd || from?.folder || "";
    const made = await doCmd("space.new", { folder, machine: from?.machine ?? "" });
    if (made.error || !made.space) {
      notify({ title: "Couldn't make a space", body: made.error ?? "", level: "error" });
      return;
    }
    to = { id: made.space };
    extra = made.tab; // its starting shell, closed once the agent is in
  }
  const parked = await doCmd("terminal.park", { terminal: address });
  if (parked.error) {
    notify({ title: "Couldn't move the agent", body: parked.error, level: "error" });
    return;
  }
  await doCmd("space.select", { id: to.id });
  // Parking finishes in the background, so the terminal can't be kept until it has.
  let kept = null;
  for (let i = 0; i < 40; i++) {
    kept = await doCmd("terminal.keep", { terminal: address, place: "tab" });
    if (!kept.error) break;
    await cx.sleep(100);
  }
  if (kept?.error) {
    notify({ title: "Couldn't move the agent", body: `${kept.error}. It's still running; ⌘⇧T can't bring it back, but hc attach ${address} can.`, level: "error" });
    return;
  }
  if (extra) await doCmd("tab.close", { id: extra, confirmed: true });
  if (keepName && kept.tab) await doCmd("tab.rename", { id: kept.tab, name: keepName });
  await doCmd("pane.focus", { terminal: address });
  if (target === "new") await doCmd("space.rename", { id: to.id });
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Space logos and colors, the same ones the drover-spaces sidebar uses.
const SPACE_ICONS = {}; // the same table as ICONS in drover-spaces
const SPACE_COLORS = {}; // a fixed color per space name, e.g. { myproject: "#eddd68" }
function spaceIcon(t, name, size) {
  const key = (name ?? "").toLowerCase();
  if (SPACE_ICONS[key]) return image(SPACE_ICONS[key]).size(size).flex_none().rounded(Math.round(size / 4));
  const letter = (name ?? "?").replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?";
  return div().size(size).flex_none().rounded(Math.round(size / 4)).bg(SPACE_COLORS[key] ?? t.dim)
    .flex().items_center().justify_center().text_size(Math.round(size * 0.62)).font_semibold().text_color("#ffffff").child(letter);
}

// The filter bar's grammar, after TaskYou's:
//   [myproject]       space name (OR'd across brackets; an unclosed "[my" while typing works too)
//   is:blocked        status: blocked / needs, working, done, idle, active (anything but idle)
//   is:pinned         pin state (is:unpinned too)
//   @laptop           the machine an agent runs on (@local for this one; OR'd)
//   anything else     fuzzy text over the space, tab and agent names
const STATUS_ALIAS = { needs: "blocked", waiting: "blocked", running: "working", busy: "working", finished: "done" };
function parseFilter(text) {
  const q = { spaces: [], statuses: [], pinned: null, hosts: [], words: [] };
  let rest = text.replace(/\[([^\]]*)\]/g, (_m, name) => { if (name.trim()) q.spaces.push(name.trim().toLowerCase()); return " "; });
  rest = rest.replace(/\[([^\]\s]*)$/, (_m, name) => { if (name) q.spaces.push(name.toLowerCase()); return " "; });
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = tok.toLowerCase().match(/^(is|status):(.*)$/);
    if (m) {
      const v = STATUS_ALIAS[m[2]] ?? m[2];
      if (v === "pinned") q.pinned = true;
      else if (v === "unpinned") q.pinned = false;
      else if (v) q.statuses.push(v);
    } else if (tok.startsWith("@")) q.hosts.push(tok.slice(1).toLowerCase());
    else q.words.push(tok.toLowerCase());
  }
  return q;
}
const filterEmpty = (q) => !q.spaces.length && !q.statuses.length && q.pinned === null && !q.hosts.length && !q.words.length;
// Every character of `word` in order, anywhere in `hay`.
function fuzzy(word, hay) {
  let i = 0;
  for (const ch of hay) if (ch === word[i]) i++;
  return i === word.length;
}
// How well `word` matches `name`, for ranking the dropdown: a prefix beats a
// substring beats a spread-out subsequence; 0 is no match.
function fuzzyScore(word, name) {
  name = name.toLowerCase();
  if (!word) return 1;
  if (name.startsWith(word)) return 1000 - name.length;
  if (name.includes(word)) return 800 - name.indexOf(word);
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < name.length && i < word.length; j++) {
    if (name[j] !== word[i]) continue;
    if (last >= 0) gaps += j - last - 1;
    last = j;
    i++;
  }
  return i === word.length ? Math.max(1, 500 - gaps * 10) : 0;
}
// The chip still being typed at the end of the filter, after TaskYou: an
// unclosed "[" is a space, an "@" starting the last word is a host.
function openChip(text) {
  let sp = text.lastIndexOf("[");
  if (sp >= 0 && text.slice(sp + 1).includes("]")) sp = -1;
  const at = text.lastIndexOf("@");
  const host = at >= 0 && (at === 0 || text[at - 1] === " ") && !/\s/.test(text.slice(at + 1)) ? at : -1;
  // "is:" (or "status:") starting the last word.
  const word = text.search(/\S*$/);
  const st = text.slice(word).match(/^(is|status):/i);
  const status = st ? word : -1;
  const first = Math.max(host, sp, status);
  if (first < 0) {
    if (!text.trim()) return { kind: "qual", start: 0, query: "" };
    // A plain word offers the spaces and machines it could mean, with nothing
    // picked until ↓, so Enter alone keeps it as text.
    const w = text.slice(word);
    if (w.length >= 2 && !/^[\[@-]/.test(w) && !w.includes(":")) return { kind: "bare", start: word, query: w.toLowerCase() };
    return null;
  }
  if (first === status) return { kind: "status", start: status, query: text.slice(status + st[0].length).toLowerCase() };
  if (first === host) return { kind: "host", start: host, query: text.slice(host + 1).toLowerCase() };
  return { kind: "space", start: sp, query: text.slice(sp + 1).toLowerCase() };
}
// What each kind of chip offers. An empty filter offers the prefixes themselves.
const QUALS = [
  { value: "[", label: "[space]", hint: "agents in a space" },
  { value: "is:", label: "is:status", hint: "blocked, working, done, idle, pinned" },
  { value: "@", label: "@machine", hint: "where the agent runs" },
];
const STATUSES = ["blocked", "working", "done", "idle", "active", "pinned", "unpinned"];
const STATUS_HINT = { active: "anything but idle", pinned: "pinned to the top", unpinned: "not pinned" };
const chipText = (kind, name) => (kind === "host" ? `@${name}` : kind === "status" ? `is:${name}` : `[${name}]`);

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    this.filterOpen = false;
    this.filterText = "";
    this.filterInput = InputState.new({ placeholder: "[space] is:blocked @laptop text" });
    // The highlighted agent and dropdown entry; arrows move them, typing resets them.
    this.at = 0;
    this.sugAt = 0;
    // Enter in the filter hands the keyboard to the list itself, so the arrows walk agents.
    this.handle = cx.focus_handle();
    this.filterInput.on("change", (_e, cx) => {
      const v = this.filterInput.value();
      if (v !== this.filterText) { this.at = 0; this.sugAt = openChip(v)?.kind === "bare" ? -1 : 0; }
      this.filterText = v;
      cx.notify();
    });
    this.filterInput.on("submit", (_e, cx) => {
      // Enter picks from the dropdown when it offers a choice, else goes to the highlighted agent.
      // Enter always finishes an open chip, which closes the dropdown. With several
      // spaces to choose from that is all it does; with one, it shows the agent too.
      const bare = openChip(this.filterText)?.kind === "bare";
      const choosing = bare || this.suggestions?.length > 1;
      const a = this.visible?.[Math.min(this.at, (this.visible?.length ?? 1) - 1)];
      if (this.suggestions?.length && !(bare && this.sugAt < 0)) {
        this.accept(cx);
        if (choosing) return;
        if (a) this.keep = a.address;
      }
      // The input lets go of the keyboard and the list takes it: arrows pick an agent,
      // Enter shows it, Esc closes the filter, / or Tab goes back to typing.
      this.handle.focus();
      cx?.timer?.after(0, () => this.handle.focus());
      cx?.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^drover-agents\./, "");
        if (c === "filter") {
          this.filterOpen = true;
          this.filterInput.focus();
        } else if (c === "clear") this.clearFilter();
        else if (c === "drop") {
          // The spaces list took an agent dropped on one of its rows.
          const d = shared("agent.drop");
          setShared("agent.drop", null);
          this.endAgentDrag();
          if (d) moveAgent(d.address, d.space, cx);
        }
        cx.notify();
      }
    });
  }

  // Writes the dropdown's pick back as a finished chip: "[name] " or "@name ".
  accept(cx) {
    const chip = openChip(this.filterText);
    const item = this.suggestions?.[Math.max(0, this.sugAt)];
    if (!chip || !item) return;
    const name = item.name;
    // A prefix just starts that chip, and the next dropdown opens on it.
    if (chip.kind === "qual") {
      this.filterText = name;
      this.filterInput.set_value(name);
      this.filterInput.set_selected_range({ start: name.length, end: name.length });
      this.sugAt = 0;
      return cx?.notify();
    }
    const kind = item.kind;
    const v = this.filterText.slice(0, chip.start) + chipText(kind, name) + " ";
    // Before set_value, so its change event doesn't read as typing.
    // The finished chip becomes a token: drawn as a pill, deleted whole, and its
    // text stays "[name]" so the filter still reads it. Chips before it keep theirs.
    const text = v.slice(chip.start).trimEnd();
    const kept = this.filterInput.tokens().filter((sp) => sp.range.end <= chip.start);
    this.filterText = v;
    this.filterInput.set_value({
      text: v,
      tokens: [...kept, { range: { start: chip.start, end: chip.start + text.length }, token: { id: `${kind}:${name}`, text, label: name } }],
    });
    this.filterInput.set_selected_range({ start: v.length, end: v.length });
    this.at = 0;
    this.sugAt = 0;
    cx?.notify();
  }

  // A finished "[space]" or "@host" chip in the filter box.
  chip(t, tk) {
    const kind = tk.token.id.split(":")[0];
    const name = tk.token.label ?? tk.token.text;
    return h_flex().h(Math.max(18, tk.line_height - 2)).px(5).gap(4).items_center().rounded(5)
      .bg(tk.selected ? t.selected : t.hover).text_color(t.foreground).text_size(12).font_medium()
      .child(this.sugIcon(t, kind, name, 13))
      .child(kind === "host" ? `@${name}` : name);
  }

  // The mark in front of a suggestion or chip: the space's icon, the status's dot.
  sugIcon(t, kind, name, size) {
    if (kind === "space") return spaceIcon(t, name, size);
    if (kind === "status") {
      const c = name === "pinned" || name === "unpinned" ? t.dim : t[name === "active" ? "working" : name] ?? t.dim;
      return div().size(Math.round(size * 0.6)).mx(2).flex_none().rounded(size).bg(c);
    }
    return null;
  }

  // Ranked names for the chip being typed, or [] when there is none.
  suggest(list) {
    const chip = openChip(this.filterText);
    if (!chip) return [];
    if (chip.kind === "qual") return QUALS.map((q) => ({ kind: "qual", name: q.value }));
    const hosts = () => ["local", ...new Set(list.filter((a) => a.address.includes("/")).map((a) => a.address.split("/")[0]))].map((name) => ({ kind: "host", name }));
    const spaceNames = () => [...new Set(spaces().map((s) => s.name).filter(Boolean))].map((name) => ({ kind: "space", name }));
    const items = chip.kind === "host" ? hosts()
      : chip.kind === "status" ? STATUSES.map((name) => ({ kind: "status", name }))
      : chip.kind === "bare" ? [...spaceNames(), ...hosts()]
      : spaceNames();
    return items
      .map((it) => [it, fuzzyScore(chip.query, it.name)])
      .filter(([, sc]) => sc > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, chip.kind === "bare" ? 6 : 8)
      .map(([it]) => it);
  }

  // Keys while the list (not the filter input) has the keyboard.
  listKey(e, cx) {
    if (!this.handle.is_focused()) return;
    const k = e.key;
    const n = this.visible?.length ?? 0;
    if (k === "down" || k === "up") {
      if (n) this.at = (this.at + (k === "down" ? 1 : n - 1)) % n;
    } else if (k === "enter") {
      const a = this.visible?.[this.at];
      if (!a) return;
      run("pane.focus", { pane: a.pane });
      this.handle.focus();
      cx?.timer?.after(0, () => this.handle.focus());
    } else if (k === "escape") this.clearFilter();
    else if (k === "/" || k === "tab") { this.filterOpen = true; this.filterInput.focus(); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  clearFilter() {
    this.filterOpen = false;
    this.filterText = "";
    this.filterInput.set_value("");
    // Hand the keyboard back to the pane you were in.
    const pane = focused()?.pane;
    if (pane) run("pane.focus", { pane });
  }

  matches(a, q, label) {
    const space = (a.space_name ?? "").toLowerCase();
    if (q.spaces.length && !q.spaces.some((s) => space.includes(s) || fuzzy(s, space))) return false;
    if (q.statuses.length) {
      const st = a.status;
      const ok = q.statuses.some((s) => s === st || (s === "active" && st !== "idle"));
      if (!ok) return false;
    }
    if (q.pinned !== null && Boolean(a.pinned) !== q.pinned) return false;
    if (q.hosts.length) {
      const host = a.address.includes("/") ? a.address.split("/")[0].toLowerCase() : "";
      const ok = q.hosts.some((h) => (["", "local", "here", "localhost"].includes(h) ? host === "" : host.includes(h)));
      if (!ok) return false;
    }
    const hay = [space, label, a.title, a.program?.name].filter(Boolean).join(" ").toLowerCase();
    return q.words.every((w) => hay.includes(w) || fuzzy(w, hay));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // Pressing an agent's row arms a drag; moving LIFT_PX picks it up.
  startAgentDrag(a, e) {
    if (this.adrag?.lifted) setShared("agent.drag", null);
    this.adrag = { address: a.address, space: a.space, y: e.position.y, lifted: false };
    this.target = null;
  }

  trackAgentDrag(e, cx) {
    const d = this.adrag;
    if (!d) return;
    // A move with no button held means it was let go somewhere this list never heard.
    if ("pressed_button" in e && e.pressed_button == null) return this.endAgentDrag(cx);
    if (!d.lifted && Math.abs(e.position.y - d.y) >= LIFT_PX) {
      d.lifted = true;
      const a = agents().find((x) => x.address === d.address);
      const sp = spaces().find((s) => s.id === d.space);
      setShared("agent.drag", { address: d.address, space: d.space, machine: sp?.machine ?? null, name: a?.tab_name || a?.title || "" });
      cx.notify();
    }
  }

  endAgentDrag(cx) {
    if (this.adrag?.lifted) setShared("agent.drag", null);
    this.adrag = null;
    this.target = null;
    cx?.notify();
  }

  dropAgent(cx) {
    const d = this.adrag, target = this.target;
    this.endAgentDrag(cx);
    if (d?.lifted && target && target !== d.space) cx.spawn((cx) => moveAgent(d.address, target, cx));
  }

  // While an agent is lifted, the space under the pointer is where it would go.
  aim(space, on, cx) {
    if (!this.adrag?.lifted) return;
    if (on) this.target = space;
    else if (this.target === space) this.target = null;
    cx.notify();
  }

  spring(a, cx) {
    this.springTask?.cancel();
    this.springing = a.address;
    this.springTask = cx.timer.after(SPRING_MS, (cx) => {
      if (this.springing !== a.address) return;
      this.springing = null;
      run("pane.focus", { pane: a.pane });
      cx.notify();
    });
    cx.notify();
  }

  unspring(cx) {
    this.springTask?.cancel();
    this.springTask = null;
    if (this.springing) { this.springing = null; cx.notify(); }
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const q = parseFilter(this.filterText);
    const filtering = !filterEmpty(q);
    if (filtering) {
      const keep = (a) => this.matches(a, q, label(a));
      list = list.filter(keep);
      pinned.splice(0, pinned.length, ...pinned.filter(keep));
      rest.splice(0, rest.length, ...rest.filter(keep));
    }
    this.visible = list;
    this.suggestions = this.filterOpen ? this.suggest(agents()) : [];
    this.sugAt = Math.min(this.sugAt, Math.max(0, this.suggestions.length - 1));
    // After a chip is completed, the highlight stays on the agent it was on.
    if (this.keep) {
      const i = list.findIndex((a) => a.address === this.keep);
      if (i >= 0) this.at = i;
      this.keep = null;
    }
    this.at = Math.min(this.at, Math.max(0, list.length - 1));
    const listKeys = this.handle.is_focused();
    const cursor = (this.filterOpen && filtering) || listKeys ? list[this.at]?.address : null;

    // Holding a dragged file over an agent's row (or anything dragged in from
    // another app) lights the row up and, after SPRING_MS, switches to that
    // agent, like a spring-loaded folder in Finder. Moving off the row first
    // cancels it. Letting go on the row switches too; nothing is typed.
    const springy = (el, a) => el
      .when(this.springing === a.address, (el) => el.bg(t.selected).border(1).border_color(t.accent))
      .on_mouse_move((e, cx) => {
        if (this.adrag) return;
        if (e.pressed_button === "left") {
          if (this.springing !== a.address && !a.focused) this.spring(a, cx);
        } else if (this.springing) this.unspring(cx);
      })
      .on_drop((_e, cx) => {
        cx.stop_propagation();
        this.unspring(cx);
        run("pane.focus", { pane: a.pane });
      });

    const lifted = this.adrag?.lifted ? this.adrag.address : null;
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return springy(h_flex(), a)
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_hover((on, cx) => { if (!on && this.springing === a.address) this.unspring(cx); })
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      let name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      // A tab named "🛟 support" gives its agent that emoji as an icon.
      const em = (label(a) || "").match(EMOJI);
      if (em && name.startsWith(em[1])) name = name.slice(em[0].length) || name;
      const own = em && div().flex_none().w(16).text_size(14).child(em[1]);
      return springy(h_flex(), a)
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .when(a.address === cursor, (el) => el.border(1).border_color(t.accent))
        .when(lifted === a.address, (el) => el.opacity(0.4))
        .when(Boolean(lifted) && this.target === a.space && a.space !== this.adrag?.space, (el) => el.bg(t.selected).border(1).border_color(t.accent))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e) => this.startAgentDrag(a, e))
        .on_hover((on, cx) => {
          this.aim(a.space, on, cx);
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          if (!on && this.springing === a.address) this.unspring(cx);
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(own), el => el.child(own))
        .when(!own && full, el => el.child(spaceIcon(t, a.space_name, 16)))
        .when(!own && !full && Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", space: !byPriority, status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    // Every group after the first gets a hairline above it, so spaces read as blocks.
    const header = (g, gi) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const line = h_flex()
        .id(g.id)
        .px(8)
        .h(28)
        .flex_none()
        .gap(7)
        .items_center()
        .text_size(12)
        .font_semibold()
        .text_color(t.muted ?? t.dim)
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .when(Boolean(g.space) && Boolean(lifted) && this.target === g.members[0].space && g.members[0].space !== this.adrag?.space, (el) => el.rounded(8).bg(t.selected).border(1).border_color(t.accent))
        .when(Boolean(g.space), (el) => el.on_hover((on, cx) => this.aim(g.members[0].space, on, cx)))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .when(Boolean(g.space), (el) => el.child(spaceIcon(t, g.label, 16)))
        .child(div().truncate().text_color(t[g.status] ?? t.foreground).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
      return v_flex().flex_none()
        .when(gi > 0, (el) => el.child(div().mx(8).mt(10).mb(6).h(1).flex_none().bg(t.border)))
        .when(gi === 0, (el) => el.pt(4))
        .child(line);
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g, gi) => [header(g, gi), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.listKey(e, cx))
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(h_flex().gap(10).items_center()
              .child(div().id("ag-space-new").text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .tooltip("New space")
                .on_click(() => run("space.new"))
                .child(svg("mods/workspace-chrome/plus.svg").size(14)))
              .child(div().id("ag-filter-open").text_size(11).text_color(this.filterOpen ? t.foreground : t.dim)
                .hover((s) => s.text_color(t.foreground))
                .tooltip("Filter agents (\u2318\u21e7\\)")
                .on_click((_e, cx) => {
                  if (this.filterOpen) this.clearFilter();
                  else { this.filterOpen = true; this.filterInput.focus(); }
                  cx.notify();
                })
                .child(svg("mods/workspace-chrome/search.svg").size(14)))
              .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "drover-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14))),
            ),
        ),
      )
      .when(this.filterOpen && !collapsed, (el) =>
        el.child(
          h_flex()
            .id("ag-filter")
            .mx(12)
            .mb(4)
            .px(8)
            .h(28)
            .flex_none()
            .gap(6)
            .items_center()
            .rounded(7)
            .border(1)
            .border_color(filtering ? t.accent : t.input)
            .bg(t.surface)
            .on_key_down((e, cx) => {
              const k = e.key;
              // Arrows stay in the filter: through the dropdown while it offers a
              // choice, else through the matching agents.
              const bare = openChip(this.filterText)?.kind === "bare" && this.suggestions.length > 0;
              const choosing = bare || this.suggestions.length > 1;
              if (k === "escape") this.clearFilter();
              else if (k === "tab" && this.suggestions.length) this.accept();
              else if (k === "down" || k === "up") {
                if (bare) {
                  // -1 is "nothing picked": the word stays plain text.
                  const n = this.suggestions.length + 1;
                  this.sugAt = ((this.sugAt + 1 + (k === "down" ? 1 : n - 1)) % n) - 1;
                } else {
                  const n = choosing ? this.suggestions.length : this.visible.length;
                  if (n) {
                    const d = k === "down" ? 1 : n - 1;
                    if (choosing) this.sugAt = (this.sugAt + d) % n;
                    else this.at = (this.at + d) % n;
                  }
                }
              } else return;
              cx.stop_propagation();
              cx.notify();
            })
            .child(svg("mods/workspace-chrome/search.svg").size(12).flex_none().text_color(t.dim))
            .child(div().flex_1().min_w(0).text_size(12.5).child(Input.new(this.filterInput).token((tk) => this.chip(t, tk))))
            .child(div().id("ag-filter-x").flex_none().text_size(12).text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => { this.clearFilter(); cx.notify(); })
              .child("\u00d7")),
        ),
      )
      .when(this.filterOpen && !collapsed && this.suggestions.length > 0, (el) => {
        const bare = openChip(this.filterText)?.kind === "bare";
        const hint = ({ kind, name: n }) => (kind === "qual" ? QUALS.find((q) => q.value === n)?.hint
          : kind === "status" ? STATUS_HINT[n]
          : bare ? (kind === "host" ? "machine" : "space") : null);
        const shown = ({ kind, name: n }) => (kind === "qual" ? QUALS.find((q) => q.value === n)?.label : kind === "space" ? n : chipText(kind, n));
        return el.child(
          v_flex().mx(12).mb(4).py(3).flex_none().rounded(7).border(1).border_color(t.input).bg(t.surface)
            .children(this.suggestions.map((n, i) =>
              h_flex().id(`ag-sug-${i}`).mx(3).px(6).h(24).gap(6).items_center().rounded(5).text_size(12)
                .when(i === this.sugAt, (el) => el.bg(t.selected))
                .text_color(i === this.sugAt ? t.foreground : t.dim)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => { this.sugAt = i; this.accept(cx); this.filterInput.focus(); })
                .when(Boolean(this.sugIcon(t, n.kind, n.name, 14)), (el) => el.child(this.sugIcon(t, n.kind, n.name, 14)))
                .child(div().flex_none().child(shown(n)))
                .when(Boolean(hint(n)), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(hint(n)))))),
        );
      })
      .when(filtering && list.length === 0 && !collapsed, (el) =>
        el.child(div().px(16).py(6).text_size(12).text_color(t.dim).child("No agents match.")),
      )
      .when(!filtering && list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("scrolling")
        .when(Boolean(lifted), (el) => el.cursor_grabbing())
        .on_mouse_move((e, cx) => this.trackAgentDrag(e, cx))
        .on_mouse_up("left", (_e, cx) => this.dropAgent(cx))
        .children(rows)
        // While an agent is lifted: drop it here to give it a space of its own.
        .when(Boolean(lifted) && !collapsed, (el) => el.child(
          h_flex().id("ag-new-space").mt(8).mb(8).h(34).flex_none().gap(7).items_center().justify_center().rounded(8)
            .border(1).border_color(this.target === "new" ? t.accent : t.input)
            .when(this.target === "new", (el) => el.bg(t.selected))
            .text_size(12).text_color(this.target === "new" ? t.foreground : t.dim)
            .on_hover((on, cx) => this.aim("new", on, cx))
            .child(svg("mods/workspace-chrome/plus.svg").size(12))
            .child("New space"))))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
