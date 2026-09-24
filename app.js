/**
 * CT Delivery App — frontend logic (Hours 3-6 of the 8-hour build plan)
 *
 * Screens: login -> route list -> stop detail -> exceptions -> signature -> (back to route list)
 * Data: the day's route plan (route/stops/line items/totals) is fetched live from the Apps
 *       Script backend (APPS_SCRIPT_URL + "?action=get_route_plan") — NOT a static file bundled
 *       with this page. That's a deliberate change from the original design: publishing a new
 *       day used to mean uploading a new manifest file to GitHub every single day, which is
 *       exactly what this was changed to avoid. Office runs the Sheet menu's "Create Route
 *       Plan..." (one step — builds AND publishes) and the app picks it up on the driver's next
 *       login — no GitHub involved. See Code.gs's getRoutePlanForRequest_ and PROJECT-NOTES.md.
 *       This fetched data still lives in a JS variable/property named "manifest" throughout
 *       this file below (kept as-is on purpose when the backend was renamed to "route plan" —
 *       purely internal, not worth the diff/regression risk of renaming everywhere for no
 *       user-visible benefit — see PROJECT-NOTES.md).
 *       pins.json (truck PINs) is still a plain static file — those essentially never change.
 *
 * Offline-first: two separate layers, both needed.
 *   1. service-worker.js caches the app SHELL (this file, style.css, index.html,
 *      pins.json) so the page itself still loads with zero signal — even a cold
 *      relaunch, not just staying on an already-open tab. Registered below.
 *   2. The route plan DATA (this changes daily, so it's never put in the
 *      service worker's shell cache) is cached in localStorage after every
 *      successful fetch and re-used if a later fetch fails — see init() below.
 *      This means: load the app once with signal (e.g. at the depot in the
 *      morning), and it keeps working the rest of the day even through dead
 *      zones or a device restart, showing whatever route plan was last
 *      successfully fetched with a clear "offline" notice.
 *
 * ====================================================================
 * SETUP STEP YOU STILL NEED TO DO: paste your Apps Script /exec URL
 * below (from Extensions > Apps Script > Deploy > Web app, after
 * pasting in Code.gs). Until this is a real URL, submits will fail
 * and queue offline (which is safe, but nothing reaches the Sheet) —
 * and the manifest fetch below will fail too, since it uses this same URL.
 * ====================================================================
 */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbydrIdUUOPO617n9eaXuiKYKjbfK4GaeAezsWVF9JQSMjARFiEyrVXFQlQMAfnrQcmn_Q/exec";

const PINS_FILE = "pins.json";
const STORAGE_KEY_STATE = "ct_driver_state_v1";
const STORAGE_KEY_QUEUE = "ct_offline_queue_v1";
const STORAGE_KEY_ROUTE_PLAN_CACHE = "ct_route_plan_cache_v1"; // last successfully fetched {manifest, pins}, for offline fallback

// ---------- app state ----------
let manifest = null;
let pins = null;
let selectedTruck = null;   // truck chosen on login screen, before PIN is confirmed
let currentTruck = null;    // truck the driver is logged into
let currentStop = null;     // the stop object currently open in stop/exceptions/signature screens
let flaggedItems = {};      // idx -> {item_code, item_name, size, qty, reason, qty_change, notes}
let sigPad = { ctx: null, drawing: false, hasStroke: false };
let rackPhotoDataUrl = null; // compressed JPEG data URL of the driver's rack photo for the current stop, or null

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", init);

async function init() {
  registerServiceWorker_();

  wireLoginScreen();
  wireRouteScreen();
  wireStopScreen();
  wireExceptionsScreen();
  wireSignatureScreen();
  wirePhotoCapture();
  setupSignaturePad();

  let loadedFromCache = false;
  try {
    const [manifestRes, pinsRes] = await Promise.all([
      fetch(APPS_SCRIPT_URL + "?action=get_route_plan", { cache: "no-store" }),
      fetch(PINS_FILE, { cache: "no-store" }),
    ]);
    const manifestJson = await manifestRes.json();
    // The backend returns the manifest object directly on success, or
    // {ok:false, error:"..."} when nothing's been published yet for today
    // (or the published one is for a different date) — see
    // getManifestForRequest_ in Code.gs. Surface that message plainly
    // rather than a generic "check your connection", since this failure
    // usually means the office forgot to publish, not a network problem.
    // Deliberately NOT falling back to the offline cache here — an
    // explicit "nothing published" answer from the server is different
    // from a network failure, and showing yesterday's cached route plan
    // in that case would hide a real office mistake instead of surfacing it.
    if (manifestJson && manifestJson.ok === false) {
      showToast(manifestJson.error || "No route plan published for today yet.");
      console.error("manifest fetch returned an error", manifestJson);
      return;
    }
    manifest = manifestJson;
    pins = await pinsRes.json();
    saveRoutePlanCache_(manifest, pins);
    applyStoredDriverState_();
  } catch (err) {
    // Network-level failure (offline, dead zone, etc.) — fall back to the
    // last successfully loaded route plan/pins instead of just erroring
    // out, so the app still works the rest of the day after loading once
    // with signal this morning. See the offline-first note at the top of
    // this file.
    const cached = loadRoutePlanCache_();
    if (cached) {
      manifest = cached.manifest;
      pins = cached.pins;
      loadedFromCache = true;
      applyStoredDriverState_();
    } else {
      showToast("Could not load today's route plan. Check your connection and reload.");
      console.error("manifest/pins load failed, and no offline cache available", err);
      return;
    }
  }

  document.getElementById("login-date").textContent = formatDispatchDate_(manifest.dispatch_date);
  renderTruckSelect_();
  if (loadedFromCache) {
    showToast("Offline — showing the last route plan loaded (" + formatDispatchDate_(manifest.dispatch_date) + ").");
  }

  updateQueueBanner_();
  window.addEventListener("online", () => flushOfflineQueue_());
  // also try once on load in case there's a leftover queue from a prior offline session
  flushOfflineQueue_();
}

// ==================================================================
// LOGIN SCREEN
// ==================================================================
// Truck buttons are NOT hardcoded. renderTruckSelect_() (called from
// init() once the route plan has loaded) builds one button per truck
// that actually has stops in TODAY's published route plan
// (manifest.trucks, set server-side by publishRoutePlan_ in Code.gs).
// This is deliberate, not an oversight: a fixed "Truck 4 / Truck 5"
// list silently left out any other truck ERP-outFuture had assigned
// stops to — found for real when Truck 3 had a full route and wasn't
// selectable at all. A truck still needs an entry in pins.json to
// actually log in (that file is unrelated to which buttons render —
// see its own comment); a truck that shows up in today's route but
// has no pins.json entry yet gets its own clear error at login time
// below, rather than "Wrong PIN."
function renderTruckSelect_() {
  const truckSelect = document.getElementById("truck-select");
  truckSelect.innerHTML = "";

  const trucks = (manifest.trucks || []).slice().sort((a, b) => {
    const na = parseInt((a.match(/\d+/) || ["0"])[0], 10);
    const nb = parseInt((b.match(/\d+/) || ["0"])[0], 10);
    return na - nb;
  });

  if (trucks.length === 0) {
    truckSelect.innerHTML = '<p class="hint">No trucks have stops in today’s route plan.</p>';
    return;
  }

  trucks.forEach((truck) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = truck;
    btn.setAttribute("data-truck", truck);
    btn.addEventListener("click", () => {
      truckSelect.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedTruck = truck;
      document.getElementById("login-error").textContent = "";
      updateLoginBtnState_();
    });
    truckSelect.appendChild(btn);
  });
}

function updateLoginBtnState_() {
  const pinInput = document.getElementById("pin-input");
  const loginBtn = document.getElementById("login-btn");
  loginBtn.disabled = !(selectedTruck && pinInput.value.trim().length >= 4);
}

function wireLoginScreen() {
  const pinInput = document.getElementById("pin-input");
  const loginBtn = document.getElementById("login-btn");
  const loginError = document.getElementById("login-error");

  pinInput.addEventListener("input", () => {
    // digits only
    pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
    loginError.textContent = "";
    updateLoginBtnState_();
  });

  loginBtn.addEventListener("click", () => {
    const enteredPin = pinInput.value.trim();
    if (!selectedTruck || !enteredPin) return;

    if (!pins) {
      // pins never loaded — either today's route plan hasn't been published yet
      // (see init()'s manifest fetch, which returns early before loading pins in
      // that case) or the pins.json/route plan fetch itself failed. Either way,
      // no PIN could ever match here, so saying "Wrong PIN" would be misleading —
      // the actual fix is publishing today's route plan or reloading the page.
      loginError.textContent = "Route data hasn't loaded — check that today's Route Plan has been published, then reload this page.";
      return;
    }

    const realPin = pins[selectedTruck];
    if (!realPin) {
      // Truck showed up as a button (it has real stops today) but pins.json
      // doesn't know about it yet — different problem than a wrong PIN, so
      // it gets its own message per the same rule as the block above.
      loginError.textContent = selectedTruck + " doesn't have a PIN set up yet — add one to pins.json.";
      return;
    }
    if (enteredPin !== realPin) {
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
    const time = document.createElement("div");
    time.className = "time";
    if (stop.delivery_time) {
      time.textContent = stop.delivery_time;
    } else {
      time.textContent = "No time set";
      time.classList.add("unset");
    }
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = stop.customer_name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = stopMetaLine_(stop);
    left.appendChild(time);
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
  // Only clear flagged exceptions when this is actually a different stop
  // (opened fresh from the route list) — not when the driver taps "Back"
  // from the exceptions screen to re-check racks/items on the *same* stop.
  // Resetting unconditionally here used to silently drop already-flagged
  // items on that back-and-forth (see PROJECT-NOTES.md).
  const isNewStop = !currentStop || currentStop.stop_id !== stop.stop_id;
  currentStop = stop;
  if (isNewStop) {
    flaggedItems = {};
    // Same reasoning applies to the signature and rack photo: clear them
    // when starting a genuinely new stop, but leave them alone on a
    // same-stop back-and-forth (e.g. sign -> back to exceptions -> forward
    // to signature again shouldn't wipe a signature already captured).
    clearSignaturePad_();
    clearRackPhoto_();
    clearSkipReason_();
  }

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

function getStopTotal_(stop) {
  if (stop.true_total != null) return stop.true_total;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].total != null) return stop.orders[0].total;
  return null;
}

// Same pattern as getStopTotal_ — prefer the stop-level corrected figure
// (multi-order stops), fall back to the single order's own field. Added so
// the PDF can show a Sub Total / Delivery Total breakdown like the ERP's
// own Delivery Note, not just the one combined total the app already showed.
function getStopSubtotal_(stop) {
  if (stop.true_subtotal != null) return stop.true_subtotal;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].subtotal != null) return stop.orders[0].subtotal;
  return null;
}

function getStopDeliveryFee_(stop) {
  if (stop.delivery_fee != null) return stop.delivery_fee;
  if (stop.orders && stop.orders.length === 1 && stop.orders[0].delivery_fee != null) return stop.orders[0].delivery_fee;
  return null;
}

function renderLineItemsTable_(stop) {
  const items = getLineItems_(stop);
  const table = document.getElementById("line-items-table");
  table.innerHTML = "";

  const thead = document.createElement("tr");
  ["Qty", "Item"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    thead.appendChild(th);
  });
  table.appendChild(thead);

  // Item name and size are rendered in the same cell, size right after the
  // name, so there's no wide auto-layout gap between them (was a separate
  // "Size" column pinned to the far right of a 100%-wide table).
  items.forEach((item) => {
    const row = document.createElement("tr");
    const tdQty = document.createElement("td");
    tdQty.textContent = item.qty;
    const tdName = document.createElement("td");
    tdName.appendChild(
      document.createTextNode(item.item_name + (item.item_code ? " (" + item.item_code + ")" : ""))
    );
    if (item.size) {
      const sizeSpan = document.createElement("span");
      sizeSpan.className = "item-size-inline";
      sizeSpan.textContent = "  — " + item.size;
      tdName.appendChild(sizeSpan);
    }
    row.appendChild(tdQty);
    row.appendChild(tdName);
    table.appendChild(row);
  });

  const total = getStopTotal_(stop);
  if (total != null) {
    const totalRow = document.createElement("tr");
    const tdBlank = document.createElement("td");
    const tdVal = document.createElement("td");
    tdVal.className = "total-cell";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = "Total";
    const valSpan = document.createElement("span");
    valSpan.textContent = "$" + total.toFixed(2);
    tdVal.appendChild(labelSpan);
    tdVal.appendChild(valSpan);
    totalRow.appendChild(tdBlank);
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

  // total_discrepancy_note / missing-line-items / email_gap_note are
  // internal office-side data-quality flags (surfaced to office in the
  // Manifest Draft tab's review_notes column) — never shown to the driver,
  // who can't act on them anyway. Only driver-actionable warnings below.
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
  // that the screen is actually visible. This does NOT also clear the pad —
  // that only happens in openStopScreen_ when it's actually a new stop (see
  // its comment) — a same-stop revisit here must not wipe an already-drawn
  // signature.
  resizeSignaturePad_();
  renderRackPhotoPreview_();
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
    const targetW = Math.round(rect.width * ratio);
    const targetH = Math.round(rect.height * ratio);
    // Setting canvas.width/height clears its bitmap even when set to the
    // same value it already had — so skip re-sizing (and silently wiping
    // an already-drawn signature) when nothing actually changed, e.g. when
    // re-opening this screen for the same stop after a trip to exceptions.
    if (canvas.width === targetW && canvas.height === targetH) return;
    canvas.width = targetW;
    canvas.height = targetH;
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
// RACK PHOTO CAPTURE
// ==================================================================
function wirePhotoCapture() {
  const input = document.getElementById("rack-photo-input");
  document.getElementById("take-photo-btn").addEventListener("click", () => input.click());
  document.getElementById("retake-photo-btn").addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = ""; // reset so picking the same filename again (a retake) still fires "change"
    if (!file) return;
    try {
      rackPhotoDataUrl = await compressImageFile_(file, 1280, 0.7);
    } catch (err) {
      rackPhotoDataUrl = null;
      showToast("Could not read that photo — try again.");
    }
    renderRackPhotoPreview_();
  });
}

function clearRackPhoto_() {
  rackPhotoDataUrl = null;
  renderRackPhotoPreview_();
}

function clearSkipReason_() {
  const select = document.getElementById("skip-sig-reason-select");
  if (select) select.value = "";
}

function renderRackPhotoPreview_() {
  const img = document.getElementById("rack-photo-preview");
  const takeBtn = document.getElementById("take-photo-btn");
  const retakeBtn = document.getElementById("retake-photo-btn");
  if (!img || !takeBtn || !retakeBtn) return; // called once before DOMContentLoaded finishes wiring; harmless no-op
  if (rackPhotoDataUrl) {
    img.src = rackPhotoDataUrl;
    img.classList.remove("hidden");
    takeBtn.classList.add("hidden");
    retakeBtn.classList.remove("hidden");
  } else {
    img.src = "";
    img.classList.add("hidden");
    takeBtn.classList.remove("hidden");
    retakeBtn.classList.add("hidden");
  }
}

// Downscales/recompresses a camera photo client-side before it ever becomes
// a data URL — an un-resized iPad photo can be several MB, which is fine as
// a one-off POST but would blow through localStorage's much smaller quota
// (5-10MB total) once a few stops' worth queue up offline (see the offline
// queue notes in PROJECT-NOTES.md). 1280px / JPEG quality 0.7 keeps a typical
// rack photo well under 500KB while still being clearly legible.
function compressImageFile_(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("could not decode image"));
      img.onload = () => {
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ==================================================================
// SUBMIT
// ==================================================================
let isSubmitting = false; // guards against a double-tap firing two submits for one stop

async function submitStop_(wantsSignature) {
  if (!currentStop || isSubmitting) return;

  const hasSignature = wantsSignature && sigPad.hasStroke;
  const signatureImage = hasSignature ? document.getElementById("sig-pad").toDataURL("image/png") : null;

  // A signature is only truly "captured" when something was actually drawn
  // (hasSignature above already accounts for tapping "Submit Delivery" with
  // nothing drawn, not just the explicit "Submit Without Signature" button).
  // Either way, require a reason rather than silently logging a blank skip.
  const skipReasonSelect = document.getElementById("skip-sig-reason-select");
  const skipReason = skipReasonSelect ? skipReasonSelect.value : "";
  if (!hasSignature && !skipReason) {
    showToast("Pick a reason for the missing signature before submitting.");
    return;
  }

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

  // Everything below racks_unloaded is extra context so the backend (Hour 7)
  // can build a proof-of-delivery PDF without a second lookup — the backend
  // only ever sees a Sheet, not the published route_plan.json file. Deliberately NOT
  // included: total_discrepancy_note / printed_subtotal_on_pdf — that's an
  // internal billing note about our own PDF export bug (see PROJECT-NOTES.md)
  // and must never end up on a document or email sent to the customer.
  const payload = {
    action: "submit_stop",
    date: manifest.dispatch_date,
    truck: currentStop.truck,
    stop_id: currentStop.stop_id,
    customer_name: currentStop.customer_name,
    customer_code: currentStop.customer_code || "",
    cart_number: currentStop.cart_number || "",
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
    subtotal: getStopSubtotal_(currentStop),
    delivery_fee: getStopDeliveryFee_(currentStop),
    total: getStopTotal_(currentStop),
    exceptions: exceptions,
    signature_captured: hasSignature,
    signature_image: signatureImage,
    signature_skipped_reason: hasSignature ? "" : skipReason,
    rack_photo_image: rackPhotoDataUrl,
    contact_emails: currentStop.contact_emails || [],
    submitted_at_iso: new Date().toISOString(),
  };

  const newStatus = exceptions.length > 0 ? "done_exceptions" : "done_clean";
  saveDriverStateLocal_(currentStop.stop_id, {
    racks_unloaded: racksUnloaded,
    exceptions: exceptions,
    signature_image: signatureImage,
    signature_skipped_reason: payload.signature_skipped_reason,
    rack_photo_image: rackPhotoDataUrl,
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
  rackPhotoDataUrl = null;
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
// OFFLINE-FIRST: route plan data cache + service worker registration
// ==================================================================
// Saves the just-fetched route plan/pins as the offline fallback. Called
// only after a successful fetch (see init()) — never write a failed or
// partial load in here.
function saveRoutePlanCache_(manifestToCache, pinsToCache) {
  try {
    localStorage.setItem(STORAGE_KEY_ROUTE_PLAN_CACHE, JSON.stringify({ manifest: manifestToCache, pins: pinsToCache }));
  } catch (err) {
    console.warn("could not persist route plan cache", err);
  }
}

// Returns the last cached {manifest, pins}, or null if none saved yet
// (e.g. very first load ever, before any successful fetch happened).
function loadRoutePlanCache_() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ROUTE_PLAN_CACHE);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

// Registers service-worker.js, which caches the app shell (this file,
// style.css, index.html, pins.json) so the page itself still loads with
// zero signal, not just the route plan data (that part is the
// localStorage cache above — the service worker deliberately never
// caches the get_route_plan fetch, since that has to stay live/fresh).
// Feature-detected and non-fatal: an iPad on an old iOS version, or any
// browser without service worker support, just falls back to today's
// behavior (page load itself needs signal) with no error shown — this
// is a progressive enhancement, not a requirement to use the app.
function registerServiceWorker_() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("service-worker.js").catch((err) => {
    console.warn("service worker registration failed", err);
  });
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
