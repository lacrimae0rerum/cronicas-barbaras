/**
 * search.js — Debounced search with graph highlighting
 * Cronicas Barbaras Knowledge Graph
 */
var SearchModule = (function () {
  'use strict';

  var debounceTimer = null;
  var DEBOUNCE_MS = 250;
  var lastResults = [];
  var _searchNodes = [];

  function init() {
    var input = document.getElementById('search-input');
    var clearBtn = document.getElementById('search-clear');
    if (!input) return;

    input.addEventListener('input', function () {
      var val = input.value.trim();
      clearBtn.classList.toggle('visible', val.length > 0);
      _debounceSearch(val);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        clearBtn.classList.remove('visible');
        _clearSearch();
        input.focus();
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = '';
        clearBtn.classList.remove('visible');
        _clearSearch();
        input.blur();
      } else if (e.key === 'Enter' && lastResults.length > 0) {
        // Navigate to first match
        if (typeof GraphModule !== 'undefined') {
          GraphModule.selectNode(lastResults[0]);
        }
      }
    });
  }

  function setNodes(nodes) { _searchNodes = nodes || []; }
  function getLastResults() { return lastResults; }

  function _debounceSearch(query) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { _performSearch(query); }, DEBOUNCE_MS);
  }

  function _stripAccents(str) {
    return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function _matchesQuery(text, nq) {
    if (!text) return false;
    return _stripAccents(text.toLowerCase()).indexOf(nq) !== -1;
  }

  function _performSearch(query) {
    var countEl = document.getElementById('search-count');
    if (!query || query.length < 2) { _clearSearch(); return; }

    var nq = _stripAccents(query.toLowerCase());
    var matching = [];
    _searchNodes.forEach(function (n) {
      if (_matchesQuery(n.name, nq)) {
        matching.push(n.id);
      } else if (n.description && _matchesQuery(n.description, nq)) {
        matching.push(n.id);
      }
    });

    // Also search episodes embedded metadata
    if (typeof AppModule !== 'undefined' && AppModule.getEpisodesData) {
      var episodes = AppModule.getEpisodesData();
      Object.keys(episodes).forEach(function (epId) {
        if (matching.indexOf(epId) !== -1) return;
        var ep = episodes[epId];
        var searchable = [ep.title, ep.takeaway, ep.summary];
        if (searchable.some(function (s) { return _matchesQuery(s, nq); })) {
          matching.push(epId);
        }
      });
    }

    lastResults = matching;

    if (countEl) {
      countEl.textContent = matching.length > 0
        ? matching.length + ' resultado' + (matching.length !== 1 ? 's' : '')
        : 'sin resultados';
    }

    // Highlight first result on graph
    if (typeof GraphModule !== 'undefined' && matching.length > 0) {
      GraphModule.highlightSearchResults(matching);
    }
  }

  function _clearSearch() {
    lastResults = [];
    var countEl = document.getElementById('search-count');
    if (countEl) countEl.textContent = '';
    if (typeof GraphModule !== 'undefined') {
      GraphModule.highlightSearchResults([]);
    }
  }

  return { init: init, setNodes: setNodes, getLastResults: getLastResults };
})();
