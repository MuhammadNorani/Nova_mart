/** Customer call page: session lifecycle, speech in/out, live transcript, text fallback. */
(() => {
  const $ = id => document.getElementById(id);
  const el = {
    consent: $("consent"), banner: $("banner"), dot: $("dot"), statusText: $("status-text"), timer: $("timer"),
    modePill: $("mode-pill"), mute: $("mute"), replay: $("replay"), end: $("end"), transcript: $("transcript"),
    empty: $("empty"), mic: $("mic"), form: $("text-form"), input: $("text-input"), send: $("send"),
    summary: $("summary"), summaryBody: $("summary-body"), voiceSupport: $("voice-support"),
    startVoice: $("start-voice"), startText: $("start-text"), newCall: $("new-call"),
    chips: $("chips"), summaryTitle: $("summary-title"),
  };
  const refNo = id => "NM-" + String(id).padStart(5, "0");

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canSpeak = "speechSynthesis" in window;

  let sessionId = null, mode = "text", active = false, busy = false;
  let muted = false, lastReply = "", recog = null, listening = false, interimEl = null;
  let timerId = null, startedAt = 0;

  /* ---------- helpers ---------- */
  function banner(msg) { el.banner.textContent = msg || ""; el.banner.hidden = !msg; }
  function setStatus(text, cls) { el.statusText.textContent = text; el.dot.className = "dot " + (cls || ""); }
  function scroll() { el.transcript.scrollTop = el.transcript.scrollHeight; }
  function ctrl(on) {
    el.end.disabled = !on; el.input.disabled = !on; el.send.disabled = !on;
    el.mute.disabled = !on || !canSpeak; el.replay.disabled = !on || !canSpeak;
    el.mic.disabled = !on || !SR || mode !== "voice";
    el.chips.querySelectorAll("button").forEach(b => (b.disabled = !on));
  }
  function fmt(s) { return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }

  function addMsg(who, text, extra = {}) {
    if (el.empty) { el.empty.remove(); el.empty = null; }
    const d = document.createElement("div");
    d.className = `msg ${who}` + (extra.escalated ? " escalated" : "");
    d.textContent = text;
    const note = [];
    if (extra.escalated) note.push("Handed off to a human" + (extra.reason ? ": " + extra.reason : ""));
    else if (extra.intent && who === "agent" && extra.intent !== "unknown") note.push(extra.intent.replace("_", " "));
    if (note.length) { const s = document.createElement("small"); s.textContent = note.join(" · "); d.appendChild(s); }
    el.transcript.appendChild(d); scroll();
    return d;
  }

  /* ---------- speech out ---------- */
  function speak(text) {
    lastReply = text;
    if (!canSpeak || muted) return Promise.resolve();
    return new Promise(res => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; u.onend = res; u.onerror = res;
      setStatus("Assistant speaking…", "live");
      speechSynthesis.speak(u);
    });
  }

  /* ---------- speech in ---------- */
  function initRecognition() {
    if (!SR) return null;
    const r = new SR();
    r.lang = "en-US"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    r.onstart = () => { listening = true; el.mic.classList.add("on"); el.mic.setAttribute("aria-pressed", "true"); el.mic.textContent = "⏹ Listening… tap to stop"; setStatus("Listening…", "listening"); };
    r.onresult = e => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      if (interim && !final) {
        if (!interimEl) interimEl = addMsg("customer", interim);
        interimEl.classList.add("interim"); interimEl.textContent = interim; scroll();
      }
      if (final) { if (interimEl) { interimEl.remove(); interimEl = null; } submit(final.trim(), true); }
    };
    r.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") fallbackToText("Microphone access was denied, so we switched to text mode. You can keep going by typing.");
      else if (e.error === "no-speech") banner("I didn't hear anything. Tap the mic and try again, or type your message.");
      else if (e.error !== "aborted") banner("Speech recognition had a problem (" + e.error + "). You can type instead.");
    };
    r.onend = () => {
      listening = false; el.mic.classList.remove("on"); el.mic.setAttribute("aria-pressed", "false");
      el.mic.textContent = "🎤 Tap to speak";
      if (interimEl) { interimEl.remove(); interimEl = null; }
      if (active && !busy) setStatus("Connected", "live");
    };
    return r;
  }

  function fallbackToText(msg) {
    mode = "text"; banner(msg);
    try { recog && recog.abort(); } catch {}
    el.mic.disabled = true; el.modePill.textContent = "Text mode"; el.modePill.className = "pill warn";
    el.input.focus();
  }

  function toggleMic() {
    if (!active || busy) return;
    if (canSpeak) speechSynthesis.cancel();
    banner("");
    if (listening) { recog.stop(); return; }
    try { recog.start(); } catch { /* already started */ }
  }

  /* ---------- session ---------- */
  async function startCall(chosen) {
    mode = chosen === "voice" && SR ? "voice" : "text";
    el.consent.hidden = true; banner(""); el.summary.hidden = true;
    try {
      const r = await Api.startSession({ input_mode: mode, consent_shown: true });
      sessionId = r.session_id; active = true;
      el.modePill.hidden = false;
      el.modePill.textContent = mode === "voice" ? "Voice mode" : "Text mode";
      el.modePill.className = "pill" + (mode === "text" ? " warn" : "");
      if (mode === "voice") recog = initRecognition();
      ctrl(true); setStatus("Connected", "live");
      startedAt = Date.now(); timerId = setInterval(() => (el.timer.textContent = fmt(Math.floor((Date.now() - startedAt) / 1000))), 500);
      addMsg("system", "Call started. You are speaking with an automated assistant.");
      addMsg("agent", r.greeting);
      // The landing page already spoke the greeting; don't repeat it on the first call.
      let greeted = false;
      try { greeted = sessionStorage.getItem("greeted") === "1"; sessionStorage.removeItem("greeted"); } catch {}
      if (greeted) lastReply = r.greeting; else await speak(r.greeting);
      if (active) setStatus("Connected", "live");
      (mode === "voice" ? el.mic : el.input).focus();
    } catch (e) {
      banner("Couldn't start the call. Please try again.");
      el.consent.hidden = false;
    }
  }

  /* Spoken order numbers are easy to mishear, so confirm them before looking anything up. */
  function askConfirm(text, no) {
    if (el.empty) { el.empty.remove(); el.empty = null; }
    const box = document.createElement("div"); box.className = "confirm";
    const q = document.createElement("div"); q.textContent = `I heard order number ${no}. Is that right?`;
    const row = document.createElement("div"); row.className = "row";
    const yes = document.createElement("button"); yes.className = "btn primary"; yes.textContent = "Yes, that's right";
    const no_ = document.createElement("button"); no_.className = "btn"; no_.textContent = "No, try again";
    row.append(yes, no_); box.append(q, row); el.transcript.appendChild(box); scroll();
    yes.addEventListener("click", () => { box.remove(); submit(text, false); });
    no_.addEventListener("click", () => { box.remove(); addMsg("system", "Okay. Please say or type the order number again."); });
  }

  const STEPS = ["processing", "shipped", "delivered"];
  function addOrderCard(o) {
    const card = document.createElement("div"); card.className = "ordercard";
    const h = document.createElement("h3"); h.textContent = `Order #${o.order_no} · ${o.item}`;
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = o.status === "cancelled" ? "This order was cancelled." : `Status: ${o.status} · Expected: ${o.expected}`;
    card.append(h);
    if (o.status === "cancelled") { const p = document.createElement("span"); p.className = "pill bad"; p.textContent = "cancelled"; card.append(p); }
    else {
      const steps = document.createElement("div"); steps.className = "steps";
      const cur = STEPS.indexOf(o.status);
      STEPS.forEach((s, i) => { const d = document.createElement("div"); d.className = "step" + (i <= cur ? " done" : "") + (i === cur ? " cur" : ""); d.textContent = s; steps.append(d); });
      card.append(steps);
    }
    card.append(meta); el.transcript.appendChild(card); scroll();
  }

  async function submit(text, fromVoice) {
    if (!active || busy || !text) return;
    if (fromVoice) { const no = Api.extractOrder(text); if (no) { askConfirm(text, no); return; } }
    busy = true; el.input.value = "";
    addMsg("customer", text);
    setStatus("Thinking…", "live");
    try {
      const r = await Api.sendMessage(sessionId, text);
      addMsg("agent", r.reply, { intent: r.intent, escalated: r.escalated, reason: r.reason });
      if (r.order) addOrderCard(r.order);
      await speak(r.reply);
      if (r.escalated || r.end) { busy = false; await endCall(); return; }
    } catch (e) {
      addMsg("system", "Something went wrong sending that. Please try again.");
    }
    busy = false;
    if (active) setStatus("Connected", "live");
  }

  async function endCall() {
    if (!active) return;
    active = false; busy = false;
    try { recog && recog.abort(); } catch {}
    if (canSpeak) speechSynthesis.cancel();
    clearInterval(timerId); ctrl(false); setStatus("Call ended", "");
    el.summary.classList.remove("handoff"); el.summaryTitle.textContent = "Call ended";
    try {
      const r = await Api.endSession(sessionId);
      const handoff = r.outcome === "escalated";
      el.summary.classList.toggle("handoff", handoff);
      el.summaryBody.replaceChildren();
      const pill = document.createElement("span");
      pill.className = "pill " + (r.outcome === "resolved" ? "good" : handoff ? "warn" : "bad"); pill.textContent = r.outcome;
      const p0 = document.createElement("p"); p0.append(pill); el.summaryBody.append(p0);
      const t = document.createElement("p");
      if (handoff) {
        el.summaryTitle.textContent = "Handed off to our team";
        t.textContent = "A member of our team will follow up with you. We can't promise a specific time.";
        const ref = document.createElement("p"); ref.className = "ref";
        ref.textContent = "Reference: " + refNo(sessionId) + (r.escalation_reason ? " · Reason: " + r.escalation_reason : "");
        el.summaryBody.append(t, ref);
      } else if (r.summary) { t.textContent = r.summary; el.summaryBody.append(t); }
    } catch { el.summaryBody.textContent = "Your call has ended."; }
    el.summary.hidden = false; el.summary.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function reset() {
    el.transcript.innerHTML = '<div class="empty" id="empty">Your live transcript will appear here once the call starts.</div>';
    el.empty = $("empty"); el.timer.textContent = "00:00"; el.modePill.hidden = true;
    el.summary.hidden = true; el.summary.classList.remove("handoff"); setStatus("Not connected", ""); banner("");
    el.consent.hidden = false; el.startVoice.focus();
  }

  /* ---------- wiring ---------- */
  el.startVoice.addEventListener("click", () => startCall("voice"));
  el.startText.addEventListener("click", () => startCall("text"));
  el.newCall.addEventListener("click", reset);
  el.chips.addEventListener("click", e => { const b = e.target.closest("button[data-say]"); if (b && !b.disabled) submit(b.dataset.say); });
  el.end.addEventListener("click", endCall);
  el.mic.addEventListener("click", toggleMic);
  el.form.addEventListener("submit", e => { e.preventDefault(); submit(el.input.value.trim()); });
  el.replay.addEventListener("click", () => { if (lastReply && canSpeak) { const m = muted; muted = false; speak(lastReply).then(() => { muted = m; setStatus("Connected", "live"); }); } });
  el.mute.addEventListener("click", () => {
    muted = !muted; el.mute.setAttribute("aria-pressed", muted); el.mute.textContent = muted ? "Unmute voice" : "Mute voice";
    if (muted && canSpeak) speechSynthesis.cancel();
  });
  document.addEventListener("api-mock", () => { if (!document.getElementById("mock-note")) { const s = document.createElement("div"); s.id = "mock-note"; s.className = "pill warn"; s.textContent = "Demo mode: backend not connected"; document.querySelector(".topbar nav").prepend(s); } });
  window.addEventListener("beforeunload", () => { if (canSpeak) speechSynthesis.cancel(); });

  if (!SR) { el.startVoice.disabled = true; el.voiceSupport.hidden = false; }
  el.startVoice.focus();
})();
