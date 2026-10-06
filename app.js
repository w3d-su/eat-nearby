(function () {
  'use strict';

  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const NOMINATIM_QUERIES = ['restaurant', 'fast food', 'cafe', 'tea'];
  const TYPE_TO_CAT = {
    restaurant: 'restaurant', fast_food: 'fast_food', cafe: 'cafe',
    food_court: 'food_court', bar: 'bar', pub: 'bar', ice_cream: 'dessert',
    bakery: 'dessert', confectionery: 'dessert', dessert: 'dessert', tea: 'cafe',
  };
  const DEFAULT_CENTER = [25.0478, 121.5319]; // 台北車站
  const RECENT_CAP = 10;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const state = {
    pos: null,
    restaurants: [],
    filters: {
      radius: 1000,
      cats: new Set(CATEGORY_DEFS.map(c => c.id)),
      cuisine: 'all',
      openNow: false,
      favOnly: false,
    },
    favs: new Set(store.get(LS.FAVS, [])),
    blacklist: new Map(store.get(LS.BLACKLIST, []).map(e => [e.id, e.name])),
    recent: store.get(LS.RECENT, []),
    manualPick: false,
    loading: false,
    degraded: false,
    lastWinner: null,
  };

  // 還原上次的篩選條件
  const saved = store.get(LS.FILTERS, null);
  if (saved) {
    if (saved.radius) state.filters.radius = saved.radius;
    if (Array.isArray(saved.cats)) state.filters.cats = new Set(saved.cats);
    if (saved.openNow) state.filters.openNow = true;
  }

  let map, userDot, radiusCircle, markerLayer;
  const markersById = new Map();

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  /* ---------- 地圖 ---------- */
  function initMap() {
    map = L.map('map').setView(DEFAULT_CENTER, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      if (!state.manualPick) return;
      setPosition(e.latlng.lat, e.latlng.lng, '已使用手動選取的位置');
    });
  }

  function updateUserMarker() {
    if (userDot) { userDot.remove(); radiusCircle.remove(); }
    userDot = L.circleMarker(state.pos, {
      radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(map);
    radiusCircle = L.circle(state.pos, {
      radius: state.filters.radius, color: '#1a73e8', weight: 1.5, fillOpacity: 0.05,
    }).addTo(map);
  }

  function renderMarkers(items) {
    markerLayer.clearLayers();
    markersById.clear();
    for (const r of items) {
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 7, color: '#fff', weight: 2,
        fillColor: state.favs.has(r.id) ? '#e91e63' : '#f57c00', fillOpacity: 0.9,
      });
      const pop = el('div', 'popup');
      pop.appendChild(el('strong', null, r.name));
      pop.appendChild(el('div', 'popup-sub', `${r.catLabel}${r.cuisineLabel ? ' · ' + r.cuisineLabel : ''} · ${formatDist(r.distance)}`));
      const a = el('a', null, 'Google 地圖 ↗');
      a.href = r.gmaps; a.target = '_blank'; a.rel = 'noopener';
      pop.appendChild(a);
      m.bindPopup(pop);
      m.addTo(markerLayer);
      markersById.set(r.id, m);
    }
  }

  /* ---------- 定位 ---------- */
  function locate() {
    setLocStatus('定位中…', false);
    if (!navigator.geolocation) return geoFail('此瀏覽器不支援定位');
    navigator.geolocation.getCurrentPosition(
      (p) => setPosition(p.coords.latitude, p.coords.longitude),
      (err) => geoFail(err.code === 1 ? '定位被拒絕' : '定位失敗'),
      { timeout: 10000, maximumAge: 60000 }
    );
  }

  function geoFail(msg) {
    state.manualPick = true;
    setLocStatus(`${msg} — 點此重試,或直接點地圖選位置`, true);
    toast(msg + ',可點擊地圖手動選擇位置', 5000);
  }

  function setLocStatus(text, isError) {
    const s = $('locStatus');
    s.textContent = text;
    s.classList.toggle('error', !!isError);
  }

  function setPosition(lat, lng, note) {
    state.pos = { lat, lng };
    setLocStatus(`已定位 ${lat.toFixed(4)}, ${lng.toFixed(4)}${note ? ' · ' + note : ''}`, false);
    map.setView([lat, lng], 15);
    updateUserMarker();
    fetchRestaurants();
  }

  /* ---------- Overpass ---------- */
  // 平行 race 所有 endpoint,個別 timeout;任一成功即中止其餘
  function timedFetch(url, opts, ms, stopSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const onStop = () => ctrl.abort();
    if (stopSignal) stopSignal.addEventListener('abort', onStop);
    return fetch(url, { ...opts, signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .finally(() => {
        clearTimeout(timer);
        if (stopSignal) stopSignal.removeEventListener('abort', onStop);
      });
  }

  async function fetchRestaurants() {
    if (!state.pos || state.loading) return;
    state.loading = true;
    $('listInfo').textContent = '搜尋附近餐廳中…';
    // 記住可用的資料源:上次走備援且未滿一天 → 直接備援,不浪費時間等 Overpass 逾時
    const pref = store.get(LS.SOURCE, null);
    const useOverpass = !(pref && pref.name === 'nominatim' && Date.now() - pref.ts < 864e5);
    if (useOverpass) {
      const body = 'data=' + encodeURIComponent(
        buildOverpassQuery(state.pos.lat, state.pos.lng, state.filters.radius)
      );
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      };
      const stop = new AbortController();
      try {
        const data = await Promise.any(
          OVERPASS_ENDPOINTS.map(u => timedFetch(u, opts, 9000, stop.signal))
        );
        stop.abort();
        state.restaurants = normalizeAll(data.elements || []);
        state.degraded = false;
        state.loading = false;
        store.set(LS.SOURCE, { name: 'overpass', ts: Date.now() });
        updateCuisineOptions();
        renderAll();
        return;
      } catch { /* 全滅 → 備援 */ }
    }
    try {
      $('listInfo').textContent = '改用備援資料源查詢中…';
      const items = await fetchNominatim();
      state.restaurants = items;
      state.degraded = true;
      state.loading = false;
      store.set(LS.SOURCE, { name: 'nominatim', ts: Date.now() });
      updateCuisineOptions();
      renderAll();
      if (items.length) toast('Overpass 連線失敗,改用備援資料(資訊可能較不完整)');
      return;
    } catch { /* fall through */ }
    state.loading = false;
    $('listInfo').textContent = '查詢失敗';
    const retry = el('button', 'btn retry', '重試');
    retry.onclick = fetchRestaurants;
    $('listInfo').appendChild(retry);
  }

  async function fetchNominatim() {
    const { lat, lng } = state.pos;
    const dLat = state.filters.radius / 111320;
    const dLng = state.filters.radius / (111320 * Math.cos(lat * Math.PI / 180));
    const viewbox = `${lng - dLng},${lat + dLat},${lng + dLng},${lat - dLat}`;
    const seen = new Set();
    const items = [];
    for (let i = 0; i < NOMINATIM_QUERIES.length; i++) {
      $('listInfo').textContent = `備援資料源查詢中…(${i + 1}/${NOMINATIM_QUERIES.length})`;
      const url = `${NOMINATIM}?q=${encodeURIComponent(NOMINATIM_QUERIES[i])}&format=jsonv2` +
        `&bounded=1&viewbox=${viewbox}&limit=50&extratags=1&namedetails=1`;
      const data = await timedFetch(url, {}, 15000);
      for (const p of data) {
        const r = normalizeNominatim(p);
        if (r && !seen.has(r.id)) { seen.add(r.id); items.push(r); }
      }
      await new Promise(ok => setTimeout(ok, 1100)); // Nominatim usage policy: max 1 req/s
    }
    return items;
  }

  function normalizeNominatim(p) {
    const catId = TYPE_TO_CAT[p.type];
    if (!catId) return null;
    const tags = p.extratags || {};
    const nd = p.namedetails || {};
    const name = p.name || nd['name:zh'] || nd.name || tags['brand:zh'] || tags.brand;
    if (!name) return null;
    const lat = +p.lat, lng = +p.lon;
    if (!lat || !lng) return null;
    const cuisine = tags.cuisine ? tags.cuisine.split(';')[0].trim() : null;
    return {
      id: `${p.osm_type}/${p.osm_id}`,
      name, lat, lng,
      catId,
      catLabel: CATEGORY_BY_ID[catId].label,
      cuisine,
      cuisineLabel: cuisineLabel(tags.cuisine),
      openState: getOpenState(tags.opening_hours),
      addr: null,
      distance: haversineMeters(state.pos.lat, state.pos.lng, lat, lng),
      gmaps: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    };
  }

  function normalizeAll(elements) {
    const out = [];
    for (const e of elements) {
      const tags = e.tags || {};
      const name = tags.name || tags['name:zh'] || tags['name:en'];
      if (!name) continue;
      const catId = categoryOf(tags);
      if (!catId) continue;
      const lat = e.lat ?? (e.center && e.center.lat);
      const lng = e.lon ?? (e.center && e.center.lon);
      if (lat === undefined || lng === undefined) continue;
      const cuisine = tags.cuisine ? tags.cuisine.split(';')[0].trim() : null;
      out.push({
        id: `${e.type}/${e.id}`,
        name, lat, lng,
        catId,
        catLabel: CATEGORY_BY_ID[catId].label,
        cuisine,
        cuisineLabel: cuisineLabel(tags.cuisine),
        openState: getOpenState(tags.opening_hours),
        addr: addressOf(tags),
        distance: haversineMeters(state.pos.lat, state.pos.lng, lat, lng),
        gmaps: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      });
    }
    return out;
  }

  function addressOf(tags) {
    if (tags['addr:full']) return tags['addr:full'];
    const parts = [tags['addr:city'], tags['addr:district'], tags['addr:street'], tags['addr:housenumber']]
      .filter(Boolean);
    return parts.length ? parts.join('') : null;
  }

  function getOpenState(ohValue) {
    if (!ohValue || typeof opening_hours !== 'function') return 'unknown';
    try {
      const oh = new opening_hours(ohValue);
      return oh.getState() ? 'open' : 'closed';
    } catch {
      return 'unknown';
    }
  }

  /* ---------- 篩選 ---------- */
  function filtered() {
    const f = state.filters;
    return state.restaurants
      .filter(r => !state.blacklist.has(r.id))
      .filter(r => r.distance <= f.radius)
      .filter(r => f.cats.has(r.catId))
      .filter(r => f.cuisine === 'all' || r.cuisine === f.cuisine)
      .filter(r => !f.openNow || r.openState !== 'closed')
      .filter(r => !f.favOnly || state.favs.has(r.id))
      .sort((a, b) => a.distance - b.distance);
  }

  function saveFilters() {
    store.set(LS.FILTERS, {
      radius: state.filters.radius,
      cats: [...state.filters.cats],
      openNow: state.filters.openNow,
    });
  }

  function initFilters() {
    // 距離按鈕組
    const seg = $('radiusSeg');
    function syncRadius() {
      seg.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', +b.dataset.r === state.filters.radius));
    }
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.filters.radius = +b.dataset.r;
      syncRadius(); saveFilters();
      if (state.pos) { updateUserMarker(); fetchRestaurants(); }
    });
    syncRadius();

    // 類型 checkbox
    const box = $('catChecks');
    for (const def of CATEGORY_DEFS) {
      const lab = el('label', 'check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = state.filters.cats.has(def.id);
      cb.onchange = () => {
        cb.checked ? state.filters.cats.add(def.id) : state.filters.cats.delete(def.id);
        saveFilters(); renderAll();
      };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + def.label));
      box.appendChild(lab);
    }

    $('cuisineSel').onchange = (e) => { state.filters.cuisine = e.target.value; renderAll(); };
    $('openNowChk').checked = state.filters.openNow;
    $('openNowChk').onchange = (e) => { state.filters.openNow = e.target.checked; saveFilters(); renderAll(); };
    $('favOnlyChk').onchange = (e) => { state.filters.favOnly = e.target.checked; renderAll(); };

    $('filterToggle').onclick = () => $('filterPanel').classList.toggle('hidden');
  }

  function updateCuisineOptions() {
    const sel = $('cuisineSel');
    const prev = state.filters.cuisine;
    const seen = new Map();
    for (const r of state.restaurants) {
      if (r.cuisine && !seen.has(r.cuisine)) seen.set(r.cuisine, r.cuisineLabel);
    }
    sel.innerHTML = '';
    sel.appendChild(el('option', null, '全部')).value = 'all';
    for (const [raw, label] of [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh'))) {
      const o = el('option', null, label);
      o.value = raw;
      sel.appendChild(o);
    }
    sel.value = seen.has(prev) ? prev : 'all';
    state.filters.cuisine = sel.value;
  }

  /* ---------- 清單渲染 ---------- */
  const OPEN_TEXT = { open: '營業中', closed: '已打烊', unknown: '營業時間未提供' };

  function renderAll() {
    const items = filtered();
    renderMarkers(items);
    renderList(items);
    renderBlacklist();
  }

  function renderList(items) {
    const list = $('restaurantList');
    list.innerHTML = '';
    $('spinBtn').disabled = items.length === 0;
    if (!state.pos) { $('listInfo').textContent = ''; return; }
    if (state.loading) return;
    if (items.length === 0) {
      $('listInfo').textContent = state.restaurants.length
        ? '沒有符合條件的店,試試放寬篩選'
        : '附近查無餐廳,試試放大範圍';
      return;
    }
    $('listInfo').textContent = `共 ${items.length} 間` + (state.degraded ? '(備援資料)' : '');
    for (const r of items) {
      const card = el('li', 'card');
      card.dataset.id = r.id;

      const main = el('div', 'card-main');
      const title = el('div', 'card-title');
      title.appendChild(el('span', 'name', r.name));
      title.appendChild(el('span', 'badge', r.catLabel));
      main.appendChild(title);
      const sub = el('div', 'card-sub');
      sub.appendChild(el('span', null, [r.cuisineLabel, formatDist(r.distance)].filter(Boolean).join(' · ')));
      sub.appendChild(el('span', `open-${r.openState}`, ' ' + OPEN_TEXT[r.openState]));
      main.appendChild(sub);
      if (r.addr) main.appendChild(el('div', 'card-addr', r.addr));

      const actions = el('div', 'card-actions');
      const fav = el('button', 'icon-btn fav' + (state.favs.has(r.id) ? ' on' : ''), '♥');
      fav.title = '加入最愛';
      fav.onclick = (e) => { e.stopPropagation(); toggleFav(r.id); };
      const ban = el('button', 'icon-btn', '✕');
      ban.title = '加入黑名單';
      ban.onclick = (e) => { e.stopPropagation(); addBlacklist(r); };
      const go = el('a', 'icon-btn', '↗');
      go.href = r.gmaps; go.target = '_blank'; go.rel = 'noopener';
      go.title = '在 Google 地圖開啟';
      go.onclick = (e) => e.stopPropagation();
      actions.append(fav, ban, go);

      card.append(main, actions);
      card.onclick = () => {
        map.setView([r.lat, r.lng], 17);
        const m = markersById.get(r.id);
        if (m) m.openPopup();
      };
      list.appendChild(card);
    }
  }

  /* ---------- 最愛 / 黑名單 / 最近抽過 ---------- */
  function toggleFav(id) {
    state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
    store.set(LS.FAVS, [...state.favs]);
    renderAll();
  }

  function addBlacklist(r) {
    state.blacklist.set(r.id, r.name);
    persistBlacklist();
    toast(`已把「${r.name}」加入黑名單`);
    renderAll();
  }

  function removeBlacklist(id) {
    state.blacklist.delete(id);
    persistBlacklist();
    renderAll();
  }

  function persistBlacklist() {
    store.set(LS.BLACKLIST, [...state.blacklist.entries()].map(([id, name]) => ({ id, name })));
  }

  function renderBlacklist() {
    const box = $('blacklistBox');
    if (state.blacklist.size === 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('blacklistSummary').textContent = `已隱藏 ${state.blacklist.size} 間黑名單`;
    const ul = $('blacklistItems');
    ul.innerHTML = '';
    for (const [id, name] of state.blacklist) {
      const li = el('li', 'bl-item');
      li.appendChild(el('span', null, name));
      const btn = el('button', 'btn btn-ghost', '復原');
      btn.onclick = () => removeBlacklist(id);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  /* ---------- 拉霸 ---------- */
  function spinPool() {
    const base = filtered().filter(r => !state.recent.includes(r.id));
    if (base.length === 0 && state.recent.length > 0) {
      state.recent = [];
      store.set(LS.RECENT, state.recent);
      return filtered();
    }
    return base;
  }

  function spin() {
    const pool = spinPool();
    if (pool.length === 0) { toast('沒有可抽的店,試試放寬條件'); return; }
    const winner = pool[Math.floor(Math.random() * pool.length)];
    openOverlay();
    $('slotResult').classList.add('hidden');
    $('slotActions').classList.add('hidden');
    const nameEl = $('slotName');
    nameEl.classList.remove('done');

    let i = 0;
    const steps = 18 + Math.floor(Math.random() * 8);
    (function tick() {
      nameEl.textContent = pool[i % pool.length].name;
      i++;
      if (i < steps) {
        const t = i / steps;
        setTimeout(tick, 45 + 420 * t * t);
      } else {
        nameEl.textContent = winner.name;
        nameEl.classList.add('done');
        showWinner(winner);
      }
    })();
  }

  function showWinner(r) {
    state.lastWinner = r;
    state.recent.push(r.id);
    if (state.recent.length > RECENT_CAP) state.recent.shift();
    store.set(LS.RECENT, state.recent);

    const res = $('slotResult');
    res.innerHTML = '';
    res.appendChild(el('div', 'res-sub',
      `${r.catLabel}${r.cuisineLabel ? ' · ' + r.cuisineLabel : ''} · ${formatDist(r.distance)} · ${OPEN_TEXT[r.openState]}`));
    if (r.addr) res.appendChild(el('div', 'res-addr', r.addr));
    $('slotGmaps').href = r.gmaps;
    res.classList.remove('hidden');
    $('slotActions').classList.remove('hidden');
  }

  function openOverlay() { $('slotOverlay').classList.remove('hidden'); }
  function closeOverlay() { $('slotOverlay').classList.add('hidden'); }

  /* ---------- init ---------- */
  function init() {
    initMap();
    initFilters();
    renderBlacklist();
    $('locStatus').onclick = () => { state.manualPick = false; locate(); };
    $('spinBtn').onclick = spin;
    $('slotAgain').onclick = spin;
    $('slotClose').onclick = closeOverlay;
    $('slotDone').onclick = () => {
      closeOverlay();
      if (state.lastWinner) {
        map.setView([state.lastWinner.lat, state.lastWinner.lng], 17);
        const m = markersById.get(state.lastWinner.id);
        if (m) m.openPopup();
      }
    };
    locate();
  }

  init();
})();
