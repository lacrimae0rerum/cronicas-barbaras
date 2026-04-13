/**
 * sidebar.js — Detail panel for selected nodes
 * Cronicas Barbaras Knowledge Graph
 */
var SidebarModule = (function () {
  'use strict';

  var episodesData = {};
  var graphNodes = [];
  var graphEdges = [];
  var nodeMap = {};
  var onNavigate = null;

  function init(episodes, nodes, edges, callbacks) {
    episodesData = episodes || {};
    graphNodes = nodes || [];
    graphEdges = edges || [];
    nodeMap = {};
    graphNodes.forEach(function (n) { nodeMap[n.id] = n; });
    onNavigate = (callbacks && callbacks.onNavigate) || null;

    var closeBtn = document.getElementById('sidebar-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        hide();
        if (callbacks && callbacks.onClose) callbacks.onClose();
      });
    }
  }

  function show(nodeData, connectedIds) {
    if (!nodeData) { hide(); return; }

    var emptyEl = document.getElementById('sidebar-empty');
    var contentEl = document.getElementById('sidebar-content');
    emptyEl.style.display = 'none';
    contentEl.style.display = 'block';

    var headerEl = document.getElementById('sidebar-header');
    var bodyEl = document.getElementById('sidebar-body');

    var type = nodeData.type || 'unknown';
    var typeLabels = GraphModule.getTypeLabels();
    var typeLabel = typeLabels[type] || type;

    headerEl.innerHTML = _buildHeader(nodeData, typeLabel, type);

    if (type === 'episode') {
      bodyEl.innerHTML = _buildEpisodeBody(nodeData, connectedIds);
    } else {
      bodyEl.innerHTML = _buildEntityBody(nodeData, connectedIds, typeLabel);
    }

    _bindInteractions(bodyEl);

    contentEl.classList.add('fade-in');
    setTimeout(function () { contentEl.classList.remove('fade-in'); }, 350);
  }

  function hide() {
    var emptyEl = document.getElementById('sidebar-empty');
    var contentEl = document.getElementById('sidebar-content');
    if (emptyEl) emptyEl.style.display = '';
    if (contentEl) contentEl.style.display = 'none';
  }

  // --- Header ---

  function _buildHeader(node, typeLabel, type) {
    var title = node.name || node.title || node.label || '(sin nombre)';
    if (type === 'episode' && episodesData[node.id] && episodesData[node.id].title) {
      title = episodesData[node.id].title;
    }

    var html = '';
    html += '<span class="node-type-badge ' + _esc(type) + '">' + _esc(typeLabel) + '</span>';
    html += '<div class="node-title">' + _esc(title) + '</div>';

    var metaParts = [];
    if (type === 'episode' && episodesData[node.id] && episodesData[node.id].date) {
      metaParts.push('<span class="node-meta-item">' + _formatDate(episodesData[node.id].date) + '</span>');
    }
    if (node.degree) {
      metaParts.push('<span class="node-meta-item">' + node.degree + ' conexiones</span>');
    }
    var communities = GraphModule.getCommunities();
    if (node.community != null && communities[node.community]) {
      metaParts.push('<span class="node-meta-item">Comunidad: ' + _esc(communities[node.community].label) + '</span>');
    }
    if (metaParts.length > 0) {
      html += '<div class="node-meta">' + metaParts.join('') + '</div>';
    }
    return html;
  }

  // --- Episode body ---

  function _buildEpisodeBody(node, connectedIds) {
    var ep = episodesData[node.id] || {};
    var html = '';

    if (ep.url) {
      html += '<div class="sidebar-section">';
      html += '<a class="yt-link" href="' + _esc(ep.url) + '" target="_blank" rel="noopener">';
      html += '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.55A3.02 3.02 0 0 0 .5 6.19 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.81 3.02 3.02 0 0 0 2.12 2.14c1.87.55 9.38.55 9.38.55s7.5 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.81zM9.75 15.02V8.98L15.5 12l-5.75 3.02z"/></svg>';
      html += 'Ver en YouTube</a>';
      html += '</div>';
    }

    if (ep.takeaway) {
      html += '<div class="sidebar-section">';
      html += '<div class="sidebar-section-title">Takeaway</div>';
      html += '<p class="sidebar-text takeaway">' + _esc(ep.takeaway) + '</p>';
      html += '</div>';
    }

    if (ep.summary) {
      html += '<div class="sidebar-section">';
      html += '<div class="sidebar-section-title">Resumen</div>';
      html += _renderSummary(ep.summary);
      html += '</div>';
    }

    // Connected entities grouped by type
    html += _buildEntityGroups(node.id, connectedIds);

    return html;
  }

  function _renderSummary(summary) {
    // Summaries are pipe-delimited with bold markers (**...**)
    var parts = String(summary).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length <= 1) {
      return '<p class="sidebar-text">' + _mdInline(summary) + '</p>';
    }
    var html = '<ul class="sidebar-list">';
    parts.forEach(function (p) {
      html += '<li>' + _mdInline(p) + '</li>';
    });
    html += '</ul>';
    return html;
  }

  function _mdInline(text) {
    var safe = _esc(text);
    // Convert **bold** to <strong>
    return safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // --- Entity body (person/theme/concept/work/etc.) ---

  function _buildEntityBody(node, connectedIds, typeLabel) {
    var html = '';

    if (node.description) {
      html += '<div class="sidebar-section">';
      html += '<div class="sidebar-section-title">Descripcion</div>';
      html += '<p class="sidebar-text">' + _esc(node.description) + '</p>';
      html += '</div>';
    }

    // Episode appearances (from episode_ids array on node)
    if (node.episode_ids && node.episode_ids.length > 0) {
      html += '<div class="sidebar-section">';
      html += '<div class="sidebar-section-title">Aparece en ' + node.episode_ids.length + ' episodio' +
              (node.episode_ids.length !== 1 ? 's' : '') + '</div>';
      html += _buildEpisodeList(node.episode_ids);
      html += '</div>';
    }

    html += _buildEntityGroups(node.id, connectedIds);

    return html;
  }

  // Group connected non-episode entities by type
  function _buildEntityGroups(currentId, connectedIds) {
    if (!connectedIds || connectedIds.length === 0) return '';

    var groupOrder = ['person', 'organization', 'theme', 'concept', 'work', 'event', 'location'];
    var groups = {};
    connectedIds.forEach(function (cid) {
      var n = nodeMap[cid];
      if (!n || n.id === currentId) return;
      if (n.type === 'episode') return;
      if (!groups[n.type]) groups[n.type] = [];
      groups[n.type].push(n);
    });

    var typeLabels = GraphModule.getTypeLabels();
    var html = '';
    groupOrder.forEach(function (t) {
      if (!groups[t] || groups[t].length === 0) return;
      // Sort by degree desc
      groups[t].sort(function (a, b) { return (b.degree || 0) - (a.degree || 0); });
      html += '<div class="sidebar-section">';
      html += '<div class="sidebar-section-title">' + _esc((typeLabels[t] || t)) + 's relacionados (' + groups[t].length + ')</div>';
      html += '<div class="tag-list">';
      groups[t].forEach(function (n) {
        html += '<span class="tag" data-navigate="' + _esc(n.id) + '">' + _esc(n.name) + '</span>';
      });
      html += '</div></div>';
    });
    return html;
  }

  function _buildEpisodeList(episodeIds) {
    // Sort by date desc using episodesData
    var items = episodeIds.map(function (id) {
      return {
        id: id,
        title: (episodesData[id] && episodesData[id].title) || id,
        date: (episodesData[id] && episodesData[id].date) || ''
      };
    });
    items.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    var html = '<div class="connected-episodes-list">';
    items.forEach(function (ep) {
      html += '<div class="connected-ep" data-navigate="' + _esc(ep.id) + '">';
      html += '<div class="connected-ep-dot" style="background:var(--node-episode)"></div>';
      html += '<div class="connected-ep-info">';
      html += '<div class="connected-ep-title">' + _esc(ep.title) + '</div>';
      if (ep.date) html += '<div class="connected-ep-date">' + _formatDate(ep.date) + '</div>';
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function _bindInteractions(container) {
    var navEls = container.querySelectorAll('[data-navigate]');
    navEls.forEach(function (el) {
      el.addEventListener('click', function () {
        var targetId = el.getAttribute('data-navigate');
        if (onNavigate && targetId) onNavigate(targetId);
      });
    });
    var headers = container.querySelectorAll('.collapsible-header');
    headers.forEach(function (header) {
      header.addEventListener('click', function () {
        var targetId = 'collapsible-' + header.getAttribute('data-collapsible');
        var body = document.getElementById(targetId);
        if (body) {
          header.classList.toggle('open');
          body.classList.toggle('open');
        }
      });
    });
  }

  function _formatDate(dateStr) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    var months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    var m = parseInt(parts[1], 10) - 1;
    return parts[2] + ' ' + (months[m] || parts[1]) + ' ' + parts[0];
  }

  function _esc(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  return { init: init, show: show, hide: hide };
})();
