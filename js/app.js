/**
 * app.js — Main orchestrator
 * Cronicas Barbaras Knowledge Graph
 */
var AppModule = (function () {
  'use strict';

  var graphData = null;
  var episodesData = {};

  function boot() {
    _showLoading(true);
    _loadData().then(function () {
      _initModules();
      _initFilters();
      _initTimeline();
      _initToggles();
      _updateStats();
      _showLoading(false);
      _applyUrlParams();
    }).catch(function (err) {
      console.error('App boot error:', err);
      _showLoading(false);
      _showError(err.message || 'Error cargando datos');
    });
  }

  function getEpisodesData() { return episodesData; }
  function getGraphData() { return graphData; }

  // --- Data loading ---

  function _loadData() {
    return fetch('data/graph.json').then(function (res) {
      if (!res.ok) throw new Error('No se encontro data/graph.json. Ejecuta el pipeline primero.');
      return res.json();
    }).then(function (data) {
      graphData = data;
      episodesData = data.episodes || {};

      if (!graphData.nodes || graphData.nodes.length === 0) {
        throw new Error('graph.json vacio. Ejecuta el pipeline primero.');
      }
      // Merge episode metadata into episode nodes so timeline/sidebar have .date
      graphData.nodes.forEach(function (n) {
        if (n.type === 'episode' && episodesData[n.id]) {
          var ep = episodesData[n.id];
          n.date = ep.date;
          n.title = ep.title;
        }
      });
    });
  }

  function _initModules() {
    GraphModule.init(graphData, {
      onSelect: function (node, neighborIds) {
        SidebarModule.show(node, neighborIds);
        _highlightTimelineDot(node.id);
      },
      onClearSelection: function () {
        SidebarModule.hide();
        _clearTimelineHighlight();
      }
    });

    SidebarModule.init(episodesData, graphData.nodes, graphData.edges, {
      onNavigate: function (id) { GraphModule.selectNode(id); },
      onClose: function () { GraphModule.clearSelection(); _clearTimelineHighlight(); }
    });

    SearchModule.init();
    SearchModule.setNodes(graphData.nodes);
  }

  // --- Filters / Toggles ---

  function _initFilters() {
    var typeFilter = document.getElementById('filter-type');
    if (typeFilter) {
      typeFilter.addEventListener('change', function () {
        GraphModule.setTypeFilter(typeFilter.value);
      });
    }

    var modeFilter = document.getElementById('filter-mode');
    if (modeFilter) {
      modeFilter.addEventListener('change', function () {
        GraphModule.setViewMode(modeFilter.value);
      });
    }

    var colorFilter = document.getElementById('filter-color');
    if (colorFilter) {
      colorFilter.addEventListener('change', function () {
        GraphModule.setColorMode(colorFilter.value);
      });
    }
  }

  function _initToggles() {
    var tLabels = document.getElementById('toggle-labels');
    if (tLabels) {
      tLabels.addEventListener('change', function () {
        GraphModule.setShowLabels(tLabels.checked);
      });
    }

    var bBtn = document.getElementById('beautify-btn');
    if (bBtn) {
      bBtn.addEventListener('click', function () {
        GraphModule.beautify();
      });
    }

    var intraSlider = document.getElementById('slider-intra');
    var interSlider = document.getElementById('slider-inter');
    var intraVal = document.getElementById('slider-intra-val');
    var interVal = document.getElementById('slider-inter-val');

    function _applySliders() {
      var intra = intraSlider ? parseFloat(intraSlider.value) : null;
      var inter = interSlider ? parseFloat(interSlider.value) : null;
      if (intraVal && intra != null) intraVal.textContent = intra.toFixed(2);
      if (interVal && inter != null) interVal.textContent = inter.toFixed(2);
      GraphModule.setCommunitySpacing(intra, inter);
    }

    if (intraSlider) intraSlider.addEventListener('input', _applySliders);
    if (interSlider) interSlider.addEventListener('input', _applySliders);
  }

  // --- Stats ---

  function _updateStats() {
    var stats = graphData.meta || {};
    var counts = { episode: 0, person: 0, entity: 0 };
    graphData.nodes.forEach(function (n) {
      if (n.type === 'episode') counts.episode++;
      else if (n.type === 'person') counts.person++;
      else counts.entity++;
    });

    var elEp = document.getElementById('stat-episodes');
    var elPeople = document.getElementById('stat-people');
    var elEntities = document.getElementById('stat-entities');
    var elRange = document.getElementById('stat-range');

    if (elEp) elEp.textContent = counts.episode;
    if (elPeople) elPeople.textContent = counts.person;
    if (elEntities) elEntities.textContent = counts.entity;

    // Date range from episodes
    var dates = [];
    graphData.nodes.forEach(function (n) {
      if (n.type === 'episode' && n.date) dates.push(n.date);
    });
    dates.sort();
    if (elRange && dates.length > 0) {
      elRange.textContent = _shortDate(dates[0]) + ' - ' + _shortDate(dates[dates.length - 1]);
    }
  }

  // --- Timeline ---

  function _initTimeline() {
    var track = document.getElementById('timeline-track');
    if (!track) return;
    var episodes = graphData.nodes
      .filter(function (n) { return n.type === 'episode' && n.date; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });

    if (episodes.length === 0) {
      track.innerHTML = '<span style="color:var(--text-muted);font-size:0.75rem;">Sin datos de timeline</span>';
      return;
    }

    var months = {};
    episodes.forEach(function (ep) {
      var key = ep.date.substring(0, 7);
      if (!months[key]) months[key] = [];
      months[key].push(ep);
    });

    var monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    track.innerHTML = '';
    Object.keys(months).sort().forEach(function (monthKey) {
      var eps = months[monthKey];
      var parts = monthKey.split('-');
      var label = monthNames[parseInt(parts[1], 10) - 1] + ' ' + parts[0].substring(2);

      var monthDiv = document.createElement('div');
      monthDiv.className = 'timeline-month';

      var dotsDiv = document.createElement('div');
      dotsDiv.className = 'timeline-dots';

      eps.forEach(function (ep) {
        var dot = document.createElement('div');
        dot.className = 'timeline-dot';
        dot.setAttribute('data-ep-id', ep.id);
        dot.title = (ep.title || ep.name) + ' (' + ep.date + ')';
        dot.addEventListener('click', function () {
          GraphModule.selectNode(ep.id);
        });
        dotsDiv.appendChild(dot);
      });

      var labelDiv = document.createElement('div');
      labelDiv.className = 'timeline-month-label';
      labelDiv.textContent = label;

      monthDiv.appendChild(dotsDiv);
      monthDiv.appendChild(labelDiv);
      track.appendChild(monthDiv);
    });
  }

  function _highlightTimelineDot(nodeId) {
    _clearTimelineHighlight();
    var dot = document.querySelector('.timeline-dot[data-ep-id="' + nodeId + '"]');
    if (dot) {
      dot.classList.add('active');
      dot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  function _clearTimelineHighlight() {
    var dots = document.querySelectorAll('.timeline-dot.active');
    dots.forEach(function (d) { d.classList.remove('active'); });
  }

  // --- UI helpers ---

  function _showLoading(show) {
    var overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    if (show) {
      overlay.classList.remove('hidden');
      overlay.style.display = 'flex';
    } else {
      overlay.classList.add('hidden');
      setTimeout(function () { overlay.style.display = 'none'; }, 550);
    }
  }

  function _showError(message) {
    var overlay = document.getElementById('error-overlay');
    var msgEl = document.getElementById('error-message');
    if (overlay) overlay.style.display = 'flex';
    if (msgEl) msgEl.textContent = message;
  }

  function _applyUrlParams() {
    var params = new URLSearchParams(window.location.search);

    var color = params.get('color');
    if (color === 'community' || color === 'type') {
      GraphModule.setColorMode(color);
      var cSel = document.getElementById('filter-color');
      if (cSel) cSel.value = color;
    }

    var mode = params.get('mode');
    if (mode === 'episodes' || mode === 'community') {
      GraphModule.setViewMode(mode);
      var mSel = document.getElementById('filter-mode');
      if (mSel) mSel.value = mode;
    }

    var sel = params.get('select');
    if (sel && GraphModule.getNodeById(sel)) {
      GraphModule.selectNode(sel);
    }

    if (params.get('beautify') === '1') {
      GraphModule.beautify();
    }
  }

  function _shortDate(dateStr) {
    if (!dateStr) return '';
    var months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    var parts = dateStr.split('-');
    if (parts.length < 2) return dateStr;
    var m = parseInt(parts[1], 10) - 1;
    return months[m] + ' ' + parts[0];
  }

  return {
    boot: boot,
    getEpisodesData: getEpisodesData,
    getGraphData: getGraphData
  };
})();

document.addEventListener('DOMContentLoaded', function () {
  AppModule.boot();
});
