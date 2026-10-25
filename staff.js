/** Staff dashboard: filter calls, open one, mark follow-up as done. */
(() => {
  const $ = id => document.getElementById(id);
  const rows = $("rows"), detail = $("detail"), none = $("none");
  let calls = [], selected = null;
  const refNo = id => "NM-" + String(id).padStart(5, "0");

  const pillClass = o => (o === "resolved" ? "good" : o === "escalated" ? "warn" : "bad");
  const label = s => (s || "—").replace(/_/g, " ");
  const when = iso => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function duration(c) { if (!c.ended_at) return "—"; const s = Math.max(0, Math.round((new Date(c.ended_at) - new Date(c.started_at)) / 1000)); return `${Math.floor(s / 60)}m ${s % 60}s`; }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  async function load() {
    const q = { intent: $("f-intent").value, outcome: $("f-outcome").value, follow_up: $("f-follow").value };
    try { calls = await Api.listCalls(q); } catch { calls = []; }
    renderRows(); renderStats();
    if (selected && calls.some(c => c.id === selected)) open(selected);
  }

  function bars(id, counts, colorOf) {
    const box = $(id); box.replaceChildren();
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { box.append(el("p", "hint", "No data yet.")); return; }
    const max = Math.max(...entries.map(e => e[1]));
    for (const [k, v] of entries) {
      const row = el("div", "barrow");
      const track = el("div", "track"); const fill = el("div", "fill " + (colorOf ? colorOf(k) : ""));
      fill.style.width = Math.max(4, Math.round((v / max) * 100)) + "%"; track.append(fill);
      row.append(el("span", "bl", label(k)), track, el("span", "bv", String(v)));
      box.append(row);
    }
  }

  function renderCharts() {
    const count = key => calls.reduce((m, c) => { const k = c[key] || "unknown"; m[k] = (m[k] || 0) + 1; return m; }, {});
    bars("c-intent", count("main_intent"));
    bars("c-outcome", count("outcome"), pillClass);
  }

  function renderStats() {
    renderCharts();
    $("s-total").textContent = calls.length;
    $("s-resolved").textContent = calls.filter(c => c.outcome === "resolved").length;
    $("s-escalated").textContent = calls.filter(c => c.outcome === "escalated").length;
    $("s-pending").textContent = calls.filter(c => c.follow_up_status && c.follow_up_status !== "none").length;
  }

  function renderRows() {
    rows.replaceChildren();
    none.hidden = calls.length > 0;
    for (const c of calls) {
      const tr = el("tr"); tr.tabIndex = 0; tr.dataset.id = c.id;
      if (c.id === selected) tr.classList.add("sel");
      tr.append(el("td", "", when(c.started_at)), el("td", "", label(c.main_intent)));
      const o = el("td"); o.append(el("span", "pill " + pillClass(c.outcome), c.outcome)); tr.append(o);
      tr.append(el("td", "", c.follow_up_status || "none"));
      tr.addEventListener("click", () => open(c.id));
      tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(c.id); } });
      rows.append(tr);
    }
  }

  async function open(id) {
    selected = id;
    [...rows.children].forEach(r => r.classList.toggle("sel", +r.dataset.id === id));
    let c;
    try { c = await Api.getCall(id); } catch { c = calls.find(x => x.id === id); }
    if (!c) return;
    detail.replaceChildren();
    detail.append(el("h2", "", `Call #${c.id}`));

    const kv = el("dl", "kv");
    const add = (k, v) => { kv.append(el("dt", "", k), el("dd", "", v)); };
    add("Reference", refNo(c.id)); add("Started", when(c.started_at)); add("Duration", duration(c)); add("Input", c.input_mode || "—");
    add("Intent", label(c.main_intent)); add("Outcome", c.outcome);
    add("Escalation", c.escalation_reason || "none"); add("Follow-up", c.follow_up_status || "none");
    add("Summary", c.summary || "—");
    detail.append(kv);

    if (c.follow_up_status && c.follow_up_status !== "none") {
      const b = el("button", "btn primary", "Mark follow-up as done");
      b.addEventListener("click", async () => { b.disabled = true; await Api.markDone(c.id); await load(); });
      detail.append(b);
    }

    detail.append(el("h2", "", "Transcript"));
    const t = el("div", "transcript"); t.setAttribute("role", "log");
    for (const m of c.messages || []) {
      const d = el("div", `msg ${m.speaker === "customer" ? "customer" : "agent"}`, m.text);
      if (m.intent && m.speaker !== "customer" && m.intent !== "unknown") d.append(el("small", "", label(m.intent)));
      t.append(d);
    }
    detail.append(t);
  }

  /* ---------- evaluation panel ----------
     Reads /api/evaluation, else eval_results.json next to this page. Expected shape:
     { "run_at": "2026-11-05", "labels": ["order_status", ..., "unknown"],
       "confusion": [[...]],            // rows = actual, columns = predicted
       "escalation_precision": 1.0, "escalation_recall": 1.0,   // from your evaluation script
       "intent_accuracy": 0.92, "fallback_rate": 0.08,           // optional: computed from the matrix if missing
       "baseline_accuracy": 0.85 }                                // optional: "before" number for the report */
  const SAMPLE_EVAL = {
    sample: true,
    labels: ["order_status", "business_hours", "human_agent", "return_policy", "shipping_info", "unknown"],
    confusion: [[11,0,0,0,1,0],[0,10,0,0,0,0],[0,0,9,0,0,1],[0,0,0,9,1,0],[0,0,0,1,8,0],[0,0,1,0,0,8]],
    escalation_precision: 1, escalation_recall: 1,
  };
  async function loadEval() {
    let d = null;
    for (const u of ["/api/evaluation", "eval_results.json"]) {
      try { const r = await fetch(u); if (r.ok) { d = await r.json(); break; } } catch {}
    }
    renderEval(d || SAMPLE_EVAL);
  }
  function renderEval(d) {
    const labels = d.labels || [], m = d.confusion || [];
    let total = 0, right = 0, unk = 0; const ui = labels.indexOf("unknown");
    m.forEach((row, i) => row.forEach((v, j) => { total += v; if (i === j) right += v; if (j === ui) unk += v; }));
    const acc = d.intent_accuracy ?? (total ? right / total : null);
    const fb = d.fallback_rate ?? (total && ui >= 0 ? unk / total : null);
    const pct = v => (v == null ? "—" : (v * 100).toFixed(1) + "%");
    const tag = $("ev-tag");
    tag.textContent = d.sample ? "Sample data: run your evaluation script" : (d.run_at ? "Run: " + d.run_at : "Latest run");
    tag.className = "pill" + (d.sample ? " warn" : "");
    const tiles = [
      ["Intent accuracy", pct(acc), "Target ≥ 90%" + (d.baseline_accuracy != null ? ` · before: ${pct(d.baseline_accuracy)}` : ""), acc == null ? "" : acc >= 0.9 ? "good" : "bad"],
      ["Escalation recall", pct(d.escalation_recall), "Target 100% of sensitive cases", d.escalation_recall == null ? "" : d.escalation_recall >= 1 ? "good" : "bad"],
      ["Escalation precision", pct(d.escalation_precision), "Fewer needless handoffs", ""],
      ["Fallback rate", pct(fb), "Share answered “unknown”", ""],
    ];
    const box = $("ev-tiles"); box.replaceChildren();
    for (const [name, val, note, cls] of tiles) {
      const t = el("div", "evtile"); t.append(el("span", "", name), el("b", "", val), el("span", "", note));
      if (cls) t.append(el("span", "pill " + cls, cls === "good" ? "meets target" : "below target"));
      box.append(t);
    }
    const tb = $("ev-matrix"); tb.replaceChildren();
    const head = el("tr"); head.append(el("th", "", "actual \\ predicted")); labels.forEach(l => head.append(el("th", "", label(l)))); 
    tb.append(el("thead")); tb.firstChild.append(head);
    const body = el("tbody");
    m.forEach((row, i) => {
      const rt = row.reduce((a, b) => a + b, 0) || 1, tr = el("tr"); tr.append(el("th", "", label(labels[i])));
      row.forEach((v, j) => {
        const td = el("td", "cell", String(v)); const a = Math.round((v / rt) * 70);
        if (v) td.style.background = `color-mix(in srgb, var(${i === j ? "--good" : "--bad"}) ${a + 10}%, transparent)`;
        else td.style.color = "var(--muted)";
        tr.append(td);
      });
      body.append(tr);
    });
    tb.append(body);
  }

  ["f-intent", "f-outcome", "f-follow"].forEach(id => $(id).addEventListener("change", load));
  $("refresh").addEventListener("click", load);
  document.addEventListener("api-mock", () => { if (!$("mock-note")) { const s = el("div", "pill warn", "Demo mode: backend not connected"); s.id = "mock-note"; document.querySelector(".topbar nav").prepend(s); } });
  load();
  loadEval();
})();
