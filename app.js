/**
 * CT Delivery App — frontend logic (Hours 3-6 of the 8-hour build plan)
 *
 * Screens: login -> route list -> stop detail -> exceptions -> signature -> (back to route list)
 * Data: the day's route plan (route/stops/line items/totals) is fetched live from the Apps
 *       Script backend — NOT a static file bundled with this page. That's a deliberate change
 *       from the original design: publishing a new day used to mean uploading a new manifest
 *       file to GitHub every single day, which is exactly what this was changed to avoid.
 *       Office runs the Sheet menu's "Create Route Plan..." (one step — builds AND publishes)
 *       and the app picks it up on the driver's next login — no GitHub involved.
 *       As of 2026-09-24 this is a TWO-PHASE fetch, not one: init() first fetches
 *       "?action=get_trucks" (small, always live — just today's truck list, so the login
 *       screen is never showing a stale/cached set of trucks) and paints the login screen
 *       from that, then fetches the full "?action=get_route_plan" (every stop, every line
 *       item — the slow part) in the background via loadFullRoutePlan_. See init()'s own
 *       comment for the full rationale and Code.gs's getTrucksForRequest_ /
 *       getRoutePlanForRequest_ / publishRoutePlan_ and PROJECT-NOTES.md.
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
let manifestReadyPromise_ = null; // set once in init() to loadFullRoutePlan_()'s promise; the login button handler awaits this if the driver taps "Start Route" before the full route plan has finished loading in the background — see both places below
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

  // Two-phase load. This REPLACES an earlier stale-while-revalidate design
  // that painted a CACHED truck list immediately and silently swapped in
  // fresh data later — G flagged that as actively wrong, not just slow
  // ("trucks change... just the trucks that run that day load first and
  // entire data loads after"): which trucks are running can change day to
  // day, so showing a stale list — even for a couple seconds — risks a
  // driver tapping a truck that isn't actually running today. So the truck
  // list is now NEVER shown from a cache; the login screen simply waits
  // for a small, fast, always-live fetch:
  //   1. get_trucks (loadFullRoutePlan_'s sibling, inline below) — a tiny
  //      file with just {dispatch_date, trucks, truck_drivers,
  //      truck_start_times}, written by publishRoutePlan_ alongside the
  //      full route plan (see Code.gs). Nothing cached is ever painted for
  //      this — only what this fetch actually returns, right now.
  //   2. get_route_plan — the FULL route plan (every stop, every line
  //      item). This is the genuinely slow Drive/Sheets round trip that
  //      was the real cause of "it loads a while until trucks shown."
  //      loadFullRoutePlan_ runs this in the background, in parallel with
  //      phase 1, and the login button handler (wireLoginScreen, below)
  //      awaits manifestReadyPromise_ if the driver enters a valid PIN
  //      before phase 2 has finished.
  // The offline route-plan cache (localStorage) still exists, but its job
  // narrows to: (a) a fallback for phase 1 itself if get_trucks can't be
  // reached at all (shown with a clear "offline"/stale-data toast, never
  // silently), and (b) phase 2's offline fallback so the app still works
  // through a dead zone after loading once this morning with signal.
  const cachedPlan = loadRoutePlanCache_();

  manifestReadyPromise_ = loadFullRoutePlan_(cachedPlan);

  let trucksCacheReason = null; // null | "offline" | "not_published" — same meaning/messaging as before, just now scoped to the trucks fetch instead of the whole route plan
  let trucksData = null;
  try {
    const [trucksRes, pinsRes] = await Promise.all([
      fetch(APPS_SCRIPT_URL + "?action=get_trucks", { cache: "no-store" }),
      fetch(PINS_FILE, { cache: "no-store" }),
    ]);
    const trucksJson = await trucksRes.json();
    if (trucksJson && trucksJson.ok === false) {
      if (!cachedPlan) {
        showToast(trucksJson.error || "No route plan published yet.");
        console.error("trucks fetch returned an error", trucksJson);
        return;
      }
      console.error("trucks fetch returned an error; falling back to the last cached truck list", trucksJson);
      trucksData = cachedPlan.manifest;
      trucksCacheReason = "not_published";
    } else {
      trucksData = trucksJson;
    }
    pins = await pinsRes.json();
  } catch (err) {
    // Network-level failure (offline, dead zone, etc.) — fall back to the
    // last cached truck list instead of leaving the login screen blank.
    // Still clearly labeled as possibly-stale below, since this is exactly
    // the case ("trucks change") the two-phase design exists to avoid
    // showing silently.
    if (!cachedPlan) {
      showToast("Could not load today's trucks. Check your connection and reload.");
      console.error("trucks/pins load failed, and no offline cache available", err);
      return;
    }
    console.warn("trucks fetch failed; falling back to the last cached truck list", err);
    trucksData = cachedPlan.manifest;
    pins = cachedPlan.pins;
    trucksCacheReason = "offline";
  }

  document.getElementById("login-date").textContent = formatDispatchDate_(trucksData.dispatch_date);
  renderTruckSelect_(trucksData.trucks || []);
  if (trucksCacheReason === "offline") {
    showToast("Offline — showing the last truck list loaded (" + formatDispatchDate_(trucksData.dispatch_date) + "). Trucks running today may have changed.");
  } else if (trucksCacheReason === "not_published") {
    showToast("No newer route plan published yet — showing the last truck list loaded (" + formatDispatchDate_(trucksData.dispatch_date) + ").");
  }

  updateQueueBanner_();
  window.addEventListener("online", () => flushOfflineQueue_());
  // The browser's "online" event only fires on an actual offline->online
  // transition. It does NOT fire just because a submit happened to time out
  // while the device was on wifi the whole time (a slow Apps Script cold
  // start, say — see the timeout comment in sendToBackend_) — that item
  // would then sit queued, with the banner saying "will send automatically
  // when back online," indefinitely, on a connection that was never
  // actually lost. Two more triggers close that gap: a periodic retry
  // while anything's queued, and one whenever the driver brings the app
  // back into view (switching back from another app, waking the screen) —
  // a natural moment real connectivity is most likely present, and it
  // doesn't depend on the browser's own (notoriously unreliable on iOS
  // Safari) online/offline detection at all.
  setInterval(() => { if (readQueue_().length > 0) flushOfflineQueue_(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && readQueue_().length > 0) flushOfflineQueue_();
  });
  // also try once on load in case there's a leftover queue from a prior offline session
  flushOfflineQueue_();
}

// Phase 2 of init()'s two-phase load: fetches the FULL route plan (every
// stop, every line item — the genuinely slow Drive/Sheets round trip) in
// the background, in parallel with phase 1's fast get_trucks fetch above.
// Sets the module-level `manifest`/`pins` on success and caches them for
// offline use next time, exactly like the old single-phase load did.
// Returns true once manifest/pins are usable (either freshly fetched or
// filled in from the offline cache) or false if nothing could be loaded at
// all — the login button handler (wireLoginScreen, below) awaits this via
// manifestReadyPromise_ and checks that return value if the driver taps
// "Start Route" before this has finished.
async function loadFullRoutePlan_(cachedPlan) {
  try {
    const [manifestRes, pinsRes] = await Promise.all([
      fetch(APPS_SCRIPT_URL + "?action=get_route_plan", { cache: "no-store" }),
      fetch(PINS_FILE, { cache: "no-store" }),
    ]);
    const manifestJson = await manifestRes.json();
    // NOTE: as of 2026-09-24 the backend serves whatever route plan is
    // currently published, whatever date it's for — it no longer checks
    // that against today (see the TODO comment on getRoutePlanForRequest_
    // in Code.gs for why, and why that check should come back before this
    // is relied on for real daily driving).
    if (manifestJson && manifestJson.ok === false) {
      if (!cachedPlan) {
        console.error("route plan fetch returned an error, and no offline cache available", manifestJson);
        return false;
      }
      console.error("route plan fetch returned an error; falling back to the last cached route plan", manifestJson);
      manifest = cachedPlan.manifest;
      pins = cachedPlan.pins;
      applyStoredDriverState_();
      return true;
    }
    manifest = manifestJson;
    pins = await pinsRes.json();
    saveRoutePlanCache_(manifest, pins);
    applyStoredDriverState_();
    return true;
  } catch (err) {
    // Network-level failure (offline, dead zone, etc.) — fall back to the
    // last successfully loaded route plan/pins, same offline-first
    // behavior as before, just now scoped to phase 2 only.
    if (!cachedPlan) {
      console.error("route plan fetch failed, and no offline cache available", err);
      return false;
    }
    console.warn("background route plan load failed; falling back to the last cached route plan", err);
    manifest = cachedPlan.manifest;
    pins = cachedPlan.pins;
    applyStoredDriverState_();
    return true;
  }
}

// ==================================================================
// LOGIN SCREEN
// ==================================================================
// Truck buttons are NOT hardcoded. renderTruckSelect_(trucks) (called from
// init() once the fast get_trucks fetch resolves — see the two-phase load
// comment in init()) builds one button per truck that actually has stops
// in TODAY's published route plan. This is deliberate, not an oversight: a
// fixed "Truck 4 / Truck 5" list silently left out any other truck
// ERP-outFuture had assigned stops to — found for real when Truck 3 had a
// full route and wasn't selectable at all. A truck still needs an entry in
// pins.json to actually log in (that file is unrelated to which buttons
// render — see its own comment); a truck that shows up in today's route
// but has no pins.json entry yet gets its own clear error at login time
// below, rather than "Wrong PIN."
function renderTruckSelect_(trucksIn) {
  const truckSelect = document.getElementById("truck-select");
  truckSelect.innerHTML = "";

  const trucks = (trucksIn || []).slice().sort((a, b) => {
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

  loginBtn.addEventListener("click", async () => {
    const enteredPin = pinInput.value.trim();
    if (!selectedTruck || !enteredPin) return;

    if (!pins) {
      // pins never loaded — either today's route plan hasn't been published yet
      // (see init()'s trucks fetch, which returns early before loading pins in
      // that case) or the pins.json fetch itself failed. Either way,
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

    // PIN's correct. The truck list (phase 1) is loaded by now, but the
    // FULL route plan (phase 2 — every stop's details, needed by
    // renderRouteList_/openRouteScreen_) may still be loading in the
    // background if the driver was quick on the PIN. Wait for it here
    // rather than opening an empty route screen.
    if (!manifest) {
      const originalLabel = loginBtn.textContent;
      loginBtn.disabled = true;
      loginBtn.textContent = "Loading route details…";
      loginError.textContent = "";
      const loaded = await manifestReadyPromise_;
      loginBtn.textContent = originalLabel;
      if (!loaded || !manifest) {
        loginBtn.disabled = false;
        loginError.textContent = "Could not load today's route details. Check your connection and try again.";
        return;
      }
      updateLoginBtnState_();
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
    // text + inputmode=numeric + pattern=[0-9]* (same combo as the
    // qty-affected field on the exceptions screen — see PROJECT-NOTES.md)
    // gets a true digits-only keypad on iPad Safari, but type="text" does no
    // numeric validation of its own, so strip anything non-digit as it's typed.
    const digitsOnly = racksInput.value.replace(/[^0-9]/g, "");
    if (digitsOnly !== racksInput.value) racksInput.value = digitsOnly;
    const btn = document.getElementById("to-exceptions-btn");
    btn.disabled = racksInput.value === "" || Number(racksInput.value) < 0;
    renderStopWarnings_();
  });

  // +/- buttons, grouped together on one side of the input (same pattern as
  // the exceptions screen's qty-affected stepper) — no upper cap here, since
  // unloading more or fewer racks than expected is exactly the mismatch
  // renderStopWarnings_() is meant to surface, not something to block.
  function setRacksUnloaded_(n) {
    if (!isFinite(n) || n < 0) n = 0;
    racksInput.value = String(n);
    racksInput.dispatchEvent(new Event("input"));
  }
  document.getElementById("racks-minus-btn").addEventListener("click", () => {
    setRacksUnloaded_((racksInput.value === "" ? 0 : Number(racksInput.value)) - 1);
  });
  document.getElementById("racks-plus-btn").addEventListener("click", () => {
    setRacksUnloaded_((racksInput.value === "" ? 0 : Number(racksInput.value)) + 1);
  });

  document.getElementById("to-exceptions-btn").addEventListener("click", () => {
    if (!currentStop) return;
    currentStop._racksUnloadedEntered = Number(document.getElementById("racks-unloaded-input").value);
    openExceptionsScreen_(currentStop);
  });

  document.getElementById("print-pdf-btn").addEventListener("click", () => {
    const fileId = currentStop && currentStop.driver_state && currentStop.driver_state.pdf_file_id;
    if (!fileId) return;
    // Opens the backend's own ?action=get_pdf endpoint (see servePdfForPrint_
    // in Code.gs) — never the raw Drive link — so this works with no Google
    // login on the iPad. Safari opens a PDF in its built-in viewer, whose
    // Share icon includes Print (AirPrint) — no extra print code needed here.
    window.open(APPS_SCRIPT_URL + "?action=get_pdf&file_id=" + encodeURIComponent(fileId), "_blank");
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

  const pdfFileId = stop.driver_state && stop.driver_state.pdf_file_id;
  document.getElementById("print-pdf-row").classList.toggle("hidden", !pdfFileId);

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

// Qty / Item / Size as flex rows (divs, not a <table>). A table — even with
// table-layout:fixed — pins the size column to the far right edge of the
// full-width table, which for a short item name left a big empty gap before
// the size, and forced the Total row's dollar figure into that same
// fixed-width column where a real total (e.g. "$1,234.56") didn't fit and
// got hard-wrapped mid-digit on a real iPad. Flex items size to their own
// content instead: qty is a fixed slot, the name takes only the room its
// text needs, and the size sits right after it with a small fixed gap — so
// any leftover space lands at the end of the row, not between the name and
// size. See the CSS comment on .line-items-list for the full rationale
// (including why this also can't repeat the earlier colspan+flex-in-a-
// table-cell bug — there's no table cell at all anymore).
// The internal item code (e.g. "10beagua") is dropped from the driver view
// entirely — it's an office/GrowFlo matching detail, not something a driver
// acts on (see the "office-side data-quality flags" note in
// renderStopWarnings_ just below for the same driver-vs-office principle).
function renderLineItemsTable_(stop) {
  const items = getLineItems_(stop);
  const list = document.getElementById("line-items-table");
  list.innerHTML = "";

  const header = document.createElement("div");
  header.className = "li-header";
  const hQty = document.createElement("div");
  hQty.className = "li-qty";
  hQty.textContent = "Qty";
  const hName = document.createElement("div");
  hName.className = "li-name";
  hName.textContent = "Item";
  const hSize = document.createElement("div");
  hSize.className = "li-size";
  hSize.textContent = "Size";
  header.appendChild(hQty);
  header.appendChild(hName);
  header.appendChild(hSize);
  list.appendChild(header);

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "li-row";
    const qty = document.createElement("div");
    qty.className = "li-qty";
    qty.textContent = item.qty;
    const name = document.createElement("div");
    name.className = "li-name";
    name.textContent = item.item_name;
    const size = document.createElement("div");
    size.className = "li-size";
    size.textContent = item.size || "";
    row.appendChild(qty);
    row.appendChild(name);
    row.appendChild(size);
    list.appendChild(row);
  });

  const total = getStopTotal_(stop);
  if (total != null) {
    const totalRow = document.createElement("div");
    totalRow.className = "li-row total-row";
    const label = document.createElement("div");
    label.className = "total-label";
    label.textContent = "Total";
    const val = document.createElement("div");
    val.className = "total-value";
    // toLocaleString for a real "$1,234.56" — toFixed(2) alone never adds
    // the thousands separator, which reads oddly next to real order totals.
    val.textContent = "$" + total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    totalRow.appendChild(label);
    totalRow.appendChild(val);
    list.appendChild(totalRow);
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
  showScreen_("screen-exceptions");
}

// Shared by renderItemPickList_ (initial render / on collapse-expand) and
// buildExceptionInlineForm_ (live updates as the reason pill or qty stepper
// changes, without rebuilding the whole list — see the call sites for why
// that matters). Per G's "when minimized there must be written in row what
// happened," a flagged line's row always names the reason and qty affected,
// collapsed or expanded — not just a bare "Flagged" — so a driver scanning a
// long, mostly-collapsed list can see what's wrong with each line without
// reopening every one of them.
function updateItemPickStatus_(statusEl, ex, expanded) {
  if (!ex) {
    statusEl.textContent = "Tap to flag";
    return;
  }
  const qtyPart = "qty " + (ex.qty_change != null ? ex.qty_change : 0);
  statusEl.textContent = ex.reason + " · " + qtyPart + (expanded ? " ▾" : " ▸");
}

// The whole line is one big tap target (not a separate small "Flag" button),
// a flagged line turns red end to end, and its reason/qty/notes form expands
// directly inside that same line — no separate "exception-forms" list
// further down the screen to scroll to and match back up to the right item
// by name. Tapping the line flags it (first tap) or just collapses/expands
// its already-flagged form (every tap after that) — it never unflags; see
// the row click handler below and buildExceptionInlineForm_'s "Remove Flag"
// button for why that's a separate, deliberate action. See PROJECT-NOTES.md.
function renderItemPickList_(stop) {
  const items = getLineItems_(stop);
  const list = document.getElementById("item-pick-list");
  list.innerHTML = "";

  items.forEach((item, idx) => {
    const flagged = !!flaggedItems[idx];
    const row = document.createElement("div");
    row.className = "item-pick-row" + (flagged ? " flagged" : "");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "item-pick-main";

    const label = document.createElement("span");
    label.className = "item-pick-label";
    label.textContent = item.qty + "x " + item.item_name + (item.size ? " (" + item.size + ")" : "");
    main.appendChild(label);

    const expanded = flagged && flaggedItems[idx].expanded;
    const status = document.createElement("span");
    status.className = "item-pick-status";
    updateItemPickStatus_(status, flaggedItems[idx], expanded);
    main.appendChild(status);

    // Tapping the line only ever flags it (first tap) or collapses/expands
    // its already-flagged form (every tap after that) — it never unflags.
    // That was a real problem: a driver tapping the line again just to
    // shrink it back down (once the reason/qty/notes were filled in, to see
    // more of the list without scrolling) was silently deleting the whole
    // exception. Unflagging now only happens via the explicit "Remove Flag"
    // button inside the expanded form (see buildExceptionInlineForm_) — a
    // deliberate action, not a side effect of tidying up the view.
    main.addEventListener("click", () => {
      if (flaggedItems[idx]) {
        flaggedItems[idx].expanded = !flaggedItems[idx].expanded;
      } else {
        flaggedItems[idx] = {
          item_code: item.item_code || "",
          item_name: item.item_name,
          size: item.size || "",
          qty: item.qty,
          reason: "Rejected",
          qty_change: item.qty,
          notes: "",
          expanded: true,
        };
      }
      renderItemPickList_(stop);
    });
    row.appendChild(main);

    if (expanded) {
      row.appendChild(buildExceptionInlineForm_(flaggedItems[idx], idx, stop, status));
    }

    list.appendChild(row);
  });

  if (items.length === 0) {
    list.innerHTML = '<p class="hint">No line items on file for this stop — see the note on the previous screen.</p>';
  }
}

// The reason/qty/notes form for one flagged line, built fresh each render
// and appended directly under that line's own row (see renderItemPickList_).
// Every control here stops its click from bubbling up to the row's own
// collapse/expand handler, so tapping a reason button or the qty field just
// changes that field, nothing more. `statusEl` is that row's own summary
// span (the same one renderItemPickList_ builds) — reason/qty changes below
// update it directly in place rather than calling renderItemPickList_ again,
// which would rebuild the entire list (every row, every tap) just to change
// a few words of text, and interrupt a driver mid-tap on the +/- buttons.
function buildExceptionInlineForm_(ex, idx, stop, statusEl) {
  const form = document.createElement("div");
  form.className = "exception-inline";
  form.addEventListener("click", (e) => e.stopPropagation());

  const reasonRow = document.createElement("div");
  reasonRow.className = "reason-btn-row";
  ["Rejected", "Short", "Damaged", "Substituted", "Other"].forEach((r) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reason-btn" + (ex.reason === r ? " selected" : "");
    btn.textContent = r;
    btn.addEventListener("click", () => {
      ex.reason = r;
      reasonRow.querySelectorAll(".reason-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      updateItemPickStatus_(statusEl, ex, true);
    });
    reasonRow.appendChild(btn);
  });
  form.appendChild(reasonRow);

  // Capped at the ordered qty (ex.qty) — can't reject/flag more units of an
  // item than were actually on the order (see PROJECT-NOTES.md — this needs
  // enforcing here AND again in submitStop_ as a last-line-of-defense clamp,
  // since neither a text input's typed value nor a stepper button is a real
  // constraint on its own).
  const qtyLabel = document.createElement("label");
  qtyLabel.className = "qty-affected-label";
  qtyLabel.textContent = "Qty affected (of " + ex.qty + " ordered)";
  form.appendChild(qtyLabel);

  const stepper = document.createElement("div");
  stepper.className = "qty-stepper";

  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.className = "qty-step-btn qty-minus";
  minusBtn.textContent = "−";
  minusBtn.setAttribute("aria-label", "Decrease quantity");

  // type="text" + inputmode="numeric" + pattern="[0-9]*" (not type="number")
  // is the combination that actually gets a digits-only keypad on iPad
  // Safari, with no decimal point or +/- key to fumble with — type="number"
  // alone still shows those. Sanitizing pasted/typed input to digits-only in
  // the "input" handler below covers anything the keypad restriction misses.
  const qtyInput = document.createElement("input");
  qtyInput.type = "text";
  qtyInput.inputMode = "numeric";
  qtyInput.pattern = "[0-9]*";
  qtyInput.className = "qty-input";
  qtyInput.value = ex.qty_change != null ? String(ex.qty_change) : "";

  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.className = "qty-step-btn";
  plusBtn.textContent = "+";
  plusBtn.setAttribute("aria-label", "Increase quantity");

  function setQty_(n) {
    if (!isFinite(n) || n < 0) n = 0;
    if (n > ex.qty) {
      n = ex.qty;
      showToast("Only " + ex.qty + " of this item were ordered — capped at " + ex.qty + ".");
    }
    ex.qty_change = n;
    qtyInput.value = String(n);
    updateItemPickStatus_(statusEl, ex, true);
  }

  minusBtn.addEventListener("click", () => setQty_((ex.qty_change || 0) - 1));
  plusBtn.addEventListener("click", () => setQty_((ex.qty_change || 0) + 1));
  qtyInput.addEventListener("input", () => {
    const digitsOnly = qtyInput.value.replace(/[^0-9]/g, "");
    if (digitsOnly !== qtyInput.value) qtyInput.value = digitsOnly;
    setQty_(digitsOnly === "" ? 0 : parseInt(digitsOnly, 10));
  });

  // Input first, then minus/plus grouped together as one joined control
  // (.qty-step-group) after it — not flanking the input on both sides — so
  // a driver can tap minus/plus repeatedly without moving their thumb
  // across the number itself. See PROJECT-NOTES.md.
  const stepGroup = document.createElement("div");
  stepGroup.className = "qty-step-group";
  stepGroup.appendChild(minusBtn);
  stepGroup.appendChild(plusBtn);

  stepper.appendChild(qtyInput);
  stepper.appendChild(stepGroup);
  form.appendChild(stepper);

  const notesInput = document.createElement("textarea");
  notesInput.placeholder = "Notes (optional)";
  notesInput.rows = 2;
  notesInput.value = ex.notes || "";
  notesInput.addEventListener("input", () => { ex.notes = notesInput.value; });
  form.appendChild(notesInput);

  // The one and only way to actually unflag this line — see the comment on
  // the row's click handler in renderItemPickList_ for why tapping the row
  // itself no longer does this.
  const unflagBtn = document.createElement("button");
  unflagBtn.type = "button";
  unflagBtn.className = "unflag-btn";
  unflagBtn.textContent = "Remove Flag";
  unflagBtn.addEventListener("click", () => {
    delete flaggedItems[idx];
    renderItemPickList_(stop);
  });
  form.appendChild(unflagBtn);

  return form;
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
  const exceptions = Object.values(flaggedItems).map((ex) => {
    // Same cap as the qty-affected input in renderExceptionForms_ — enforced
    // again here as a last line of defense so a submitted exception can
    // never claim more units were rejected/short/damaged than were ordered,
    // regardless of how qty_change got set.
    let qtyChange = Number(ex.qty_change);
    if (!isFinite(qtyChange) || qtyChange < 0) qtyChange = 0;
    if (qtyChange > ex.qty) qtyChange = ex.qty;
    return {
      item_code: ex.item_code,
      item_name: ex.item_name,
      reason: ex.reason,
      qty_change: qtyChange,
      notes: ex.notes,
    };
  });

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

  // The actual send to the backend (build the PDF, save it to Drive, email
  // the customer — a real network round-trip that can take several seconds,
  // longer on a cold Apps Script start) used to be awaited right here, which
  // is what made the driver stare at a spinner for a couple of seconds on
  // every single stop. It no longer blocks the screen: every submit — not
  // just genuine no-signal ones — now goes through the same offline queue
  // built for that case (see OFFLINE QUEUE below). queueOffline_ persists it
  // to localStorage immediately (so it survives a crash/reload even before
  // it's sent), then flushOfflineQueue_ is kicked off WITHOUT awaiting it.
  // flushOfflineQueue_ already does everything the old inline success/fail
  // branch used to do — retries on failure, merges pdf_file_id back into
  // local state so the print button lights up, updates the queue banner,
  // and shows its own "synced" toast once the backend actually confirms —
  // so there's nothing left to branch on here.
  const customerName = currentStop.customer_name;
  queueOffline_(payload);
  flushOfflineQueue_();
  showToast("Saved — sending " + customerName + "'s delivery in the background.");

  isSubmitting = false;
  currentStop = null;
  flaggedItems = {};
  rackPhotoDataUrl = null;
  renderRouteList_();
  showScreen_("screen-route");
}

// Returns the backend's parsed response object on a genuine success
// (data.ok === true — carries pdf_file_id, used to let a driver print the
// delivery PDF later), or null on anything else (not configured, network
// failure, timeout, non-ok HTTP status, or the backend's own ok:false).
// Was a bare boolean before pdf_file_id needed to make it back to the
// caller too — callers just need `if (result)` where they used to check
// the boolean.
async function sendToBackend_(payload) {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) {
    return null; // not configured yet — treat as offline so nothing is silently lost
  }
  try {
    const controller = new AbortController();
    // A submit's backend work is a real Drive/Docs/Gmail chain (build the
    // PDF, save it, email it — see buildAndSavePdf_/sendDeliveryEmail_ in
    // Code.gs), which can genuinely take longer than a plain API call,
    // especially on a cold Apps Script start. 15s was cutting that off
    // early on a perfectly good connection — not a real "no signal" case,
    // just a slow one — which is exactly what queued it and left the
    // "waiting to sync" banner showing while on wifi the whole time.
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      // text/plain avoids a CORS preflight that Apps Script Web Apps can't answer —
      // see the CORS note at the top of Code.gs. The body is still JSON text.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch (err) {
    console.warn("submit failed, will queue offline", err);
    return null;
  }
}

// ==================================================================
// OFFLINE QUEUE
// ==================================================================
// Every submit now runs through this queue, not just genuine no-signal ones
// (see submitStop_) — so flushOfflineQueue_ can get kicked off far more
// often, and from more places at once (a submit, the online event, the 30s
// interval, visibilitychange). flushInProgress_ stops two passes from
// actually SENDING at the same time (see below), and _queue_id (assigned in
// queueOffline_) is what lets a pass remove only the specific items it
// confirmed sent when it writes back — never the whole queue array it
// started with — which matters a lot now: with every submit going through
// here, it's routine for a second stop to get queued while the first one's
// pass is still awaiting the backend, and that second item must not get
// wiped out when the first pass finishes and writes back. (This exact
// clobber is what earlier testing on this change caught: item B queued
// mid-flush was silently lost because the in-flight pass wrote back an
// empty "remaining" list computed from its own stale snapshot rather than
// the queue's current contents.) queuedDuringFlush_ additionally triggers
// one extra pass right after the current one finishes, so a stop queued
// mid-flush doesn't sit waiting for the next 30s interval — but a pass that
// fails never retriggers itself, so a genuine outage doesn't spin.
//
// This care matters beyond just tidiness: the email side is already
// careful to never double-send to a real customer (see the
// sendDeliveryEmail_ rule in PROJECT-NOTES.md), and a queue bug that sent
// the same stop to the backend twice would risk exactly that.
let flushInProgress_ = false;
let queuedDuringFlush_ = false;
let queueIdCounter_ = 0;

function queueOffline_(payload) {
  if (!payload._queue_id) {
    queueIdCounter_ += 1;
    payload._queue_id = Date.now() + "-" + queueIdCounter_;
  }
  const queue = readQueue_();
  queue.push(payload);
  writeQueue_(queue);
  updateQueueBanner_();
  if (flushInProgress_) queuedDuringFlush_ = true;
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
  if (flushInProgress_) return; // a pass is already running — see the note above queueOffline_
  flushInProgress_ = true;
  try {
    const queue = readQueue_();
    if (queue.length === 0) {
      updateQueueBanner_();
      return;
    }
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("PASTE_YOUR") === 0) return;

    const sentIds = new Set();
    let anyPdfSynced = false;
    for (const payload of queue) {
      // _queue_id is purely a local bookkeeping field — strip it before it
      // goes over the wire so the backend only ever sees the fields it
      // already expects.
      const { _queue_id, ...toSend } = payload;
      const result = await sendToBackend_(toSend);
      if (!result) continue;
      sentIds.add(_queue_id);
      // Same as the online-submit path in submitStop_ — a queued delivery
      // only gets its PDF built once it actually reaches the backend, so
      // the print button only becomes available here, on sync.
      if (result.pdf_file_id) {
        mergeDriverStateLocal_(payload.stop_id, { pdf_file_id: result.pdf_file_id });
        anyPdfSynced = true;
      }
    }
    // Re-read the queue fresh rather than trusting the snapshot taken at the
    // top of this pass — something may have been queued (or even, in
    // principle, cleared) while the loop above was awaiting the network —
    // and remove only the items this pass actually confirmed sent.
    if (sentIds.size > 0) {
      const current = readQueue_();
      writeQueue_(current.filter((p) => !sentIds.has(p._queue_id)));
    }
    if (anyPdfSynced) applyStoredDriverState_();
    updateQueueBanner_();
    if (sentIds.size > 0) {
      showToast(sentIds.size + " queued delivery/deliveries synced.");
    }
  } finally {
    flushInProgress_ = false;
    if (queuedDuringFlush_) {
      queuedDuringFlush_ = false;
      flushOfflineQueue_();
    }
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

// Patches a few fields onto a stop's already-saved state instead of
// replacing the whole record the way saveDriverStateLocal_ does — used for
// pdf_file_id, which only becomes known sometime after the full
// racks/exceptions/signature state was already saved (immediately on
// submit for an online delivery, or later on offline-queue sync), and must
// not clobber it.
function mergeDriverStateLocal_(stopId, patch) {
  const all = readDriverStateStore_();
  all[stopId] = Object.assign({}, all[stopId], patch);
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
