/* ============================================================
   app.js — Априлско въстание 1876
   Static Leaflet map for GitHub Pages
   ============================================================ */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────

  var DATA = {
    points:      './src/data/april-points-filtered.geojson',
    detachments: './src/data/april-detachments-filtered.geojson',
    districts:   './src/data/april-district-centers.geojson',
    popup:       './src/data/april-popup-content.json'
  };

  var TILE_URL    = './src/tiles/{z}/{x}/{y}.png';
  var INIT_CENTER = [42.72, 25.1];
  var INIT_ZOOM   = 7;

  // Pixel size of the dot for each style_group
  var MARKER_SIZE = {
    'district-center':  26,
    'settlement':      14,
    'detachment-point': 15
  };

  // Roman numeral labels for district center markers
  var DISTRICT_ROMAN = {
    'Търново':    'I',
    'Сливен':     'II',
    'Враца':      'III',
    'Панагюрище': 'IV'
  };

  // ── State ────────────────────────────────────────────────────────────────

  var map;
  var popupData   = {};
  var allFeatures = { points: [], detachments: [], districts: [] };
  var layerGroups = { points: null, detachments: null, districts: null };
  var layerOn     = { points: true, detachments: true, districts: true };

  // ── Bootstrap ────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    createMap();
    loadData().then(function () {
      renderVisibleLayers();
      bindControls();
    });
  });

  // ── createMap ────────────────────────────────────────────────────────────

  function createMap() {
    map = L.map('map', {
      center:           INIT_CENTER,
      zoom:             INIT_ZOOM,
      zoomControl:      true,
      attributionControl: true
    });

    L.tileLayer(TILE_URL, {
      minZoom:     7,
      maxZoom:     9,
      tms:         false,
      attribution: '© QGIS'
    }).addTo(map);

    map.on('zoomend', function () {
      renderVisibleLayers();
      document.body.classList.toggle('zoom-7', map.getZoom() === 7);
    });

    // Set initial state
    document.body.classList.toggle('zoom-7', map.getZoom() === 7);
  }

  // ── loadData ─────────────────────────────────────────────────────────────

  function loadData() {
    return Promise.all([
      fetch(DATA.points).then(function (r) { return r.json(); }),
      fetch(DATA.detachments).then(function (r) { return r.json(); }),
      fetch(DATA.districts).then(function (r) { return r.json(); }),
      fetch(DATA.popup).then(function (r) { return r.json(); })
    ]).then(function (results) {
      allFeatures.points      = results[0].features;
      allFeatures.detachments = results[1].features;
      allFeatures.districts   = results[2].features;
      popupData               = results[3];
    });
  }

  // ── Visibility ───────────────────────────────────────────────────────────

  function isFeatureVisible(feature, zoom) {
    var p = feature.properties;
    return zoom >= p.min_zoom && zoom <= p.max_zoom;
  }

  // ── Marker icon ──────────────────────────────────────────────────────────

  function createMarkerIcon(feature) {
    var sg   = feature.properties.style_group;
    var size = MARKER_SIZE[sg] || 10;
    var inner = '';

    if (sg === 'district-center') {
      var roman = DISTRICT_ROMAN[feature.properties.name] || '';
      inner = '<span class="district-numeral">' + roman + '</span>';
    }

    return L.divIcon({
      className:   '',   // suppress Leaflet's default white box
      html:        '<div class="marker-dot ' + sg + '" style="width:' + size + 'px;height:' + size + 'px;">' + inner + '</div>',
      iconSize:    [size, size],
      iconAnchor:  [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 4)]
    });
  }

  // ── Layer builders ───────────────────────────────────────────────────────

  function createPointLayer(features) {
    var markers = features.map(function (f) {
      var m = L.marker(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        { icon: createMarkerIcon(f), title: f.properties.name }
      );
      m.on('click', function () { handleFeatureClick(f, m); });
      return m;
    });
    return L.layerGroup(markers);
  }

  function createDetachmentLayer(features) {
    var markers = features.map(function (f) {
      var m = L.marker(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        { icon: createMarkerIcon(f), title: f.properties.name }
      );
      m.on('click', function () { handleFeatureClick(f, m); });
      return m;
    });
    return L.layerGroup(markers);
  }

  function createDistrictLayer(features) {
    var markers = features.map(function (f) {
      var m = L.marker(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        { icon: createMarkerIcon(f), title: f.properties.name }
      );
      m.on('click', function () { handleDistrictCenterClick(f, m); });
      return m;
    });
    return L.layerGroup(markers);
  }

  // ── renderVisibleLayers ──────────────────────────────────────────────────

  function renderVisibleLayers() {
    var zoom = map.getZoom();

    // Remove old layer groups
    if (layerGroups.points)      { map.removeLayer(layerGroups.points); }
    if (layerGroups.detachments) { map.removeLayer(layerGroups.detachments); }
    if (layerGroups.districts)   { map.removeLayer(layerGroups.districts); }

    // Filter by zoom + toggle state
    var visPoints      = layerOn.points      ? allFeatures.points.filter(function (f) { return isFeatureVisible(f, zoom); })      : [];
    var visDetachments = layerOn.detachments ? allFeatures.detachments.filter(function (f) { return isFeatureVisible(f, zoom); }) : [];
    var visDistricts   = layerOn.districts   ? allFeatures.districts.filter(function (f) { return isFeatureVisible(f, zoom); })   : [];

    // Build and add — districts on top so they stay clickable at zoom 7
    layerGroups.points      = createPointLayer(visPoints).addTo(map);
    layerGroups.detachments = createDetachmentLayer(visDetachments).addTo(map);
    layerGroups.districts   = createDistrictLayer(visDistricts).addTo(map);
  }

  // ── Info panel ───────────────────────────────────────────────────────────

  function openInfoPanel(feature, popupEntry) {
    var sidebar = document.getElementById('sidebar');

    document.getElementById('sidebar-title').textContent =
      (popupEntry && popupEntry.title) ? popupEntry.title : feature.properties.name;

    document.getElementById('sidebar-content').innerHTML =
      (popupEntry && popupEntry.html) ? popupEntry.html : '';

    document.getElementById('sidebar-source').textContent =
      (popupEntry && popupEntry.source_title) ? popupEntry.source_title : '';

    // Reset scroll position
    document.getElementById('sidebar-content').scrollTop = 0;

    sidebar.classList.add('is-open');
    document.body.classList.add('sidebar-open');
  }

  function closeInfoPanel() {
    document.getElementById('sidebar').classList.remove('is-open');
    document.body.classList.remove('sidebar-open');
  }

  // ── Click handlers ────────────────────────────────────────────────────────

  function handleFeatureClick(feature, marker) {
    var entry = popupData[feature.properties.popup_id];
    if (!entry) { return; }

    openInfoPanel(feature, entry);

    var latlng = L.latLng(
      feature.geometry.coordinates[1],
      feature.geometry.coordinates[0]
    );
    map.panTo(latlng);
  }

  // ── handleDistrictCenterClick ────────────────────────────────────────────
  // Special behaviour:
  //   • always open the info panel immediately
  //   • if at zoom 7, smoothly fly to zoom 8 — panel stays open
  //   • if already at zoom ≥ 8, just pan

  function handleDistrictCenterClick(feature, marker) {
    var entry = popupData[feature.properties.popup_id];
    if (!entry) { return; }

    openInfoPanel(feature, entry);

    var latlng = L.latLng(
      feature.geometry.coordinates[1],
      feature.geometry.coordinates[0]
    );

    if (map.getZoom() <= 7) {
      map.flyTo(latlng, 8, { duration: 1.2, easeLinearity: 0.35 });
    } else {
      map.panTo(latlng);
    }
  }

  // ── Controls binding ──────────────────────────────────────────────────────

  function bindControls() {
    document.getElementById('sidebar-close')
      .addEventListener('click', closeInfoPanel);

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

    document.getElementById('toggle-districts')
      .addEventListener('change', function (e) {
        layerOn.districts = e.target.checked;
        renderVisibleLayers();
      });
  }

})();
