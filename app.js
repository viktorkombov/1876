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
  var TIMELINE_ZOOM = 8;

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
  var layerOn     = { points: true, detachments: true, districts: true, apostolic: true, okrazhenCenters: true, botev: true, chetnitsi: false };

  var chetnitsiContent    = {};
  var chetnitsiUserDisabled = false; /* becomes true only if user explicitly unchecks */

  /* Botev timeline state */
  var botev = {
    routeCoords:    [],
    points:         [],
    content:        {},
    routeLayer:     null,  /* faint background polyline (always visible)           */
    curveLayer:     null,  /* L.curve drawn via stroke-dashoffset                  */
    pointsLayer:    null,  /* layer group — markers added lazily                   */
    pointMarkers:   [],
    revealedUpTo:   -1,
    routeFractions: [],    /* [0..1] position of each point along route            */
    _routeCumDist:  [],
    _routeTotalDist: 0,
    _svgPathLength:  0,    /* current SVG pixel path length                        */
    _drawnFraction:  0,    /* fraction of route currently drawn (0–1)              */
    _rafHandle:      null, /* cancelAnimationFrame id                              */
    _segTimer:       null, /* setTimeout id (pause between segments)               */
    _segTargetFrac:  0,    /* toFraction of the segment currently animating        */
    _segIdx:         -1,   /* index of the segment currently animating             */
    currentIndex:   -1,
    playing:        false,
    isAnimating:    false,
    panelCollapsed: false
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

    /* Chetnitsi cluster is NEVER destroyed on zoom — markercluster handles
       zoom-based clustering internally. We only create it once (when data
       is available) and then just add/remove from the map.  Destroying and
       recreating on every zoomend kills the CSS fly-out transition mid-air. */
    if (!layerGroups.chetnitsi && allFeatures.chetnitsi.length) {
      layerGroups.chetnitsi = createChetnitsiLayer(allFeatures.chetnitsi);
    }
    if (layerGroups.chetnitsi) {
      if (layerOn.chetnitsi && !map.hasLayer(layerGroups.chetnitsi)) {
        layerGroups.chetnitsi.addTo(map);
      } else if (!layerOn.chetnitsi && map.hasLayer(layerGroups.chetnitsi)) {
        map.removeLayer(layerGroups.chetnitsi);
      }
    }
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
        layerOn.chetnitsi       = e.target.checked;
        chetnitsiUserDisabled   = !e.target.checked;
        if (layerGroups.chetnitsi) {
          if (layerOn.chetnitsi) { layerGroups.chetnitsi.addTo(map); }
          else { map.removeLayer(layerGroups.chetnitsi); }
        }
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

  /* Returns px diameter for a chetnitsi marker scaled by sqrt of count.
     Range for count 1-11: 20-34 px. Clusters can go up to ~60 px. */
  function chetnitsiMarkerSize(count) {
    return Math.min(60, Math.round(14 + 6 * Math.sqrt(Math.max(1, count))));
  }

  function createChetnitsiLayer(features) {
    var cluster = L.markerClusterGroup({
      disableClusteringAtZoom: 9,   /* at max zoom show all individually   */
      maxClusterRadius:        60,
      spiderfyOnMaxZoom:       false,
      showCoverageOnHover:     false,
      zoomToBoundsOnClick:     false, /* handled manually below for padding + animation */
      iconCreateFunction: function (clusterObj) {
        var total = 0;
        clusterObj.getAllChildMarkers().forEach(function (m) {
          total += m.options._chetnitsiCount || 0;
        });
        var size     = chetnitsiMarkerSize(total);
        var fontSize = Math.min(13, Math.max(9, Math.round(size * 0.45)));
        return L.divIcon({
          className:   '',
          html:        '<div class="chetnitsi-marker" style="width:' + size + 'px;height:' + size + 'px;"><span class="chetnitsi-marker-count" style="font-size:' + fontSize + 'px">' + total + '</span></div>',
          iconSize:    [size, size],
          iconAnchor:  [size / 2, size / 2]
        });
      }
    });

    /* fitBounds fires the discrete zoomanim event that markercluster needs
       to position each child at the cluster center before the CSS transition
       flies it to its real position. flyToBounds skips that event entirely. */
    cluster.on('clusterclick', function (e) {
      map.flyToBounds(e.layer.getBounds(), {
        padding:  [48, 48],
        maxZoom:  9,
        duration: 0.6,
        easeLinearity: 0.4
      });
    });


    features.forEach(function (f) {
      var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      cluster.addLayer(renderChetnitsiMarker(f, ll));
    });
    return cluster;
  }

  function renderChetnitsiMarker(feature, latlng) {
    var count    = feature.properties.count || 0;
    var size     = chetnitsiMarkerSize(count);
    var fontSize = Math.min(13, Math.max(9, Math.round(size * 0.45)));
    var icon = L.divIcon({
      className:   '',
      html:        '<div class="chetnitsi-marker" style="width:' + size + 'px;height:' + size + 'px;"><span class="chetnitsi-marker-count" style="font-size:' + fontSize + 'px">' + count + '</span></div>',
      iconSize:    [size, size],
      iconAnchor:  [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 4)]
    });
    var m = L.marker(latlng, { icon: icon, title: feature.properties.name, _chetnitsiCount: count });
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
      buildRouteFractions();
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

  /* ── Build smooth Catmull-Rom cubic-bezier path for L.curve ─ */
  function buildCurvePath(coords) {
    /* Subsample so the SVG path stays reasonable in size */
    var step = Math.max(1, Math.floor(coords.length / 160));
    var pts  = [];
    for (var i = 0; i < coords.length; i += step) { pts.push(coords[i]); }
    if (pts[pts.length - 1] !== coords[coords.length - 1]) {
      pts.push(coords[coords.length - 1]);
    }
    if (pts.length < 2) { return ['M', pts[0] || [0,0], 'L', pts[0] || [0,0]]; }
    var path = ['M', pts[0]];
    for (var j = 1; j < pts.length; j++) {
      var p0 = pts[Math.max(0, j - 2)];
      var p1 = pts[j - 1];
      var p2 = pts[j];
      var p3 = pts[Math.min(pts.length - 1, j + 1)];
      /* Catmull-Rom → cubic bezier (tension 1/6) */
      var cp1 = [ p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6 ];
      var cp2 = [ p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6 ];
      path.push('C', cp1, cp2, p2);
    }
    return path;
  }

  function buildRouteFractions() {
    var coords = botev.routeCoords;
    if (!coords.length) { return; }
    var cum = [0];
    for (var i = 1; i < coords.length; i++) {
      var a = coords[i - 1], b = coords[i];
      var dy = b[0] - a[0];
      var dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180);
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    var total = cum[cum.length - 1] || 1;
    botev._routeCumDist   = cum;
    botev._routeTotalDist = total;
    botev.routeFractions  = botev.points.map(function (f) {
      var idx = Math.min(f.__routeIndex || 0, cum.length - 1);
      return cum[idx] / total;
    });
  }

  function createBotevRouteLayer() {
    if (!botev.routeCoords.length) { return; }

    /* Ghost: full route, always visible, very faint */
    botev.routeLayer = L.polyline(botev.routeCoords, {
      color:       '#9b59b6',
      weight:      2,
      opacity:     0.18,
      dashArray:   '3 11',
      interactive: false,
      className:   'botev-route-bg'
    });

    /* Animated drawing line using L.curve + stroke-dashoffset */
    botev.curveLayer = L.curve(buildCurvePath(botev.routeCoords), {
      color:       '#6e2c91',
      weight:      3.5,
      opacity:     0.9,
      dashArray:   '10 8',
      lineCap:     'round',
      lineJoin:    'round',
      fill:        false,
      interactive: false,
      className:   'botev-route-active'
    });

    /* After any Leaflet redraw (pan/zoom) the SVG pixel lengths change;
       patch _updatePath so we restore dasharray/dashoffset proportionally. */
    var _orig = botev.curveLayer._updatePath.bind(botev.curveLayer);
    botev.curveLayer._updatePath = function () {
      _orig();
      restoreSvgDashoffset();
    };
  }

  function createTimelinePointLayer() {
    botev.pointMarkers = botev.points.map(function (f, idx) {
      var ll  = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      var num = f.properties.order || (idx + 1);
      var icon = L.divIcon({
        className:   '',
        html:        '<div class="botev-lm">' +
                     '<div class="botev-lm-bubble"><span class="botev-lm-num">' + num + '</span></div>' +
                     '<div class="botev-lm-stem"></div>' +
                     '<div class="botev-lm-dot"></div>' +
                     '<div class="botev-lm-label">' + escapeHtml(f.properties.name) + '</div>' +
                     '</div>',
        iconSize:    [34, 62],
        iconAnchor:  [17, 57],
        popupAnchor: [60, -57]
      });
      var m = L.marker(ll, { icon: icon, title: f.properties.name });
      m.on('click', function () { goToTimelineStep(idx); });
      return m;
    });
    /* Empty group — markers are added one-by-one as steps are reached */
    botev.pointsLayer = L.layerGroup([]);
  }

  function showBotevLayers() {
    if (botev.routeLayer  && !map.hasLayer(botev.routeLayer))  { botev.routeLayer.addTo(map); }
    if (botev.curveLayer  && !map.hasLayer(botev.curveLayer))  {
      botev.curveLayer.addTo(map);
      initSvgLength();
    }
    if (botev.pointsLayer && !map.hasLayer(botev.pointsLayer)) { botev.pointsLayer.addTo(map); }
  }

  function hideBotevLayers() {
    cancelAnimation();
    if (botev.routeLayer  && map.hasLayer(botev.routeLayer))  { map.removeLayer(botev.routeLayer); }
    if (botev.curveLayer  && map.hasLayer(botev.curveLayer))  { map.removeLayer(botev.curveLayer); }
    if (botev.pointsLayer && map.hasLayer(botev.pointsLayer)) { map.removeLayer(botev.pointsLayer); }
  }

  function setBotevVisible(on) {
    layerOn.botev = !!on;
    var panel = document.getElementById('timeline');
    var stub  = document.getElementById('timeline-stub');
    if (on) {
      showBotevLayers();
      if (botev.panelCollapsed) {
        if (panel) { panel.hidden = true; }
        if (stub)  { stub.hidden  = false; }
      } else {
        if (panel) { panel.hidden = false; }
        if (stub)  { stub.hidden  = true; }
      }
      // re-apply active class after markers re-attach
      setTimeout(updateTimelineUI, 0);
    } else {
      pauseTimeline();
      hideBotevLayers();
      if (panel) { panel.hidden = true; }
      if (stub)  { stub.hidden  = true; }
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
      slider.addEventListener('change', function (e) {
        if (botev.isAnimating) { return; }
        if (botev.playing) { pauseTimeline(); }
        var i = parseInt(e.target.value, 10);
        if (isNaN(i)) { i = 0; }
        goToTimelineStep(i);
      });
    }

    var prev = document.getElementById('timeline-prev');
    if (prev) {
      prev.addEventListener('click', function () {
        if (botev.isAnimating) { return; }
        if (botev.playing) { pauseTimeline(); }
        var i = (botev.currentIndex < 0 ? 0 : botev.currentIndex - 1);
        if (i < 0) { i = 0; }
        goToTimelineStep(i);
      });
    }

    var next = document.getElementById('timeline-next');
    if (next) {
      next.addEventListener('click', function () {
        if (botev.isAnimating) { return; }
        if (botev.playing) { pauseTimeline(); }
        var i = (botev.currentIndex < 0 ? 0 : botev.currentIndex + 1);
        if (i >= botev.points.length) { i = botev.points.length - 1; }
        goToTimelineStep(i);
      });
    }

    var play = document.getElementById('timeline-play');
    if (play) {
      play.addEventListener('click', function () {
        if (botev.isAnimating) { return; }
        var isFinished = !botev.playing &&
          botev.currentIndex >= 0 &&
          botev.currentIndex >= botev.points.length - 1;
        var isPaused = !botev.playing && botev._segIdx >= 0 &&
          botev.currentIndex < botev.points.length - 1;
        if (isFinished) {
          restartTimeline();
        } else if (botev.playing) {
          pauseTimeline();
        } else if (isPaused) {
          /* Resume from wherever the line stopped mid-draw */
          botev.playing = true;
          updateTimelineUI();
          playFromIndex(botev._segIdx);
        } else {
          playTimeline();
        }
      });
    }

    var stop = document.getElementById('timeline-stop');
    if (stop) {
      stop.addEventListener('click', function () {
        var isFinished = !botev.playing &&
          botev.currentIndex >= 0 &&
          botev.currentIndex >= botev.points.length - 1;
        var isPaused = !botev.playing && botev._segIdx >= 0 &&
          botev.currentIndex < botev.points.length - 1;
        if (botev.playing) {
          resetTimeline();
        } else if (isPaused || isFinished) {
          resetTimeline();
          collapseTimelinePanel();
        }
      });
    }

    /* ── Panel collapse / expand ─────────────────────────── */
    var collapseBtn = document.getElementById('timeline-collapse');
    var stub        = document.getElementById('timeline-stub');

    if (collapseBtn) {
      collapseBtn.addEventListener('click', function () { collapseTimelinePanel(); });
    }
    if (stub) {
      stub.addEventListener('click', function () { expandTimelinePanel(); });
    }

    updateTimelineUI();
  }

  function collapseTimelinePanel() {
    botev.panelCollapsed = true;
    var panel = document.getElementById('timeline');
    var stub  = document.getElementById('timeline-stub');
    if (panel) { panel.hidden = true; }
    if (stub)  { stub.hidden  = false; }
  }

  function expandTimelinePanel() {
    botev.panelCollapsed = false;
    var panel = document.getElementById('timeline');
    var stub  = document.getElementById('timeline-stub');
    if (panel) { panel.hidden = false; }
    if (stub)  { stub.hidden  = true; }
  }

  function goToTimelineStep(index) {
    if (!botev.points.length) { return; }
    if (index < 0) { index = 0; }
    if (index >= botev.points.length) { index = botev.points.length - 1; }

    cancelAnimation();
    botev.currentIndex = index;
    botev._segIdx      = index;

    /* Reveal all markers up to this step; the target one animates in. */
    revealMarkersUpTo(index);
    setRouteProgress(botev.routeFractions[index] || 0);

    var f  = botev.points[index];
    var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);

    var entry = botev.content[f.properties.popup_id] || { title: f.properties.name, html: '' };
    openInfoPanel(f, entry);

    /* Lock navigation for the duration of the fly animation */
    botev.isAnimating = true;
    updateTimelineUI();

    map.once('moveend', function () {
      botev.isAnimating = false;
      updateTimelineUI();
    });

    /* Point 5 (Козлодуй, index 4): fly smoothly to zoom 8 */
    var minZ = f.properties.min_zoom || 8;
    var targetZoom = Math.max(map.getZoom(), minZ);
    if (targetZoom > 8) { targetZoom = 8; }
    map.setView(ll, targetZoom, { animate: true, duration: 0.9, easeLinearity: 0.5 });
  }

  /* ── SVG stroke-dashoffset helpers ──────────────────────── */

  function initSvgLength() {
    if (!botev.curveLayer || !botev.curveLayer._path) { return; }
    var el  = botev.curveLayer._path;
    var len = el.getTotalLength() || 1;
    botev._svgPathLength = len;
    el.style.strokeDasharray  = len + ' ' + len;
    el.style.strokeDashoffset = len * (1 - botev._drawnFraction);
  }

  function restoreSvgDashoffset() {
    if (!botev.curveLayer || !botev.curveLayer._path) { return; }
    var el  = botev.curveLayer._path;
    var len = el.getTotalLength() || botev._svgPathLength || 1;
    botev._svgPathLength      = len;
    el.style.strokeDasharray  = len + ' ' + len;
    el.style.strokeDashoffset = len * (1 - botev._drawnFraction);
  }

  function setRouteProgress(fraction) {
    botev._drawnFraction = Math.max(0, Math.min(1, fraction));
    if (!botev.curveLayer || !botev.curveLayer._path || !botev._svgPathLength) { return; }
    botev.curveLayer._path.style.strokeDashoffset =
      botev._svgPathLength * (1 - botev._drawnFraction);
  }

  function cancelAnimation() {
    if (botev._rafHandle) { cancelAnimationFrame(botev._rafHandle); botev._rafHandle = null; }
    if (botev._segTimer)  { clearTimeout(botev._segTimer);          botev._segTimer  = null; }
  }

  /* ── Core segment animation using rAF ───────────────────── */

  /* Return the lat/lng on the route at a given fraction [0..1] */
  function latlngAtFraction(frac) {
    var cum    = botev._routeCumDist;
    var coords = botev.routeCoords;
    if (!cum.length || !coords.length) { return null; }
    var target = frac * botev._routeTotalDist;
    /* Binary search for the segment */
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= target) { lo = mid; } else { hi = mid; }
    }
    var segLen = cum[hi] - cum[lo];
    var t = segLen > 0 ? (target - cum[lo]) / segLen : 0;
    var a = coords[lo], b = coords[hi];
    return L.latLng(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
  }

  function animateSegment(fromFraction, toFraction, duration, onComplete) {
    cancelAnimation();
    var startTime   = null;
    var panFrame    = 0;       /* counter to throttle pan checks to every 20 frames */
    var panPending  = false;   /* avoid queuing multiple pans */
    function tick(ts) {
      if (!botev.playing) { return; }
      if (!startTime) { startTime = ts; }
      var elapsed = ts - startTime;
      var t = Math.min(elapsed / duration, 1);
      t = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; /* ease-in-out quad */
      var curFrac = fromFraction + t * (toFraction - fromFraction);
      setRouteProgress(curFrac);

      /* Auto-pan: keep the drawn line tip visible.
         Check every 20 frames (~330 ms at 60 fps) and only if not already panning. */
      if (!panPending && ++panFrame % 20 === 0) {
        var tip = latlngAtFraction(curFrac);
        if (tip) {
          var bounds  = map.getBounds();
          var sw      = bounds.getSouthWest();
          var ne      = bounds.getNorthEast();
          var latSpan = ne.lat - sw.lat;
          var lngSpan = ne.lng - sw.lng;
          var margin  = 0.15;   /* 15 % of the viewport from each edge */
          var inBounds =
            tip.lat > sw.lat + latSpan * margin &&
            tip.lat < ne.lat - latSpan * margin &&
            tip.lng > sw.lng + lngSpan * margin &&
            tip.lng < ne.lng - lngSpan * margin;
          if (!inBounds) {
            panPending = true;
            map.panTo(tip, { animate: true, duration: 0.6, easeLinearity: 0.5 });
            map.once('moveend', function () { panPending = false; });
          }
        }
      }

      if (elapsed < duration) {
        botev._rafHandle = requestAnimationFrame(tick);
      } else {
        botev._rafHandle = null;
        setRouteProgress(toFraction);
        if (onComplete) { onComplete(); }
      }
    }
    botev._rafHandle = requestAnimationFrame(tick);
  }

  /* ── Chain through segments during auto-play ─────────────── */

  function playFromIndex(segIdx) {
    if (!botev.playing) { return; }
    if (segIdx >= botev.points.length) {
      botev.playing = false;
      updateTimelineUI();
      revealChetnitsiLayer();
      return;
    }
    botev._segIdx         = segIdx;
    var fromFraction      = botev._drawnFraction;        /* resume from current visual position */
    var prevFrac          = segIdx === 0 ? 0 : (botev.routeFractions[segIdx - 1] || 0);
    var toFraction        = botev.routeFractions[segIdx] || prevFrac;
    botev._segTargetFrac  = toFraction;
    /* Duration proportional to segment distance; capped at 3.5 s */
    var segFrac  = Math.max(0.001, toFraction - prevFrac);
    var duration = Math.min(3500, Math.max(1200, segFrac * 18000));

    animateSegment(fromFraction, toFraction, duration, function () {
      if (!botev.playing) { return; }
      /* Line reached this point — reveal the marker now */
      botev.currentIndex = segIdx;
      revealMarkersUpTo(segIdx);
      var f     = botev.points[segIdx];
      var entry = botev.content[f.properties.popup_id] || { title: f.properties.name, html: '' };
      openInfoPanel(f, entry);
      var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      map.panTo(ll, { animate: true, duration: 0.5 });
      updateTimelineUI();
      /* Brief pause so the user can see the popup, then continue */
      botev._segTimer = setTimeout(function () {
        botev._segTimer = null;
        playFromIndex(segIdx + 1);
      }, 900);
    });
  }

  function updateTimelineUI() {
    var f = botev.currentIndex >= 0 ? botev.points[botev.currentIndex] : null;
    var isFinished = !botev.playing &&
      botev.currentIndex >= 0 &&
      botev.currentIndex >= botev.points.length - 1;
    /* Paused mid-animation: line is somewhere between two points */
    var isPaused = !botev.playing && botev._segIdx >= 0 &&
      botev.currentIndex < botev.points.length - 1;

    var dateEl  = document.getElementById('timeline-date');
    var nameEl  = document.getElementById('timeline-name');
    var slider  = document.getElementById('timeline-slider');
    var play    = document.getElementById('timeline-play');
    var stopBtn = document.getElementById('timeline-stop');
    var prevBtn = document.getElementById('timeline-prev');
    var nextBtn = document.getElementById('timeline-next');

    /* While playing: only Stop and Pause/Play are usable */
    var locked = botev.playing || botev.isAnimating;

    if (dateEl) { dateEl.textContent = f ? f.properties.date_label : ''; }
    if (nameEl) { nameEl.textContent = f ? f.properties.name : 'Походът на Ботевата чета'; }
    if (slider) {
      slider.value    = botev.currentIndex >= 0 ? String(botev.currentIndex) : '0';
      slider.disabled = locked;
    }
    if (play) {
      if (isFinished)         { play.textContent = '↺ Отначало'; }
      else if (botev.playing) { play.textContent = '❚❚ Пауза'; }
      else if (isPaused)      { play.textContent = '▶ Продължи'; }
      else                    { play.textContent = '▶ Пусни'; }
      play.disabled = botev.isAnimating && !botev.playing;
    }
    if (stopBtn) {
      var isActive = botev.playing || isPaused || isFinished;
      stopBtn.textContent = isActive && !botev.playing ? '✖ Затвори' : '■ Спри';
      stopBtn.disabled = !isActive;
    }
    if (prevBtn) { prevBtn.disabled = locked; }
    if (nextBtn) { nextBtn.disabled = locked; }

    /* Lock map interaction while timeline is playing */
    if (botev.playing) {
      map.scrollWheelZoom.disable();
      map.dragging.disable();
      map.touchZoom.disable();
      map.doubleClickZoom.disable();
      document.body.classList.add('timeline-playing');
    } else {
      map.scrollWheelZoom.enable();
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      document.body.classList.remove('timeline-playing');
    }

    botev.pointMarkers.forEach(function (m, i) {
      var el = m.getElement();
      if (!el) { return; }
      var lm = el.querySelector('.botev-lm');
      if (!lm) { return; }
      if (i === botev.currentIndex) { lm.classList.add('is-active'); }
      else { lm.classList.remove('is-active'); }
    });
  }

  /* ── Reveal markers up to (and including) targetIdx ─────────
     Markers before targetIdx appear without animation (instant);
     the marker AT targetIdx gets the CSS appear animation because
     it is freshly inserted into the DOM.                         */
  function revealMarkersUpTo(targetIdx) {
    if (!botev.pointsLayer) { return; }
    /* Instantly reveal any skipped markers */
    for (var j = botev.revealedUpTo + 1; j < targetIdx; j++) {
      var mj = botev.pointMarkers[j];
      if (mj && !botev.pointsLayer.hasLayer(mj)) {
        /* Suppress animation for catch-up reveals */
        mj.once('add', function () {
          var el = this.getElement();
          if (el) {
            var lm = el.querySelector('.botev-lm');
            if (lm) { lm.classList.add('no-anim'); }
          }
        });
        botev.pointsLayer.addLayer(mj);
      }
    }
    /* Reveal current marker with the appear animation */
    var mc = botev.pointMarkers[targetIdx];
    if (mc && !botev.pointsLayer.hasLayer(mc)) {
      botev.pointsLayer.addLayer(mc);
    }
    botev.revealedUpTo = Math.max(botev.revealedUpTo, targetIdx);
  }

  function playTimeline() {
    if (!botev.points.length || !botev.routeFractions.length) { return; }
    var startAt = botev.currentIndex < 0 ? 0 : botev.currentIndex + 1;
    if (startAt >= botev.points.length) {
      botev.playing = false;
      updateTimelineUI();
      return;
    }
    botev.playing = true;
    updateTimelineUI();
    /* When starting from the very beginning, fly to zoom 9 first
       so the route draws at an intimate scale from the start.    */
    if (startAt === 0 && map.getZoom() < 9) {
      var f0 = botev.points[0];
      var ll0 = L.latLng(f0.geometry.coordinates[1], f0.geometry.coordinates[0]);
      map.flyTo(ll0, TIMELINE_ZOOM, { duration: 1.2, easeLinearity: 0.35 });
      map.once('moveend', function () { playFromIndex(startAt); });
    } else {
      playFromIndex(startAt);
    }
  }

  function pauseTimeline() {
    botev.playing = false;
    cancelAnimation();
    updateTimelineUI();
  }

  /* Auto-reveal the chetnitsi layer when the full route play finishes,
     unless the user has explicitly toggled it off. */
  function revealChetnitsiLayer() {
    /* Zoom out to overview first, then reveal chetnitsi and collapse panel */
    map.flyTo(INIT_CENTER, INIT_ZOOM, { duration: 1.4, easeLinearity: 0.35 });
    map.once('moveend', function () {
      if (chetnitsiUserDisabled) { return; }
      if (!layerOn.chetnitsi) {
        layerOn.chetnitsi = true;
        var cb = document.getElementById('toggle-chetnitsi');
        if (cb) { cb.checked = true; }

        document.body.classList.add('chetnitsi-reveal');

        if (layerGroups.chetnitsi && !map.hasLayer(layerGroups.chetnitsi)) {
          layerGroups.chetnitsi.addTo(map);
        } else if (!layerGroups.chetnitsi && allFeatures.chetnitsi.length) {
          layerGroups.chetnitsi = createChetnitsiLayer(allFeatures.chetnitsi);
          layerGroups.chetnitsi.addTo(map);
        }

        setTimeout(function () {
          document.body.classList.remove('chetnitsi-reveal');
        }, 900);
      }
    });
  }

  function resetTimeline() {
    cancelAnimation();
    botev.playing      = false;
    botev.currentIndex = -1;
    botev._segIdx      = -1;

    /* Remove all revealed markers so they animate in fresh */
    botev.pointMarkers.forEach(function (m) {
      if (botev.pointsLayer && botev.pointsLayer.hasLayer(m)) {
        botev.pointsLayer.removeLayer(m);
      }
    });
    botev.revealedUpTo = -1;

    /* Hide chetnitsi layer and reset its state */
    layerOn.chetnitsi       = false;
    chetnitsiUserDisabled   = false; /* allow auto-reveal again after next full play */
    var cb = document.getElementById('toggle-chetnitsi');
    if (cb) { cb.checked = false; }
    if (layerGroups.chetnitsi && map.hasLayer(layerGroups.chetnitsi)) {
      // TODO:isntead of removing the layer when closing timeline, we should hide only the timeline-related features and keep the layer with the rest of the chetnitsi features, so that when user opens timeline again, we can just show the layer without having to recreate it and re-add all features to it
      // map.removeLayer(layerGroups.chetnitsi);
    }

    setRouteProgress(0);

    updateTimelineUI();
  }

  function restartTimeline() {
    resetTimeline();
    /* Wait for the fly to finish, then auto-play */
    setTimeout(function () { playTimeline(); }, 1300);
  }

})();
