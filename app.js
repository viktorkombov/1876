/* ============================================================
   app.js — Априлско въстание 1876
   Static Leaflet map for GitHub Pages
   ============================================================ */

(function () {
  'use strict';

  var DATA = {
    points:       './src/data/april-points-filtered.geojson',
    detachments:  './src/data/april-detachments-filtered.geojson',
    districts:    './src/data/april-district-centers.geojson',
    popup:        './src/data/april-popup-content.json',
    botevRoute:       './src/data/botev-route.geojson',
    botevPoints:      './src/data/botev-timeline-points.geojson',
    botevContent:     './src/data/botev-timeline-content.json',
    chetnitsiPlaces:  './src/data/botev-chetnitsi-places.geojson',
    chetnitsiContent: './src/data/botev-chetnitsi-content.json'
  };

  var TILE_URL    = './src/tiles/{z}/{x}/{y}.png';
  var INIT_CENTER = [42.72, 25.1];
  var INIT_ZOOM   = 7;

  var MARKER_SIZE = {
    'district-center':    26,
    'okrazhen-center':    15,
    'settlement':         14,
    'detachment-point':   15,
    'apostolic-assembly': 15
  };

  var map;
  var popupData   = {};
  var allFeatures = { points: [], detachments: [], districts: [], apostolic: [], okrazhenCenters: [], chetnitsi: [] };
  var layerGroups = { points: null, detachments: null, districts: null, apostolic: null, okrazhenCenters: null, chetnitsi: null };
  var layerOn     = { points: true, detachments: true, districts: true, apostolic: true, okrazhenCenters: true, botev: true, chetnitsi: true };

  var chetnitsiContent = {};

  /* Botev timeline state */
  var botev = {
    routeCoords:   [],     /* flattened [[lat,lng], ...]  */
    points:        [],     /* sorted timeline features    */
    content:       {},
    routeLayer:    null,   /* faint full route            */
    activeLayer:   null,   /* highlighted progress        */
    pointsLayer:   null,
    pointMarkers:  [],
    currentIndex:  -1,
    playing:       false,
    playTimer:     null,
    playInterval:  2500,
    isAnimating:   false
  };

  document.addEventListener('DOMContentLoaded', function () {
    createMap();
    loadData().then(function () {
      renderVisibleLayers();
      return loadBotevTimelineData();
    }).then(function () {
      createBotevRouteLayer();
      createTimelinePointLayer();
      if (layerOn.botev) { showBotevLayers(); }
      initTimelineControl();
      return loadChetnitsiData();
    }).then(function () {
      renderVisibleLayers();
      bindControls();
    });
  });

  function createMap() {
    map = L.map('map', {
      center:             INIT_CENTER,
      zoom:               INIT_ZOOM,
      zoomControl:        true,
      attributionControl: true,
      /* ── Anti-flicker options ────────────────────────────────────
         zoomAnimation      keep the CSS zoom transition (smooth feel)
         zoomAnimationThreshold  only animate when the zoom delta is small;
                            large jumps skip the animation and avoid the
                            blank-tile flash that happens mid-transition.
         fadeAnimation      fade new tiles in instead of popping in;
                            prevents the hard white flash on tile swap.
         markerZoomAnimation keep markers in sync with the tile transition
                            so they don't jump independently.
      ──────────────────────────────────────────────────────────── */
      zoomAnimation:           true,
      zoomAnimationThreshold:  4,
      fadeAnimation:           true,
      markerZoomAnimation:     true
    });

    L.tileLayer(TILE_URL, {
      minZoom:     7,
      maxZoom:     9,
      tms:         false,
      attribution: '© QGIS',
      /* ── Anti-flicker options ────────────────────────────────────
         keepBuffer   number of extra tile rows/columns to keep loaded
                      around the viewport. Default is 2; raising it to 4
                      means adjacent tiles are already cached when the
                      user pans, so there is no blank gap before they
                      appear.  Uses more memory but eliminates the
                      "checkerboard" flash on pan and gentle zooms.
         updateWhenIdle  only request new tiles after panning stops
                         (default on mobile). On desktop this is false
                         which fires many mid-pan requests; setting it
                         true reduces request churn and visual noise.
         updateWhenZooming  false means Leaflet does NOT request new
                            tiles on every intermediate zoom step during
                            a pinch/scroll — only when the zoom settles.
                            This is the single biggest cause of flicker
                            on zoom and should always be false for
                            static/offline tile sets.
      ──────────────────────────────────────────────────────────── */
      keepBuffer:          4,
      updateWhenIdle:      true,
      updateWhenZooming:   false
    }).addTo(map);

    map.on('zoomend', function () {
      renderVisibleLayers();
      document.body.classList.toggle('zoom-7', map.getZoom() === 7);
    });

    document.body.classList.toggle('zoom-7', map.getZoom() === 7);
  }

  function loadData() {
    return Promise.all([
      fetch(DATA.points).then(function (r) { return r.json(); }),
      fetch(DATA.detachments).then(function (r) { return r.json(); }),
      fetch(DATA.districts).then(function (r) { return r.json(); }),
      fetch(DATA.popup).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var pts = results[0].features;
      allFeatures.apostolic       = pts.filter(function (f) { return f.properties.layer_group === 'apostolic'; });
      allFeatures.okrazhenCenters = pts.filter(function (f) { return f.properties.layer_group === 'okrazhen_centers'; });
      allFeatures.points          = pts.filter(function (f) { return f.properties.layer_group === 'points'; });
      allFeatures.detachments     = results[1].features;
      allFeatures.districts       = results[2].features;
      popupData                   = results[3];
    });
  }

  function isFeatureVisible(feature, zoom) {
    var p = feature.properties;
    return zoom >= p.min_zoom && zoom <= p.max_zoom;
  }

  function createMarkerIcon(feature) {
    var sg    = feature.properties.style_group;
    var size  = MARKER_SIZE[sg] || 10;
    var inner = feature.properties.numeral
      ? '<span class="district-numeral">' + feature.properties.numeral + '</span>'
      : '';

    return L.divIcon({
      className:   '',
      html:        '<div class="marker-dot ' + sg + '" style="width:' + size + 'px;height:' + size + 'px;">' + inner + '</div>',
      iconSize:    [size, size],
      iconAnchor:  [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 4)]
    });
  }

  function createMarkerLayer(features) {
    var markers = features.map(function (f) {
      var m = L.marker(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        { icon: createMarkerIcon(f), title: f.properties.name }
      );
      m.on('click', function () { handleMarkerClick(f); });
      return m;
    });
    return L.layerGroup(markers);
  }

  function renderVisibleLayers() {
    var zoom = map.getZoom();

    if (layerGroups.points)         { map.removeLayer(layerGroups.points); }
    if (layerGroups.detachments)    { map.removeLayer(layerGroups.detachments); }
    if (layerGroups.apostolic)      { map.removeLayer(layerGroups.apostolic); }
    if (layerGroups.okrazhenCenters){ map.removeLayer(layerGroups.okrazhenCenters); }
    if (layerGroups.districts)      { map.removeLayer(layerGroups.districts); }
    if (layerGroups.chetnitsi)      { map.removeLayer(layerGroups.chetnitsi); }

    var vis = function (key) {
      return layerOn[key]
        ? allFeatures[key].filter(function (f) { return isFeatureVisible(f, zoom); })
        : [];
    };

    layerGroups.points          = createMarkerLayer(vis('points')).addTo(map);
    layerGroups.detachments     = createMarkerLayer(vis('detachments')).addTo(map);
    layerGroups.apostolic       = createMarkerLayer(vis('apostolic')).addTo(map);
    layerGroups.okrazhenCenters = createMarkerLayer(vis('okrazhenCenters')).addTo(map);
    layerGroups.districts       = createMarkerLayer(vis('districts')).addTo(map);
    layerGroups.chetnitsi       = createChetnitsiLayer(vis('chetnitsi')).addTo(map);
  }

  function openInfoPanel(feature, popupEntry) {
    document.getElementById('sidebar-title').textContent =
      (popupEntry && popupEntry.title) ? popupEntry.title : feature.properties.name;

    document.getElementById('sidebar-content').innerHTML =
      (popupEntry && popupEntry.html) ? popupEntry.html : '';

    document.getElementById('sidebar-source').textContent =
      (popupEntry && popupEntry.source_title) ? popupEntry.source_title : '';

    document.getElementById('sidebar-content').scrollTop = 0;
    document.getElementById('sidebar').classList.add('is-open');
    document.body.classList.add('sidebar-open');
  }

  function closeInfoPanel() {
    document.getElementById('sidebar').classList.remove('is-open');
    document.body.classList.remove('sidebar-open');
  }

  function handleMarkerClick(feature) {
    var entry = popupData[feature.properties.popup_id];
    if (!entry) { return; }

    openInfoPanel(feature, entry);

    var latlng = L.latLng(
      feature.geometry.coordinates[1],
      feature.geometry.coordinates[0]
    );

    if (feature.properties.feature_type === 'district_center' && map.getZoom() <= 7) {
      map.flyTo(latlng, 8, { duration: 1.2, easeLinearity: 0.35 });
    } else {
      map.panTo(latlng);
    }
  }

  function bindControls() {
    document.getElementById('sidebar-close')
      .addEventListener('click', closeInfoPanel);

    document.getElementById('controls-toggle')
      .addEventListener('click', function () {
        var panel = document.getElementById('controls');
        var collapsed = panel.classList.toggle('is-collapsed');
        this.setAttribute('aria-expanded', String(!collapsed));
      });

    document.getElementById('toggle-districts')
      .addEventListener('change', function (e) {
        layerOn.districts = e.target.checked;
        renderVisibleLayers();
      });

    document.getElementById('toggle-okrazhen-centers')
      .addEventListener('change', function (e) {
        layerOn.okrazhenCenters = e.target.checked;
        renderVisibleLayers();
      });

    document.getElementById('toggle-apostolic')
      .addEventListener('change', function (e) {
        layerOn.apostolic = e.target.checked;
        renderVisibleLayers();
      });

    document.getElementById('toggle-points')
      .addEventListener('change', function (e) {
        layerOn.points = e.target.checked;
        renderVisibleLayers();
      });

    document.getElementById('toggle-detachments')
      .addEventListener('change', function (e) {
        layerOn.detachments = e.target.checked;
        renderVisibleLayers();
      });

    var botevToggle = document.getElementById('toggle-botev');
    if (botevToggle) {
      botevToggle.addEventListener('change', function (e) {
        setBotevVisible(e.target.checked);
      });
    }

    var chetToggle = document.getElementById('toggle-chetnitsi');
    if (chetToggle) {
      chetToggle.addEventListener('change', function (e) {
        layerOn.chetnitsi = e.target.checked;
        renderVisibleLayers();
      });
    }
  }

  /* ============================================================
     Botev chetnitsi origins
     ============================================================ */

  function loadChetnitsiData() {
    return Promise.all([
      fetch(DATA.chetnitsiPlaces).then(function (r) { return r.json(); }),
      fetch(DATA.chetnitsiContent).then(function (r) { return r.json(); })
    ]).then(function (results) {
      allFeatures.chetnitsi = (results[0].features || []).slice();
      chetnitsiContent      = results[1] || {};
    }).catch(function (err) {
      console.warn('Chetnitsi data failed to load', err);
    });
  }

  function createChetnitsiLayer(features) {
    var markers = features.map(function (f) {
      var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      return renderChetnitsiMarker(f, ll);
    });
    return L.layerGroup(markers);
  }

  function renderChetnitsiMarker(feature, latlng) {
    var count = feature.properties.count || 0;
    var size  = count >= 10 ? 36 : (count >= 5 ? 32 : 28);
    var icon  = L.divIcon({
      className:   '',
      html:        '<div class="chetnitsi-marker" style="width:' + size + 'px;height:' + size + 'px;"><span class="chetnitsi-marker-count">' + count + '</span></div>',
      iconSize:    [size, size],
      iconAnchor:  [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 4)]
    });
    var m = L.marker(latlng, { icon: icon, title: feature.properties.name });
    m.on('click', function () { openChetnitsiPanel(feature); });
    return m;
  }

  function openChetnitsiPanel(feature) {
    var entry = chetnitsiContent[feature.properties.popup_id];
    if (!entry) {
      entry = { title: feature.properties.name, summary: '', count: feature.properties.count || 0, members: [] };
    }

    document.getElementById('sidebar-title').textContent = entry.title || feature.properties.name;
    document.getElementById('sidebar-content').innerHTML = renderChetnitsiContent(entry);
    document.getElementById('sidebar-source').textContent = entry.source_title || '';
    document.getElementById('sidebar-content').scrollTop = 0;
    document.getElementById('sidebar').classList.add('is-open');
    document.body.classList.add('sidebar-open');

    map.panTo(L.latLng(feature.geometry.coordinates[1], feature.geometry.coordinates[0]));
  }

  function renderChetnitsiContent(entry) {
    var members = Array.isArray(entry.members) ? entry.members : [];
    var count   = (typeof entry.count === 'number') ? entry.count : members.length;

    var html = '<div class="chetnitsi-content">';
    if (entry.summary) {
      html += '<p class="chetnitsi-summary">' + escapeHtml(entry.summary) + '</p>';
    }
    html += '<p class="chetnitsi-count">Общо: <strong>' + count + '</strong> четници</p>';

    if (members.length) {
      html += '<ul class="chetnitsi-members">';
      members.forEach(function (m) {
        html += '<li class="chetnitsi-member-card">';
        html += '<div class="chetnitsi-member-head">';
        html += '<span class="chetnitsi-member-name">' + escapeHtml(m.name || '') + '</span>';
        if (m.years) {
          html += '<span class="chetnitsi-member-years">' + escapeHtml(m.years) + '</span>';
        }
        html += '</div>';
        if (m.role) {
          html += '<div class="chetnitsi-member-role">' + escapeHtml(m.role) + '</div>';
        }
        if (m.info) {
          html += '<div class="chetnitsi-member-info">' + escapeHtml(m.info) + '</div>';
        }
        html += '</li>';
      });
      html += '</ul>';
    }

    html += '</div>';
    return html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ============================================================
     Botev timeline
     ============================================================ */

  function loadBotevTimelineData() {
    return Promise.all([
      fetch(DATA.botevRoute).then(function (r) { return r.json(); }),
      fetch(DATA.botevPoints).then(function (r) { return r.json(); }),
      fetch(DATA.botevContent).then(function (r) { return r.json(); })
    ]).then(function (results) {
      botev.routeCoords = flattenRouteCoords(results[0]);
      botev.points = (results[1].features || []).slice().sort(function (a, b) {
        return (a.properties.order || 0) - (b.properties.order || 0);
      });
      botev.content = results[2] || {};

      botev.points.forEach(function (f) {
        var lng = f.geometry.coordinates[0];
        var lat = f.geometry.coordinates[1];
        f.__routeIndex = nearestRouteVertexIndex(lat, lng);
      });
    }).catch(function (err) {
      // fail soft; existing map keeps working
      console.warn('Botev timeline data failed to load', err);
    });
  }

  function flattenRouteCoords(geojson) {
    var out = [];
    var features = (geojson && geojson.features) || [];
    features.forEach(function (f) {
      var g = f.geometry;
      if (!g) { return; }
      if (g.type === 'LineString') {
        g.coordinates.forEach(function (c) { out.push([c[1], c[0]]); });
      } else if (g.type === 'MultiLineString') {
        g.coordinates.forEach(function (line) {
          line.forEach(function (c) { out.push([c[1], c[0]]); });
        });
      }
    });
    return out;
  }

  function nearestRouteVertexIndex(lat, lng) {
    if (!botev.routeCoords.length) { return 0; }
    var best = 0;
    var bestD = Infinity;
    var cosLat = Math.cos(lat * Math.PI / 180);
    for (var i = 0; i < botev.routeCoords.length; i++) {
      var dy = botev.routeCoords[i][0] - lat;
      var dx = (botev.routeCoords[i][1] - lng) * cosLat;
      var d  = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function createBotevRouteLayer() {
    if (!botev.routeCoords.length) { return; }
    botev.routeLayer = L.polyline(botev.routeCoords, {
      color:       '#6e2c91',
      weight:      3,
      opacity:     0.4,
      dashArray:   '6 6',
      interactive: false,
      className:   'botev-route-bg'
    });
    botev.activeLayer = L.polyline([], {
      color:       '#6e2c91',
      weight:      5,
      opacity:     0.95,
      lineCap:     'round',
      lineJoin:    'round',
      interactive: false,
      className:   'botev-route-active'
    });
  }

  function createTimelinePointLayer() {
    var size = 18;
    var markers = botev.points.map(function (f, idx) {
      var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      var icon = L.divIcon({
        className:   '',
        html:        '<div class="marker-dot timeline-point" data-idx="' + idx + '" style="width:' + size + 'px;height:' + size + 'px;"><span class="timeline-numeral">' + (f.properties.order || (idx + 1)) + '</span></div>',
        iconSize:    [size, size],
        iconAnchor:  [size / 2, size / 2],
        popupAnchor: [0, -(size / 2 + 4)]
      });
      var m = L.marker(ll, { icon: icon, title: f.properties.name });
      m.on('click', function () { goToTimelineStep(idx); });
      return m;
    });
    botev.pointMarkers = markers;
    botev.pointsLayer  = L.layerGroup(markers);
  }

  function showBotevLayers() {
    if (botev.routeLayer  && !map.hasLayer(botev.routeLayer))  { botev.routeLayer.addTo(map); }
    if (botev.activeLayer && !map.hasLayer(botev.activeLayer)) { botev.activeLayer.addTo(map); }
    if (botev.pointsLayer && !map.hasLayer(botev.pointsLayer)) { botev.pointsLayer.addTo(map); }
  }

  function hideBotevLayers() {
    if (botev.routeLayer  && map.hasLayer(botev.routeLayer))  { map.removeLayer(botev.routeLayer); }
    if (botev.activeLayer && map.hasLayer(botev.activeLayer)) { map.removeLayer(botev.activeLayer); }
    if (botev.pointsLayer && map.hasLayer(botev.pointsLayer)) { map.removeLayer(botev.pointsLayer); }
  }

  function setBotevVisible(on) {
    layerOn.botev = !!on;
    var panel = document.getElementById('timeline');
    if (on) {
      showBotevLayers();
      if (panel) { panel.hidden = false; }
      // re-apply active class after markers re-attach
      setTimeout(updateTimelineUI, 0);
    } else {
      pauseTimeline();
      hideBotevLayers();
      if (panel) { panel.hidden = true; }
    }
  }

  function initTimelineControl() {
    var panel = document.getElementById('timeline');
    if (!panel || !botev.points.length) { return; }
    panel.hidden = !layerOn.botev;

    var slider = document.getElementById('timeline-slider');
    if (slider) {
      slider.min   = '0';
      slider.max   = String(Math.max(0, botev.points.length - 1));
      slider.value = '0';
      slider.addEventListener('input', function (e) {
        if (botev.isAnimating) { return; }
        var i = parseInt(e.target.value, 10) || 0;
        goToTimelineStep(i);
      });
    }

    var prev = document.getElementById('timeline-prev');
    if (prev) {
      prev.addEventListener('click', function () {
        if (botev.isAnimating) { return; }
        var i = (botev.currentIndex < 0 ? 0 : botev.currentIndex - 1);
        if (i < 0) { i = 0; }
        goToTimelineStep(i);
      });
    }

    var next = document.getElementById('timeline-next');
    if (next) {
      next.addEventListener('click', function () {
        if (botev.isAnimating) { return; }
        var i = (botev.currentIndex < 0 ? 0 : botev.currentIndex + 1);
        if (i >= botev.points.length) { i = botev.points.length - 1; }
        goToTimelineStep(i);
      });
    }

    var play = document.getElementById('timeline-play');
    if (play) {
      play.addEventListener('click', function () {
        if (botev.playing) { pauseTimeline(); }
        else { playTimeline(); }
      });
    }

    updateTimelineUI();
  }

  function goToTimelineStep(index) {
    if (!botev.points.length) { return; }
    if (index < 0) { index = 0; }
    if (index >= botev.points.length) { index = botev.points.length - 1; }
    botev.currentIndex = index;

    var f  = botev.points[index];
    var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);

    var entry = botev.content[f.properties.popup_id] || { title: f.properties.name, html: '' };
    openInfoPanel(f, entry);

    updateActiveRouteProgress();

    /* Lock navigation for the duration of the fly animation */
    botev.isAnimating = true;
    updateTimelineUI();

    var minZ = f.properties.min_zoom || 8;
    var targetZoom = Math.max(map.getZoom(), minZ);
    if (targetZoom > 9) { targetZoom = 9; }

    map.once('moveend', function () {
      botev.isAnimating = false;
      updateTimelineUI();
    });

    /* setView animates directly to the target without the zoom-out/zoom-in
       "fly" arc of flyTo. flyTo loads tiles at every intermediate zoom level
       and then discards them, which causes the tile flicker. setView with
       animate:true uses a single CSS transition to the destination zoom,
       so tiles are only loaded once at the target zoom level. */
    map.setView(ll, targetZoom, { animate: true, duration: 0.9, easeLinearity: 0.5 });
  }

  function updateActiveRouteProgress() {
    if (!botev.activeLayer || botev.currentIndex < 0) { return; }
    var idx = botev.points[botev.currentIndex].__routeIndex || 0;
    var slice = botev.routeCoords.slice(0, idx + 1);
    botev.activeLayer.setLatLngs(slice);
  }

  function updateTimelineUI() {
    var f = botev.currentIndex >= 0 ? botev.points[botev.currentIndex] : null;

    var dateEl = document.getElementById('timeline-date');
    var nameEl = document.getElementById('timeline-name');
    var slider = document.getElementById('timeline-slider');
    var play   = document.getElementById('timeline-play');

    var prevBtn = document.getElementById('timeline-prev');
    var nextBtn = document.getElementById('timeline-next');

    if (dateEl) { dateEl.textContent = f ? f.properties.date_label : '—'; }
    if (nameEl) { nameEl.textContent = f ? f.properties.name : 'Походът на Ботевата чета'; }
    if (slider) { slider.value = botev.currentIndex >= 0 ? String(botev.currentIndex) : '0'; }
    if (play)   { play.textContent = botev.playing ? '❚❚ Пауза' : '▶ Пусни'; }

    /* Disable / enable Prev & Next during fly animation */
    if (prevBtn) { prevBtn.disabled = botev.isAnimating; }
    if (nextBtn) { nextBtn.disabled = botev.isAnimating; }

    botev.pointMarkers.forEach(function (m, i) {
      var el = m.getElement();
      if (!el) { return; }
      var dot = el.querySelector('.marker-dot');
      if (!dot) { return; }
      if (i === botev.currentIndex) { dot.classList.add('is-active'); }
      else { dot.classList.remove('is-active'); }
    });
  }

  function playTimeline() {
    if (!botev.points.length) { return; }
    botev.playing = true;
    if (botev.currentIndex < 0) { goToTimelineStep(0); }
    if (botev.playTimer) { clearInterval(botev.playTimer); }
    botev.playTimer = setInterval(function () {
      var nxt = botev.currentIndex + 1;
      if (nxt >= botev.points.length) { pauseTimeline(); return; }
      goToTimelineStep(nxt);
    }, botev.playInterval);
    updateTimelineUI();
  }

  function pauseTimeline() {
    botev.playing = false;
    if (botev.playTimer) { clearInterval(botev.playTimer); botev.playTimer = null; }
    updateTimelineUI();
  }

})();
