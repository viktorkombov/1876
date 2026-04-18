/* ============================================================
   app.js — Априлско въстание 1876
   Static Leaflet map for GitHub Pages
   ============================================================ */

(function () {
  'use strict';

  var DATA = {
    points:      './src/data/april-points-filtered.geojson',
    detachments: './src/data/april-detachments-filtered.geojson',
    districts:   './src/data/april-district-centers.geojson',
    popup:       './src/data/april-popup-content.json'
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
  var allFeatures = { points: [], detachments: [], districts: [], apostolic: [], okrazhenCenters: [] };
  var layerGroups = { points: null, detachments: null, districts: null, apostolic: null, okrazhenCenters: null };
  var layerOn     = { points: true, detachments: true, districts: true, apostolic: true, okrazhenCenters: true };

  document.addEventListener('DOMContentLoaded', function () {
    createMap();
    loadData().then(function () {
      renderVisibleLayers();
      bindControls();
    });
  });

  function createMap() {
    map = L.map('map', {
      center:             INIT_CENTER,
      zoom:               INIT_ZOOM,
      zoomControl:        true,
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
  }

})();
