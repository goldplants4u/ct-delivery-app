/**
 * CT Delivery App — frontend logic (Hours 3-6 of the 8-hour build plan)
 *
 * Screens: login -> route list -> stop detail -> exceptions -> signature -> (back to route list)
 * Data: manifest_2026-09-23.json + pins.json, both static files shipped alongside this page
 *       (see Code.gs and PROJECT-NOTES.md for why the manifest is a static file, not a Sheet read).
 *
 * ====================================================================
 * SETUP STEP YOU STILL NEED TO DO: paste your Apps Script /exec URL
 * below (from Extensions > Apps Script > Deploy > Web app, after
 * pasting in Code.gs). Until this is a real URL, submits will fail
 * and queue offline (which is safe, but nothing reaches the Sheet).
 * ====================================================================
 */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbydrIdUUOPO617n9eaXuiKYKjbfK4GaeAezsWVF9JQSMjARFiEyrVXFQlQMAfnrQcmn_Q/exec";

const MANIFEST_FILE = "manifest_2026-09-23.json";
const PINS_FILE = "pins.json";
const STORAGE_KEY_STATE = "ct_driver_state_v1";
const STORAGE_KEY_QUEUE = "ct_offline_queue_v1";

// ---------- app state ----------
let manifest = null;
let pins = null;
let selectedTruck = null;   // truck chosen on login screen, before PIN is confirmed
let currentTruck = null;    // truck the driver is logged into
let currentStop = null;     // the stop object currently open in stop/exceptions/signature screens
let flaggedItems = {};      // idx -> {item_code, item_name, size, qty, reason, qty_change, notes}
let sigPad = { ctx: null, drawing: false, hasStroke: false };

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireLoginScreen();
  wireRouteScreen();
  wireStopScreen();
  wireExceptionsScreen();
  wireSignatureScreen();
  setupSignaturePad();

  try {
    const [manifestRes, pinsRes] = await Promise.all([
      fetch(MANIFEST_FILE, { cache: "no-store" }),
      fetch(PINS_FILE, { cache: "no-store" }),
    ]);
    manifest = await manifestRes.json();
    pins = await pinsRes.json();
    applyStoredDriverState_();
  } catch (err) {
    showToast("Could not load today's manifest. Check your connection and reload.");
    console.error("manifest/pins load failed", err);
    return;
  }

  document.getElementById("login-date").textContent = formatDispatchDate_(manifest.dispatch_date);

  updateQueueBanner_();
  window.addEventListener("online", () => flushOfflineQueue_());
  // also try once on load in case there's a leftover queue from a prior offline session
  flushOfflineQueue_();
}

// ==================================================================
// LOGIN SCREEN
// ==================================================================
function wireLoginScreen() {
  const truckSelect = document.getElementById("truck-select");
  const pinInput = document.getElementById("pin-input");
  const loginBtn = document.getElementById("login-btn");
  const loginError = document.getElementById("login-error");

  truckSelect.querySelectorAll("button[data-truck]").forEach((btn) => {
    btn.addEventListener("click", () => {
      truckSelect.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedTruck = btn.getAttribute("data-truck");
      loginError.textContent = "";
      updateLoginBtnState_();
    });
  });

  pinInput.addEventListener("input", () => {
    // digits only
    pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
    loginError.textContent = "";
    updateLoginBtnState_();
  });

  loginBtn.addEventListener("click", () => {
    const enteredPin = pinInput.value.trim();
    const realPin = pins && pins[selectedTruck];
    if (!selectedTruck || !enteredPin) return;

    if (!realPin || enteredPin !== realPin) {
      loginError.textContent = "Wrong PIN for " + selectedTruck + ". Try again.";
      pinInput.value = "";
      updateLoginBtnState_();
      return;
    }

    currentTruck = selectedTruck;
    pinInput.value = "";
    loginError.textContent = "";
    openRouteScreen_();
  });

  function updateLoginBtnState_() {
    loginBtn.disabled = !(selectedTruck && pinInput.value.trim().length >= 4);
  }
}

// ==================================================================
// ROUTE LIST SCREEN
// ==================================================================
function wireRouteScreen() {
  document.getElementById("logout-btn").addEventListener("click", () => {
    currentTruck = null;
    selectedTruck = null;
    document.getElementById("truck-select").querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
    document.getElementById("login-btn").disabled = true;
    showScreen_("screen-login");
  });
}

function openRouteScreen_() {
  document.getElementById("route-truck-title").textContent = currentTruck;
  document.getElementById("route-date-sub").textContent = formatDispatchDate_(manifest.dispatch_date);
  renderRouteList_();
  showScreen_("screen-route");
}

function renderRouteList_() {
  const list = document.getElementById("route-list");
  list.innerHTML = "";

  const stops = manifest.stops.filter((s) => s.truck === currentTruck);
  if (stops.length === 0) {
    list.innerHTML = '<p class="hint">No stops found for ' + currentTruck + ' today.</p>';
    return;
  }

  stops.forEach((stop) => {
    const status = (stop.driver_state && stop.driver_state.status) || "pending";
    const card = document.createElement("div");
    card.className = "stop-card " + statusToClass_(status);

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = stop.customer_name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = stopMetaLine_(stop);
    left.appendChild(name);
    left.appendChild(meta);

    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = statusToLabel_(status);

    card.appendChild(left);
    card.appendChild(pill);

    card.addEventListener("click", () => openStopScreen_(stop));
    list.appendChild(card);
  });
}

function stopMetaLine_(stop) {
  const orderCount = stop.orders ? stop.orders.length : 0;
  const orderWord = orderCount === 1 ? "order" : "orders";
  const racks = stop.racks_expected != null ? stop.racks_expected + " rack" + (stop.racks_expected === 1 ? "" : "s") : "?";
  return orderCount + " " + orderWord + " · " + racks + " expected · " + (stop.address || "");
}

function statusToClass_(status) {
  if (status === "done_clean") return "done-clean";
  if (status === "done_exceptions") return "done-exceptions";
  return "pending";
}
function statusToLabel_(status) {
  if (status === "done_clean") return "Delivered";
  if (status === "done_exceptions") return "Exceptions";
  return "Pending";
}

// ==================================================================
// STOP DETAIL SCREEN
// ==================================================================
function wireStopScreen() {
  document.getElementById("stop-back-btn").addEventListener("click", () => {
    renderRouteList_();
    showScreen_("screen-route");
  });

  const racksInput = document.getElementById("racks-unloaded-input");
  racksInput.addEventListener("input", () => {
    const btn = document.getElementById("to-exceptions-btn");
    btn.disabled = racksInput.value === "" || Number(racksInput.value) < 0;
    renderStopWarnings_();
  });

  document.getElementById("to-exceptions-btn").addEventListener("click", () => {
    if (!currentStop) return;
    currentStop._racksUnloadedEntered = Number(document.getElementById("racks-unloaded-input").value);
    openExceptionsScreen_(currentStop);
  });
}

function openStopScreen_(stop) {
  currentStop = stop;
  flaggedItems = {};

  document.getElementById("stop-name").textContent = stop.customer_name;

  const orderNums = (stop.orders || []).map((o) => o.order_number).join(", ");
  document.getElementById("stop-meta").textContent =
    stop.address + " · Order" + ((stop.orders || []).length === 1 ? "" : "s") + " " + orderNums +
    " · " + (stop.payment_terms || "");

  renderLineItemsTable_(stop);

  document.getElementById("racks-expected-label").textContent = stop.racks_expected != null ? stop.racks_expected : "-";
  const racksInput = document.getElementById("racks-unloaded-input");
  const savedRacks = stop.driver_state && stop.driver_state.racks_unloaded;
  racksInput.value = savedRacks != null ? savedRacks : "";
  document.getElementById("to-exceptions-btn").disabled = racksInput.value === "";

  renderStopWarnings_();
  showScreen_("screen-stop");
}

function getLineItems_(stop) {
  // Combined multi-order stops carry line_items_combined; single-order stops
  // carry line_items on their one order. Swanson's-style gap (an order whose
  // line_items is a string note, not an array) is surfaced as a warning,
  // not silently dropped or fabricated — see PROJECT-NOTES.md section 2.
  if (Array.isArray(stop.line_items_combined)) return stop.line_items_combined;
  if (stop.orders && stop.orders.length === 1 && Array.isArray(stop.orders[0].line_items)) {
    return stop.orders[0].line_items;
  }
  // Multi-order stop with no combined list (Swanson's case): gather whatever
  // arrays exist across its orders.
  const items = [];
  (stop.orders || []).forEach((o) => {
    if (Array.isArray(o.line_items)) items.push(...o.line_items);
  });
  return items;
}

function getMissingLineItemOrders_(stop) {
  return (stop.orders || []).filter((o) => typeof o.line_items === "string");
}

function getStopTotal_(stop) {
  if (stop.true_total != null) return stop.true_total;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].total != null) return stop.orders[0].total;
  return null;
}

function renderLineItemsTable_(stop) {
  const items = getLineItems_(stop);
  const table = document.getElementById("line-items-table");
  table.innerHTML = "";

  const thead = document.createElement("tr");
  ["Qty", "Item", "Size"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    thead.appendChild(th);
  });
  table.appendChild(thead);

  items.forEach((item) => {
    const row = document.createElement("tr");
    const tdQty = document.createElement("td");
    tdQty.textContent = item.qty;
    const tdName = document.createElement("td");
    tdName.textContent = item.item_name + (item.item_code ? " (" + item.item_code + ")" : "");
    const tdSize = document.createElement("td");
    tdSize.textContent = item.size || "";
    row.appendChild(tdQty);
    row.appendChild(tdName);
    row.appendChild(tdSize);
    table.appendChild(row);
  });

  const total = getStopTotal_(stop);
  if (total != null) {
    const totalRow = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.colSpan = 2;
    tdLabel.style.fontWeight = "700";
    tdLabel.textContent = "Total";
    const tdVal = document.createElement("td");
    tdVal.style.fontWeight = "700";
    tdVal.textContent = "$" + total.toFixed(2);
    totalRow.appendChild(tdLabel);
    totalRow.appendChild(tdVal);
    table.appendChild(totalRow);
  }
}

function renderStopWarnings_(stop) {
  stop = stop || currentStop;
  if (!stop) return;
  const box = document.getElementById("stop-warnings");
  box.innerHTML = "";
  const warnings = [];

  if (stop.total_discrepancy_note) {
    warnings.push("Billing note (office to confirm): " + stop.total_discrepancy_note);
  }
  const missingOrders = getMissingLineItemOrders_(stop);
  if (missingOrders.length > 0) {
    missingOrders.forEach((o) => {
      warnings.push("Order " + o.order_number + " — line items not available on this device (" + o.line_items + ").");
    });
  }
  if (stop.email_gap_note) {
    warnings.push(stop.email_gap_note);
  }
  if (stop.delivery_instructions) {
    warnings.push("Delivery instructions: " + stop.delivery_instructions);
  }

  const racksInput = document.getElementById("racks-unloaded-input");
  const entered = racksInput.value === "" ? null : Number(racksInput.value);
  if (entered != null && stop.racks_expected != null && entered !== stop.racks_expected) {
    warnings.push("Racks unloaded (" + entered + ") doesn't match expected (" + stop.racks_expected + "). Flag it as an exception on the next screen if that's correct.");
  }

  warnings.forEach((w) => {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = w;
    box.appendChild(p);
  });
}

// ==================================================================
// EXCEPTIONS SCREEN
// ==================================================================
function wireExceptionsScreen() {
  document.getElementById("exceptions-back-btn").addEventListener("click", () => {
    openStopScreen_(currentStop);
  });
  document.getElementById("to-signature-btn").addEventListener("click", () => {
    openSignatureScreen_(currentStop);
  });
}

function openExceptionsScreen_(stop) {
  document.getElementById("exceptions-stop-name").textContent = stop.customer_name;
  renderItemPickList_(stop);
  renderExceptionForms_();
  showScreen_("screen-exceptions");
}

function renderItemPickList_(stop) {
  const items = getLineItems_(stop);
  const list = document.getElementById("item-pick-list");
  list.innerHTML = "";

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "item-pick-row";

    const label = document.createElement("span");
    label.textContent = item.qty + "x " + item.item_name + (item.size ? " (" + item.size + ")" : "");

    const btn = document.createElement("button");
    btn.className = "flag";
    btn.textContent = flaggedItems[idx] ? "Flagged" : "Flag";
    if (flaggedItems[idx]) btn.classList.add("active");

    btn.addEventListener("click", () => {
      if (flaggedItems[idx]) {
        delete flaggedItems[idx];
      } else {
        flaggedItems[idx] = {
          item_code: item.item_code || "",
          item_name: item.item_name,
          size: item.size || "",
          qty: item.qty,
          reason: "Rejected",
          qty_change: item.qty,
          notes: "",
        };
      }
      btn.classList.toggle("active");
      btn.textContent = flaggedItems[idx] ? "Flagged" : "Flag";
      renderExceptionForms_();
    });

    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  });

  if (items.length === 0) {
    list.innerHTML = '<p class="hint">No line items on file for this stop — see the note on the previous screen.</p>';
  }
}

function renderExceptionForms_() {
  const box = document.getElementById("exception-forms");
  box.innerHTML = "";

  const idxs = Object.keys(flaggedItems);
  if (idxs.length === 0) {
    box.innerHTML = '<p class="hint">Nothing flagged yet.</p>';
    return;
  }

  idxs.forEach((idx) => {
    const ex = flaggedItems[idx];
    const row = document.createElement("div");
    row.className = "exception-row";

    const title = document.createElement("strong");
    title.textContent = ex.item_name;
    row.appendChild(title);

    const reasonSelect = document.createElement("select");
    ["Rejected", "Short", "Damaged", "Substituted", "Other"].forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      if (ex.reason === r) opt.selected = true;
      reasonSelect.appendChild(opt);
    });
    reasonSelect.addEventListener("change", () => { ex.reason = reasonSelect.value; });
    row.appendChild(reasonSelect);

    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.min = "0";
    qtyInput.placeholder = "Qty affected";
    qtyInput.value = ex.qty_change != null ? ex.qty_change : "";
    qtyInput.addEventListener("input", () => { ex.qty_change = Number(qtyInput.value); });
    row.appendChild(qtyInput);

    const notesInput = document.createElement("textarea");
    notesInput.placeholder = "Notes (optional)";
    notesInput.rows = 2;
    notesInput.value = ex.notes || "";
    notesInput.addEventListener("input", () => { ex.notes = notesInput.value; });
    row.appendChild(notesInput);

    box.appendChild(row);
  });
}

// ==================================================================
// SIGNATURE SCREEN
// ==================================================================
function wireSignatureScreen() {
  document.getElementById("signature-back-btn").addEventListener("click", () => {
    openExceptionsScreen_(currentStop);
  });
  document.getElementById("clear-sig-btn").addEventListener("click", clearSignaturePad_);
  document.getElementById("submit-btn").addEventListener("click", () => submitStop_(true));
  document.getElementById("skip-sig-btn").addEventListener("click", () => submitStop_(false));
}

function openSignatureScreen_(stop) {
  isSubmitting = false;
  document.getElementById("submit-btn").disabled = false;
  document.getElementById("skip-sig-btn").disabled = false;
  document.getElementById("signature-stop-name").textContent = stop.customer_name;
  showScreen_("screen-signature");
  // The canvas lives inside a ".screen" that is "display:none" until now, so
  // getBoundingClientRect() would return 0x0 (and toDataURL() an empty image)
  // if we sized it back at DOMContentLoaded time. Size it here instead, now
  // that the screen is actually visible, then clear it for this stop.
  resizeSignaturePad_();
  clearSignaturePad_();
}

let resizeSignaturePad_ = function () {};

function setupSignaturePad() {
  const canvas = document.getElementById("sig-pad");
  const ctx = canvas.getContext("2d");
  sigPad.ctx = ctx;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // screen not visible yet — skip, caller retries when it is
    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1a1a";
  }
  resizeSignaturePad_ = resize;
  resize();
  window.addEventListener("resize", resize);
  function pos(evt) {
    const rect = canvas.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }

  function start(evt) {
    evt.preventDefault();
    sigPad.drawing = true;
    sigPad.hasStroke = true;
    const p = pos(evt);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(evt) {
    if (!sigPad.drawing) return;
    evt.preventDefault();
    const p = pos(evt);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function end(evt) {
    if (evt) evt.preventDefault();
    sigPad.drawing = false;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end, { passive: false });
}

function clearSignaturePad_() {
  const canvas = document.getElementById("sig-pad");
  const ctx = sigPad.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sigPad.hasStroke = false;
}

// ==================================================================
// SUBMIT
// ==================================================================
let isSubmitting = false; // guards against a double-tap firing two submits for one stop

async function submitStop_(wantsSignature) {
  if (!currentStop || isSubmitting) return;
  isSubmitting = true;
  document.getElementById("submit-btn").disabled = true;
  document.getElementById("skip-sig-btn").disabled = true;

  const racksUnloaded = currentStop._racksUnloadedEntered;
  const exceptions = Object.values(flaggedItems).map((ex) => ({
    item_code: ex.item_code,
    item_name: ex.item_name,
    reason: ex.reason,
    qty_change: ex.qty_change,
    notes: ex.notes,
  }));
  const hasSignature = wantsSignature && sigPad.hasStroke;
  const signatureImage = hasSignature ? document.getElementById("sig-pad").toDataURL("image/png") : null;

  // Everything below racks_unloaded is extra context so the backend (Hour 7)
  // can build a proof-of-delivery PDF without a second lookup — the backend
  // only ever sees a Sheet, not this static manifest file. Deliberately NOT
  // included: total_discrepancy_note / printed_subtotal_on_pdf — that's an
  // internal billing note about our own PDF export bug (see PROJECT-NOTES.md)
  // and must never end up on a document or email sent to the customer.
  const payload = {
    action: "submit_stop",
    date: manifest.dispatch_date,
    truck: currentStop.truck,
    stop_id: currentStop.stop_id,
    customer_name: currentStop.customer_name,
    address: currentStop.address || "",
    payment_terms: currentStop.payment_terms || "",
    order_numbers: (currentStop.orders || []).map((o) => o.order_number),
    racks_expected: currentStop.racks_expected,
    racks_unloaded: racksUnloaded,
    line_items: getLineItems_(currentStop).map((li) => ({
      qty: li.qty,
      item_code: li.item_code || "",
      item_name: li.item_name,
      size: li.size || "",
    })),
    total: getStopTotal_(currentStop),
    exceptions: exceptions,
    signature_captured: hasSignature,
    signature_image: signatureImage,
    contact_emails: currentStop.contact_emails || [],
    submitted_at_iso: new Date().toISOString(),
  };

  const newStatus = exceptions.length > 0 ? "done_exceptions" : "done_clean";
  saveDriverStateLocal_(currentStop.stop_id, {
    racks_unloaded: racksUnloaded,
    exceptions: exceptions,
    signature_image: signatureImage,
    signed_at: payload.submitted_at_iso,
    status: newStatus,
  });
  applyStoredDriverState_();

  const sentOk = await sendToBackend_(payload);
  if (sentOk) {
    showToast("Delivery submitted — " + currentStop.customer_name);
  } else {
    queueOffline_(payload);
    showToast("No signal — saved on this device, will send when back online.");
  }

  currentStop = null;
  flaggedItems = {};
  renderRouteList_();
  showScreen_("screen-route");
}

async function sendToBackend_(payload) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) {
    return false; // not configured yet — treat as offline so nothing is silently lost
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      // text/plain avoids a CORS preflight that Apps Script Web Apps can't answer —
      // see the CORS note at the top of Code.gs. The body is still JSON text.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.ok;
  } catch (err) {
    console.warn("submit failed, will queue offline", err);
    return false;
  }
}

// ==================================================================
// OFFLINE QUEUE
// ==================================================================
function queueOffline_(payload) {
  const queue = readQueue_();
  queue.push(payload);
  writeQueue_(queue);
  updateQueueBanner_();
}

function readQueue_() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_QUEUE) || "[]");
  } catch (err) {
    return [];
  }
}
function writeQueue_(queue) {
  try {
    localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(queue));
  } catch (err) {
    console.warn("could not persist offline queue", err);
  }
}

async function flushOfflineQueue_() {
  let queue = readQueue_();
  if (queue.length === 0) {
    updateQueueBanner_();
    return;
  }
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) return;

  const remaining = [];
  for (const payload of queue) {
    const ok = await sendToBackend_(payload);
    if (!ok) remaining.push(payload);
  }
  writeQueue_(remaining);
  updateQueueBanner_();
  if (remaining.length < queue.length) {
    showToast((queue.length - remaining.length) + " queued delivery/deliveries synced.");
  }
}

function updateQueueBanner_() {
  const banner = document.getElementById("queue-banner");
  const count = readQueue_().length;
  if (count === 0) {
    banner.classList.add("hidden");
    banner.textContent = "";
  } else {
    banner.classList.remove("hidden");
    banner.textContent = count + " delivery" + (count === 1 ? "" : "ies") + " waiting to sync — will send automatically when back online.";
  }
}

// ==================================================================
// LOCAL DRIVER-STATE PERSISTENCE
// (This is a static-file frontend with no GET-back from the backend,
// so completed-stop status has to survive a reload locally. The
// Sheet stays the source of truth for the office; this is just what
// paints the route-list pills on this device.)
// ==================================================================
function saveDriverStateLocal_(stopId, state) {
  const all = readDriverStateStore_();
  all[stopId] = state;
  try {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(all));
  } catch (err) {
    console.warn("could not persist driver state", err);
  }
}
function readDriverStateStore_() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE) || "{}");
  } catch (err) {
    return {};
  }
}
function applyStoredDriverState_() {
  const stored = readDriverStateStore_();
  manifest.stops.forEach((stop) => {
    if (stored[stop.stop_id]) {
      stop.driver_state = Object.assign({}, stop.driver_state, stored[stop.stop_id]);
    }
  });
}

// ==================================================================
// HELPERS
// ==================================================================
function showScreen_(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatDispatchDate_(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
