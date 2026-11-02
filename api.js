/**
 * Shared API layer for the call page and the staff dashboard.
 *
 * Expected FastAPI contract (all JSON):
 *   POST /api/sessions                    {input_mode, consent_shown} -> {session_id, greeting}
 *   POST /api/sessions/{id}/message       {text}                       -> {reply, intent, confidence, escalated, reason, end, order?}
 *        order? = {order_no, item, status, expected}, sent when an order was found (shown as a card)
 *   POST /api/sessions/{id}/end           {}                           -> {summary, outcome, main_intent, follow_up_status}
 *   GET  /api/calls?intent=&outcome=&follow_up=                        -> [call_log + session fields]
 *   GET  /api/calls/{id}                                               -> call + messages[]
 *   POST /api/calls/{id}/follow-up        {status: "done"}             -> updated call
 *   GET  /api/evaluation   (optional)                                  -> {labels, confusion, ...} (else staff page reads eval_results.json)
 *
 * If the backend is unreachable (or the URL has ?mock=1) the same calls are
 * served by a small in-browser mock stored in localStorage, so the UI can be
 * built and demoed before the backend is ready.
 */
const NOVA_GREETING = "Hello, I'm Nova Mart's automated assistant. How can I help you today?";

const Api = (() => {
  const params = new URLSearchParams(location.search);  
  let mock = params.has("mock");

  async function http(method, path, body) {
    const res = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function call(method, path, body, mockFn) {
    if (!mock) {
      try { return await http(method, path, body); }
      catch (e) {
        if (!(e instanceof TypeError) && !/HTTP (404|502|503)/.test(e.message)) throw e;
        mock = true; // backend not reachable: fall back
        document.dispatchEvent(new CustomEvent("api-mock"));
      }
    }
    return mockFn();
  }

  /* ---------- mock backend ---------- */
  const ORDERS = {
    "1234": { item: "Wireless headphones", status: "shipped", expected: "October 30" },
    "2345": { item: "27-inch monitor", status: "processing", expected: "November 3" },
    "3456": { item: "USB-C hub", status: "delivered", expected: "delivered October 20" },
    "4567": { item: "Mechanical keyboard", status: "cancelled", expected: "none" },
  };
  const FAQ = {
    business_hours: "We are open Monday to Saturday, 9 AM to 6 PM. We are closed on Sundays.",
    return_policy: "You can return unused items within 14 days of delivery for a replacement or store credit review.",
    shipping_info: "Standard shipping takes 3 to 5 working days. Delivery dates in your order status are estimates.",
  };
  const SENSITIVE = /complain|refund|legal|lawyer|sue|medical|card number|password|abuse|cvv/i;
  const DIGIT_WORDS = { zero:0, oh:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9 };

  const store = {
    load() { try { return JSON.parse(localStorage.getItem("nova_mock") || "null") || { calls: [], next: 1 }; } catch { return { calls: [], next: 1 }; } },
    save(s) { try { localStorage.setItem("nova_mock", JSON.stringify(s)); } catch {} },
  };
  const live = {}; // session_id -> in-memory state

  function maskCards(t) { return t.replace(/\b(?:\d[ -]?){13,16}\b/g, "[card number removed]"); }
  function extractOrder(t) {
    const spoken = t.toLowerCase().split(/\s+/).map(w => (w in DIGIT_WORDS ? DIGIT_WORDS[w] : "")).join("");
    const m = t.replace(/[\s-]/g, "").match(/\d{4}/);
    return m ? m[0] : (spoken.length >= 4 ? spoken.slice(0, 4) : null);
  }
  function detect(text, s) {
    const t = text.toLowerCase();
    if (SENSITIVE.test(t)) return { intent: "sensitive", conf: 0.95 };
    if (/human|person|agent|representative|someone|operator/.test(t)) return { intent: "human_agent", conf: 0.92 };
    if (/order|tracking|package|parcel/.test(t) || (s.awaitingOrder && extractOrder(t))) return { intent: "order_status", conf: 0.9 };
    if (/hour|open|close|when are you/.test(t)) return { intent: "business_hours", conf: 0.9 };
    if (/return|exchange|send back/.test(t)) return { intent: "return_policy", conf: 0.88 };
    if (/ship|deliver/.test(t)) return { intent: "shipping_info", conf: 0.85 };
    return { intent: "unknown", conf: 0.2 };
  }

  const mockApi = {
    start(body) {
      const st = store.load(); const id = st.next++; store.save(st);
      live[id] = { id, started_at: new Date().toISOString(), input_mode: body.input_mode, consent_shown: true,
        messages: [{ speaker: "agent", text: NOVA_GREETING, created_at: new Date().toISOString() }],
        intents: [], fails: 0, awaitingOrder: false, orderTries: 0, escalated: false, reason: null };
      return { session_id: id, greeting: NOVA_GREETING };
    },
    message(id, text) {
      const s = live[id]; const now = () => new Date().toISOString();
      s.messages.push({ speaker: "customer", text: maskCards(text), created_at: now() });
      const { intent, conf } = detect(text, s);
      let reply, escalated = false, reason = null, end = false, order = null;
      const escalate = r => {
        escalated = true; reason = r; s.escalated = true; s.reason = s.reason || r;
        reply = "I'm connecting you with a member of our team. A human will follow up with you.";
      };
      if (intent === "sensitive") escalate("sensitive topic");
      else if (intent === "human_agent") escalate("customer request");
      else if (intent === "order_status") {
        const no = extractOrder(text);
        if (!no || !ORDERS[no]) {
          s.awaitingOrder = true; s.orderTries++;
          if (s.orderTries > 1) escalate("repeated failure");
          else reply = no ? `I couldn't find order ${no}. Could you read the order number again?` : "Sure. What is your four-digit order number?";
        } else {
          const o = ORDERS[no]; s.awaitingOrder = false; s.orderTries = 0;
          reply = `Order ${no}, ${o.item}, is ${o.status}. Expected: ${o.expected}. Is there anything else?`;
          order = { order_no: no, item: o.item, status: o.status, expected: o.expected };
        }
      } else if (FAQ[intent]) reply = FAQ[intent] + " Anything else I can help with?";
      else if (/^(no|nope|that's all|goodbye|bye|thanks|thank you)\b/i.test(text.trim())) { reply = "Thank you for calling Nova Mart. Goodbye!"; end = true; }
      else { s.fails++; if (s.fails >= 2) escalate("repeated failure"); else reply = "Sorry, I didn't quite get that. I can help with order status, opening hours, returns or shipping."; }
      if (intent !== "unknown") s.intents.push(intent);
      s.messages.push({ speaker: "agent", text: reply, intent, confidence: conf, created_at: now() });
      return { reply, intent, confidence: conf, escalated, reason, end, order };
    },
    end(id) {
      const s = live[id]; const st = store.load();
      const main = s.intents[0] || "unknown";
      const outcome = s.escalated ? "escalated" : (s.messages.some(m => m.speaker === "customer") ? "resolved" : "abandoned");
      const ended = new Date().toISOString();
      const summary = `Customer contacted Nova Mart by ${s.input_mode}. Main topic: ${main.replace("_", " ")}. Outcome: ${outcome}${s.reason ? " (" + s.reason + ")" : ""}.`;
      const rec = { id, started_at: s.started_at, ended_at: ended, input_mode: s.input_mode, main_intent: main,
        outcome, escalation_reason: s.reason, summary, follow_up_status: s.escalated ? "human review" : "none", messages: s.messages };
      st.calls.unshift(rec); store.save(st); delete live[id];
      return rec;
    },
    list(q) {
      return store.load().calls.filter(c =>
        (!q.intent || c.main_intent === q.intent) && (!q.outcome || c.outcome === q.outcome) && (!q.follow_up || c.follow_up_status === q.follow_up));
    },
    get(id) { return store.load().calls.find(c => c.id === +id); },
    done(id) { const st = store.load(); const c = st.calls.find(x => x.id === +id); if (c) c.follow_up_status = "none"; store.save(st); return c; },
  };

  const qs = o => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v)); const s = p.toString(); return s ? "?" + s : ""; };
  return {
    get isMock() { return mock; },
    extractOrder,
    startSession: b => call("POST", "/sessions", b, () => mockApi.start(b)),
    sendMessage: (id, text) => call("POST", `/sessions/${id}/message`, { text }, () => mockApi.message(id, text)),
    endSession: id => call("POST", `/sessions/${id}/end`, {}, () => mockApi.end(id)),
    listCalls: q => call("GET", "/calls" + qs(q || {}), null, () => mockApi.list(q || {})),
    getCall: id => call("GET", `/calls/${id}`, null, () => mockApi.get(id)),
    markDone: id => call("POST", `/calls/${id}/follow-up`, { status: "done" }, () => mockApi.done(id)),
  };
})();
