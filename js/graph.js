/**
 * graph.js — Canvas knowledge graph renderer
 * Cronicas Barbaras
 *
 * Features:
 *  - Canvas rendering for 600+ nodes
 *  - Pre-computed FR layout + hard collision resolver (nodes never overlap)
 *  - Label placement with overlap prevention (vs. placed boxes AND node circles)
 *  - d3-zoom pan/zoom
 *  - Community hulls, dual color modes (type / community)
 *  - Community mode + Episodes mode
 *  - Type/legend filters, hover tooltip, selection with neighbor highlight
 */
var GraphModule = (function () {
  'use strict';

  // ---------- Constants ----------

  var TYPE_RADIUS = {
    person: 12, organization: 10, work: 8,
    concept: 8, event: 8, location: 8, theme: 7, episode: 18
  };

  var TYPE_COLORS = {
    person:       '#4A9EFF',
    organization: '#FF8C42',
    work:         '#4ECB8D',
    concept:      '#B47FFF',
    event:        '#FF6B6B',
    location:     '#00C2CC',
    theme:        '#FFD93D',
    episode:      '#F5F0E8'
  };

  var TYPE_LABELS = {
    episode: 'Episodio',
    person: 'Persona',
    organization: 'Organizacion',
    work: 'Obra',
    concept: 'Concepto',
    event: 'Evento',
    location: 'Lugar',
    theme: 'Tema'
  };

  var LAYOUT_SIDE = 2400;  // virtual layout space (independent of canvas size)
  var NODE_GAP = 3;        // minimum empty space between node edges (pixels)

  // Layout spacing driven by the two sliders. intraScale < 1 tightens nodes
  // within each community around its centroid; interScale > 1 pushes whole
  // communities outward from the global layout center.
  var intraScale = 0.55;
  var interScale = 1.00;
  var LABEL_PAD = 5;       // gap between node edge and label box
  var MAX_COLLISION_ITERS = 400;
  var HULL_MARGIN = 14;    // padding between nodes and their community hull border

  // ---------- State ----------

  var canvas = null;
  var ctx = null;
  var container = null;
  var tooltipEl = null;

  var graphData = null;       // raw loaded JSON
  var nodes = [];             // prepared nodes with px/py/r0
  var edges = [];             // prepared edges with src/tgt refs
  var hulls = [];             // prepared community hulls
  var nodeMap = {};           // id -> node
  var neighborSet = new Set();

  var transform = { x: 0, y: 0, k: 1 };
  var d3zoom = null;
  var d3sel = null;

  var selectedNode = null;
  var hoveredNode = null;

  var viewMode = 'community';    // 'community' | 'episodes'
  var colorMode = 'type';        // 'type' | 'community'
  var typeFilter = 'all';
  var hiddenTypes = new Set();   // from legend toggles
  var showLabels = true;

  var nodeSizeScale = 1.0;       // fixed at 1 — positions already collision-safe
  var labelZoomThreshold = 1.2;  // zoom level above which high-degree labels appear
  var labelFontSize = 11;        // pixels in screen space (divided by k at render)

  var animFrame = null;
  var callbacks = {};

  // Cached Beautify targets (community id -> {x, y}): per-community centroids
  // pushed outward from the global center by BEAUTIFY_SPREAD. Computed from the
  // pipeline layout at init time so clicks are idempotent.
  var beautifyTargets = null;

  // ---------- Init ----------

  function init(data, cbs) {
    graphData = data;
    callbacks = cbs || {};
    canvas = document.getElementById('graph-canvas');
    ctx = canvas.getContext('2d');
    container = document.getElementById('graph-container');
    tooltipEl = document.getElementById('graph-tooltip');

    _setupCanvas();
    _prepareBase();
    _applySpacing();
    _resolveCollisions('community');
    _resolveCollisions('episodes');
    _computeCommunityHulls();
    _cacheBeautifyTargets();
    _setupZoom();
    _setupEventListeners();
    _buildLegend();
    _fitToView();
    scheduleRender();

    var ro = new ResizeObserver(function () {
      _setupCanvas();
      scheduleRender();
    });
    ro.observe(container);
  }

  // ---------- Canvas sizing ----------

  function _setupCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var W = container.offsetWidth;
    var H = container.offsetHeight;
    canvas.width = Math.max(W, 100) * dpr;
    canvas.height = Math.max(H, 100) * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }

  // ---------- Layout preparation ----------

  function _baseRadius(n) {
    if (n.type === 'episode') return 18;
    var base = TYPE_RADIUS[n.type] || 8;
    return Math.max(base, Math.min(base + Math.sqrt(n.degree || 0) * 0.8, 36));
  }

  function _prepareBase() {
    // Layout is computed in a fixed virtual coordinate space (LAYOUT_SIDE×LAYOUT_SIDE),
    // centered at origin. The canvas view pans/zooms onto this space — so the layout
    // is independent of the current viewport size and collision separation is stable.
    var side = LAYOUT_SIDE;
    var offX = 0;
    var offY = 0;

    nodeMap = {};
    nodes = graphData.nodes.map(function (n) {
      var bx  = offX + (n.x  || 0) * side;
      var by  = offY + (n.y  || 0) * side;
      var bex = offX + ((n.ex != null ? n.ex : n.x) || 0) * side;
      var bey = offY + ((n.ey != null ? n.ey : n.y) || 0) * side;
      var cNode = {
        id: n.id,
        name: n.name,
        type: n.type,
        community: n.community,
        degree: n.degree || 0,
        episode_count: n.episode_count,
        episode_ids: n.episode_ids || [],
        description: n.description || '',
        // Pristine pipeline coordinates, never mutated — used as source of
        // truth when sliders recompute layout.
        baseX0: bx, baseY0: by, baseEX0: bex, baseEY0: bey,
        baseX: bx, baseY: by, baseEX: bex, baseEY: bey,
        r0: _baseRadius(n),
        communityColor: (graphData.communities[n.community] && graphData.communities[n.community].color) || '#888',
        px: 0, py: 0
      };
      nodeMap[n.id] = cNode;
      return cNode;
    });

    edges = graphData.edges.map(function (e) {
      return {
        source: e.source,
        target: e.target,
        weight: e.weight || 1,
        is_backbone: !!e.is_backbone,
        is_episode_edge: !!e.is_episode_edge,
        src: nodeMap[e.source],
        tgt: nodeMap[e.target]
      };
    }).filter(function (e) { return e.src && e.tgt; });

    hulls = (graphData.communities || []).map(function (c) {
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        size: c.size,
        polygon: []  // computed dynamically from node positions
      };
    });
  }

  // ---------- Convex hull (Andrew's monotone chain) ----------

  function _cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  function _convexHull(points) {
    if (points.length < 3) return points.slice();
    var sorted = points.slice().sort(function (a, b) {
      return a[0] - b[0] || a[1] - b[1];
    });
    var lower = [];
    for (var i = 0; i < sorted.length; i++) {
      while (lower.length >= 2 && _cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) {
        lower.pop();
      }
      lower.push(sorted[i]);
    }
    var upper = [];
    for (var j = sorted.length - 1; j >= 0; j--) {
      while (upper.length >= 2 && _cross(upper[upper.length - 2], upper[upper.length - 1], sorted[j]) <= 0) {
        upper.pop();
      }
      upper.push(sorted[j]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // Build a hull that strictly contains every node of a community by sampling
  // points around each node circle (radius + HULL_MARGIN) and taking the
  // convex hull of all samples. This guarantees every node lies inside.
  function _computeCommunityHulls() {
    var groups = {};
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'episode') continue;       // episodes not shown in community mode
      if (n.community == null) continue;
      if (!groups[n.community]) groups[n.community] = [];
      groups[n.community].push(n);
    }

    var SAMPLES = 10;
    for (var h = 0; h < hulls.length; h++) {
      var hull = hulls[h];
      var members = groups[hull.id] || [];
      if (members.length === 0) { hull.polygon = []; continue; }
      if (members.length === 1) {
        // Single-node community: draw a circle polygon around it
        var only = members[0];
        var rO = only.r0 + HULL_MARGIN;
        var circle = [];
        for (var s = 0; s < 24; s++) {
          var ang = (s / 24) * Math.PI * 2;
          circle.push([only.baseX + Math.cos(ang) * rO, only.baseY + Math.sin(ang) * rO]);
        }
        hull.polygon = circle;
        continue;
      }
      var pts = [];
      for (var m = 0; m < members.length; m++) {
        var nd = members[m];
        var rr = nd.r0 + HULL_MARGIN;
        for (var k = 0; k < SAMPLES; k++) {
          var a = (k / SAMPLES) * Math.PI * 2;
          pts.push([nd.baseX + Math.cos(a) * rr, nd.baseY + Math.sin(a) * rr]);
        }
      }
      hull.polygon = _convexHull(pts);
    }
  }

  // ---------- Layout spacing (sliders) ----------
  // Recomputes baseX/Y and baseEX/EY from the pristine pipeline coordinates
  // using the two slider factors:
  //   intraScale  — radial factor applied to each node around its community centroid
  //   interScale  — radial factor applied to each community centroid around the global center
  //
  // The pristine coordinates (baseX0/Y0/…) are never mutated, so sliders can be
  // moved back and forth without drift. Community hulls and Beautify targets
  // are refreshed after each apply.
  function _applySpacing() {
    // Group by community using pristine coordinates
    var groups = {};
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.community == null) continue;
      (groups[n.community] || (groups[n.community] = [])).push(n);
    }

    // Community centroids in pristine space (both community and episodes layouts)
    var cent = {};
    Object.keys(groups).forEach(function (cid) {
      var g = groups[cid];
      var sx = 0, sy = 0, ex = 0, ey = 0;
      for (var j = 0; j < g.length; j++) {
        sx += g[j].baseX0; sy += g[j].baseY0;
        ex += g[j].baseEX0; ey += g[j].baseEY0;
      }
      cent[cid] = {
        cx: sx / g.length, cy: sy / g.length,
        ecx: ex / g.length, ecy: ey / g.length
      };
    });

    // Global centroid (mean of community centroids)
    var gx = 0, gy = 0, egx = 0, egy = 0, cnt = 0;
    Object.keys(cent).forEach(function (cid) {
      gx += cent[cid].cx; gy += cent[cid].cy;
      egx += cent[cid].ecx; egy += cent[cid].ecy;
      cnt++;
    });
    if (cnt > 0) { gx /= cnt; gy /= cnt; egx /= cnt; egy /= cnt; }

    // Rebuild baseX/Y from pristine using intraScale + interScale
    Object.keys(groups).forEach(function (cid) {
      var g = groups[cid];
      var c = cent[cid];
      var newCx  = gx  + (c.cx  - gx)  * interScale;
      var newCy  = gy  + (c.cy  - gy)  * interScale;
      var newEcx = egx + (c.ecx - egx) * interScale;
      var newEcy = egy + (c.ecy - egy) * interScale;
      for (var k = 0; k < g.length; k++) {
        var nd = g[k];
        nd.baseX  = newCx  + (nd.baseX0  - c.cx)  * intraScale;
        nd.baseY  = newCy  + (nd.baseY0  - c.cy)  * intraScale;
        nd.baseEX = newEcx + (nd.baseEX0 - c.ecx) * intraScale;
        nd.baseEY = newEcy + (nd.baseEY0 - c.ecy) * intraScale;
      }
    });

    // Nodes without community: copy pristine through unchanged
    for (var i2 = 0; i2 < nodes.length; i2++) {
      if (nodes[i2].community != null) continue;
      nodes[i2].baseX  = nodes[i2].baseX0;
      nodes[i2].baseY  = nodes[i2].baseY0;
      nodes[i2].baseEX = nodes[i2].baseEX0;
      nodes[i2].baseEY = nodes[i2].baseEY0;
    }
  }

  function setCommunitySpacing(intra, inter) {
    if (intra != null) intraScale = intra;
    if (inter != null) interScale = inter;
    _applySpacing();
    // Inviolable rule: no overlapping nodes. The collision resolver runs on
    // the freshly-scaled positions and mutates baseX/Y in place, but the next
    // slider change rebuilds from pristine coordinates so there's no drift.
    _resolveCollisions('community');
    _resolveCollisions('episodes');
    _computeCommunityHulls();
    _cacheBeautifyTargets();
    scheduleRender();
  }

  // ---------- Collision resolver ----------
  // Iteratively push overlapping nodes apart until no pair touches.
  // Runs once per layout mode at init time.

  function _resolveCollisions(mode) {
    var MAX_ITERS = MAX_COLLISION_ITERS;
    var n = nodes.length;
    // Work on a copy of base coordinates for this mode
    var xs = new Float64Array(n);
    var ys = new Float64Array(n);
    var rs = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      rs[i] = nodes[i].r0;
      if (mode === 'episodes') {
        xs[i] = nodes[i].baseEX;
        ys[i] = nodes[i].baseEY;
      } else {
        xs[i] = nodes[i].baseX;
        ys[i] = nodes[i].baseY;
      }
    }

    // Spatial grid for performance
    var maxR = 0;
    for (var k = 0; k < n; k++) if (rs[k] > maxR) maxR = rs[k];
    var cell = (maxR + NODE_GAP) * 2;

    for (var iter = 0; iter < MAX_ITERS; iter++) {
      var moved = false;

      var grid = {};
      for (var gi = 0; gi < n; gi++) {
        var cx = Math.floor(xs[gi] / cell);
        var cy = Math.floor(ys[gi] / cell);
        var key = cx + ',' + cy;
        if (!grid[key]) grid[key] = [];
        grid[key].push(gi);
      }

      for (var i2 = 0; i2 < n; i2++) {
        var gx = Math.floor(xs[i2] / cell);
        var gy = Math.floor(ys[i2] / cell);
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            var bucket = grid[(gx + dx) + ',' + (gy + dy)];
            if (!bucket) continue;
            for (var b = 0; b < bucket.length; b++) {
              var j = bucket[b];
              if (j <= i2) continue;
              var ddx = xs[j] - xs[i2];
              var ddy = ys[j] - ys[i2];
              var distSq = ddx * ddx + ddy * ddy;
              var minDist = rs[i2] + rs[j] + NODE_GAP;
              if (distSq < minDist * minDist) {
                var dist = Math.sqrt(distSq) || 0.001;
                var overlap = (minDist - dist) / 2;
                var nxv = ddx / dist;
                var nyv = ddy / dist;
                xs[i2] -= nxv * overlap;
                ys[i2] -= nyv * overlap;
                xs[j]  += nxv * overlap;
                ys[j]  += nyv * overlap;
                moved = true;
              }
            }
          }
        }
      }

      if (!moved) break;
    }

    // Write back
    for (var w = 0; w < n; w++) {
      if (mode === 'episodes') {
        nodes[w].baseEX = xs[w];
        nodes[w].baseEY = ys[w];
      } else {
        nodes[w].baseX = xs[w];
        nodes[w].baseY = ys[w];
      }
    }
  }

  // ---------- Per-frame position application ----------

  function _applyPositions() {
    var useEpisodes = viewMode === 'episodes';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.px = useEpisodes ? n.baseEX : n.baseX;
      n.py = useEpisodes ? n.baseEY : n.baseY;
    }
  }

  // ---------- Fit to view ----------

  function _fitToView() {
    if (nodes.length === 0) return;
    _applyPositions();
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.px - n.r0 < minX) minX = n.px - n.r0;
      if (n.py - n.r0 < minY) minY = n.py - n.r0;
      if (n.px + n.r0 > maxX) maxX = n.px + n.r0;
      if (n.py + n.r0 > maxY) maxY = n.py + n.r0;
    }
    var W = canvas.width / (window.devicePixelRatio || 1);
    var H = canvas.height / (window.devicePixelRatio || 1);
    var bw = maxX - minX;
    var bh = maxY - minY;
    var margin = 60;
    var scale = Math.min((W - margin * 2) / bw, (H - margin * 2) / bh);
    scale = Math.max(0.08, Math.min(scale, 2.5));
    var tx = (W - bw * scale) / 2 - minX * scale;
    var ty = (H - bh * scale) / 2 - minY * scale;
    if (d3zoom && d3sel) {
      var transformFn = d3.zoomIdentity.translate(tx, ty).scale(scale);
      d3zoom.transform(d3sel, transformFn);
    } else {
      transform = { x: tx, y: ty, k: scale };
    }
  }

  // ---------- Rendering ----------

  function scheduleRender() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(render);
  }

  function _nodeVisible(n) {
    if (hiddenTypes.has(n.type)) return false;
    if (typeFilter !== 'all' && n.type !== typeFilter) return false;
    if (viewMode === 'community' && n.type === 'episode') return false;
    return true;
  }

  function _hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function _getNodeColor(node) {
    if (node.type === 'episode') return '#F5F0E8';
    if (colorMode === 'type') return TYPE_COLORS[node.type] || '#888';
    return node.communityColor;
  }

  // Draw a directed arrow from src to tgt, stopping just outside the target
  // node's radius so the head touches the circle instead of hiding under it.
  function _drawArrow(src, tgt, color, lineWidth) {
    var dx = tgt.px - src.px;
    var dy = tgt.py - src.py;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.01) return;
    var ux = dx / dist;
    var uy = dy / dist;

    var srcR = src.r0 * nodeSizeScale;
    var tgtR = tgt.r0 * nodeSizeScale;
    var sx = src.px + ux * srcR;
    var sy = src.py + uy * srcR;
    var tx = tgt.px - ux * tgtR;
    var ty = tgt.py - uy * tgtR;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    var headLen = Math.max(8 / transform.k, lineWidth * 4);
    var headW = headLen * 0.55;
    var px = -uy, py = ux;  // perpendicular
    var bx = tx - ux * headLen;
    var by = ty - uy * headLen;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(bx + px * headW, by + py * headW);
    ctx.lineTo(bx - px * headW, by - py * headW);
    ctx.closePath();
    ctx.fill();
  }

  function render() {
    if (!canvas || !ctx || nodes.length === 0) return;
    _applyPositions();

    var dpr = window.devicePixelRatio || 1;
    var W = canvas.width / dpr;
    var H = canvas.height / dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    var hasSelection = selectedNode !== null;
    var isEpisodesMode = viewMode === 'episodes';

    // 1. Community hulls — drawn in community mode (both color modes).
    //    By construction these polygons fully contain their members.
    if (!isEpisodesMode) {
      var fillA = colorMode === 'community' ? 0.12 : 0.05;
      var strokeA = colorMode === 'community' ? 0.32 : 0.18;
      for (var h = 0; h < hulls.length; h++) {
        var hull = hulls[h];
        if (!hull.polygon || hull.polygon.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(hull.polygon[0][0], hull.polygon[0][1]);
        for (var p = 1; p < hull.polygon.length; p++) {
          ctx.lineTo(hull.polygon[p][0], hull.polygon[p][1]);
        }
        ctx.closePath();
        ctx.fillStyle = _hexToRgba(hull.color, fillA);
        ctx.fill();
        ctx.strokeStyle = _hexToRgba(hull.color, strokeA);
        ctx.lineWidth = 1.4 / transform.k;
        ctx.stroke();
      }
    }

    // 2. Edges — only drawn when a node is selected, and only those
    //    connected to it. Each edge is rendered as a directed arrow from
    //    source to target in the source node's color.
    if (hasSelection) {
      var selId = selectedNode.id;
      for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var isEpEdge = edge.is_episode_edge;
        if (isEpisodesMode && !isEpEdge) continue;
        if (!isEpisodesMode && isEpEdge) continue;
        if (edge.source !== selId && edge.target !== selId) continue;
        if (!_nodeVisible(edge.src) || !_nodeVisible(edge.tgt)) continue;

        var srcColor = _getNodeColor(edge.src);
        var lw = (isEpisodesMode
          ? 2.0
          : (edge.is_backbone ? (2.5 + Math.sqrt(edge.weight) * 0.3) : 1.2)) / transform.k;

        _drawArrow(edge.src, edge.tgt, _hexToRgba(srcColor, 0.85), lw);
      }
    }

    // 3. Nodes
    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      if (!_nodeVisible(node)) continue;

      var isSelected = selectedNode && selectedNode.id === node.id;
      var isHovered = hoveredNode && hoveredNode.id === node.id;
      var isNeighbor = hasSelection && neighborSet.has(node.id);
      var isFaded = hasSelection && !isSelected && !isNeighbor;
      var r = node.r0 * nodeSizeScale * (isSelected || isHovered ? 1.4 : (isNeighbor ? 1.15 : 1));
      var color = _getNodeColor(node);

      ctx.beginPath();
      ctx.arc(node.px, node.py, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = isFaded ? 0.10 : 1;
      ctx.fill();

      if (isSelected || isHovered) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.8 / transform.k;
        ctx.globalAlpha = 1;
        ctx.stroke();
      } else if (isNeighbor) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 0.8 / transform.k;
        ctx.globalAlpha = 1;
        ctx.stroke();
      } else if (node.type === 'episode') {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.2 / transform.k;
        ctx.globalAlpha = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 4. Labels (overlap-free)
    if (showLabels) _renderLabels(hasSelection, isEpisodesMode);

    ctx.restore();
  }

  function _renderLabels(hasSelection, isEpisodesMode) {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var fontSize = labelFontSize / transform.k;
    ctx.font = fontSize + 'px Inter, sans-serif';
    var pad = LABEL_PAD / transform.k;

    // Candidates sorted by priority
    var cands = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!_nodeVisible(node)) continue;

      var isSelected = selectedNode && selectedNode.id === node.id;
      var isHovered = hoveredNode && hoveredNode.id === node.id;
      var isNeighbor = hasSelection && neighborSet.has(node.id);
      if (hasSelection && !isSelected && !isNeighbor) continue;

      var isEpNode = node.type === 'episode';
      var effThreshold = isEpNode ? labelZoomThreshold * 0.4 : labelZoomThreshold;
      // Selected/hovered always labelled. Neighbors of selection always labelled.
      // Everything else requires zoom threshold + minimum degree.
      var alwaysShow = isSelected || isHovered || isNeighbor;
      var meetsZoom = alwaysShow || transform.k >= effThreshold;
      var meetsDegree = alwaysShow || isEpNode || node.degree >= 4;
      if (!meetsZoom || !meetsDegree) continue;

      var prio = 0;
      if (isSelected) prio = 1000;
      else if (isHovered) prio = 900;
      else if (isEpNode) prio = 800;
      else if (isNeighbor) prio = 500;
      else prio = Math.min(node.degree, 400);

      cands.push({ node: node, isSelected: isSelected, isHovered: isHovered, isNeighbor: isNeighbor, prio: prio });
    }
    cands.sort(function (a, b) { return b.prio - a.prio; });

    var placed = [];

    for (var c = 0; c < cands.length; c++) {
      var cand = cands[c];
      var n = cand.node;
      var label = n.name.length > 26 ? n.name.slice(0, 24) + '…' : n.name;
      var r = n.r0 * nodeSizeScale * (cand.isSelected || cand.isHovered ? 1.4 : (cand.isNeighbor ? 1.15 : 1));
      var textW = ctx.measureText(label).width;
      var bw = textW + 6 / transform.k;
      var bh = fontSize + 4 / transform.k;
      var bx = n.px + r + pad;
      var by = n.py - bh / 2;

      // Check overlap with placed boxes
      var overlaps = false;
      for (var pb = 0; pb < placed.length; pb++) {
        var P = placed[pb];
        if (bx < P[0] + P[2] && bx + bw > P[0] && by < P[1] + P[3] && by + bh > P[1]) {
          overlaps = true; break;
        }
      }
      if (overlaps && !cand.isSelected && !cand.isHovered) continue;

      // Check overlap with visible node circles
      if (!cand.isSelected && !cand.isHovered) {
        for (var k2 = 0; k2 < nodes.length; k2++) {
          var other = nodes[k2];
          if (other.id === n.id) continue;
          if (!_nodeVisible(other)) continue;
          var cx = Math.max(bx, Math.min(other.px, bx + bw));
          var cy = Math.max(by, Math.min(other.py, by + bh));
          var ddx = other.px - cx;
          var ddy = other.py - cy;
          var orr = other.r0 * nodeSizeScale;
          if (ddx * ddx + ddy * ddy < orr * orr) { overlaps = true; break; }
        }
        if (overlaps) continue;
      }

      placed.push([bx, by, bw, bh]);

      // Draw tag background
      var rad = 3 / transform.k;
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = 'rgba(12,12,12,0.85)';
      ctx.beginPath();
      ctx.moveTo(bx + rad, by);
      ctx.lineTo(bx + bw - rad, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + rad, rad);
      ctx.lineTo(bx + bw, by + bh - rad);
      ctx.arcTo(bx + bw, by + bh, bx + bw - rad, by + bh, rad);
      ctx.lineTo(bx + rad, by + bh);
      ctx.arcTo(bx, by + bh, bx, by + bh - rad, rad);
      ctx.lineTo(bx, by + rad);
      ctx.arcTo(bx, by, bx + rad, by, rad);
      ctx.closePath();
      ctx.fill();

      if (cand.isSelected || cand.isHovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 0.7 / transform.k;
        ctx.stroke();
      }

      ctx.fillStyle = cand.isSelected || cand.isHovered ? '#ffffff' : 'rgba(230,230,230,0.90)';
      ctx.fillText(label, bx + 3 / transform.k, n.py);
    }
  }

  // ---------- Zoom ----------

  function _setupZoom() {
    if (typeof d3 === 'undefined' || !d3.zoom || !d3.select) {
      console.warn('d3-zoom not loaded — falling back to manual pan/zoom');
      _setupManualPanZoom();
      return;
    }
    d3sel = d3.select(canvas);
    d3zoom = d3.zoom()
      .scaleExtent([0.05, 15])
      .on('zoom', function (event) {
        transform = { x: event.transform.x, y: event.transform.y, k: event.transform.k };
        scheduleRender();
      });
    d3sel.call(d3zoom);
    d3sel.on('click.zoom', null);
  }

  function _setupManualPanZoom() {
    var dragging = false;
    var lastX = 0, lastY = 0;
    canvas.addEventListener('mousedown', function (e) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mouseup', function () { dragging = false; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      transform.x += e.clientX - lastX;
      transform.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      scheduleRender();
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var factor = e.deltaY > 0 ? 0.9 : 1.1;
      var newK = Math.max(0.05, Math.min(15, transform.k * factor));
      transform.x = mx - (mx - transform.x) * (newK / transform.k);
      transform.y = my - (my - transform.y) * (newK / transform.k);
      transform.k = newK;
      scheduleRender();
    }, { passive: false });
  }

  // ---------- Hit test ----------

  function _hitTest(sx, sy) {
    var gx = (sx - transform.x) / transform.k;
    var gy = (sy - transform.y) / transform.k;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!_nodeVisible(n)) continue;
      var dx = n.px - gx;
      var dy = n.py - gy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var hitR = Math.max(n.r0 * nodeSizeScale * 1.2, 8);
      if (dist < hitR && dist < bestDist) {
        best = n;
        bestDist = dist;
      }
    }
    return best;
  }

  // ---------- Event handlers ----------

  function _setupEventListeners() {
    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      var sx = e.clientX - rect.left;
      var sy = e.clientY - rect.top;
      var hit = _hitTest(sx, sy);
      if ((hit && hit.id) !== (hoveredNode && hoveredNode.id)) {
        hoveredNode = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        scheduleRender();
      }
      if (hit) {
        _showTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        _hideTooltip();
      }
    });

    canvas.addEventListener('mouseleave', function () {
      hoveredNode = null;
      _hideTooltip();
      scheduleRender();
    });

    canvas.addEventListener('click', function (e) {
      var rect = canvas.getBoundingClientRect();
      var hit = _hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        selectNode(hit.id);
      } else {
        clearSelection();
      }
    });

    // Zoom buttons
    var zIn = document.getElementById('zoom-in');
    var zOut = document.getElementById('zoom-out');
    var zReset = document.getElementById('zoom-reset');
    if (zIn) zIn.addEventListener('click', function () { _zoomBy(1.4); });
    if (zOut) zOut.addEventListener('click', function () { _zoomBy(1 / 1.4); });
    if (zReset) zReset.addEventListener('click', function () { _fitToView(); scheduleRender(); });
  }

  function _zoomBy(factor) {
    if (d3zoom && d3sel) {
      d3sel.transition().duration(200).call(d3zoom.scaleBy, factor);
    } else {
      var W = canvas.width / (window.devicePixelRatio || 1);
      var H = canvas.height / (window.devicePixelRatio || 1);
      var mx = W / 2, my = H / 2;
      var newK = Math.max(0.05, Math.min(15, transform.k * factor));
      transform.x = mx - (mx - transform.x) * (newK / transform.k);
      transform.y = my - (my - transform.y) * (newK / transform.k);
      transform.k = newK;
      scheduleRender();
    }
  }

  function _showTooltip(node, x, y) {
    if (!tooltipEl) return;
    var typeLabel = TYPE_LABELS[node.type] || node.type;
    tooltipEl.innerHTML = '<span class="graph-tooltip-type">' + typeLabel + '</span>' +
                          _escapeHtml(node.name);
    tooltipEl.style.display = 'block';
    var rect = container.getBoundingClientRect();
    var tw = tooltipEl.offsetWidth;
    var left = x + 14;
    var top = y + 14;
    if (left + tw > container.offsetWidth - 10) left = x - tw - 14;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
  }

  function _hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function _escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s || '');
    return d.innerHTML;
  }

  // ---------- Public: selection ----------

  function selectNode(id) {
    var n = nodeMap[id];
    if (!n) return;
    if (selectedNode && selectedNode.id === id) {
      clearSelection();
      return;
    }
    selectedNode = n;
    neighborSet = new Set();
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (e.source === id) neighborSet.add(e.target);
      else if (e.target === id) neighborSet.add(e.source);
    }
    scheduleRender();
    if (callbacks.onSelect) callbacks.onSelect(n, Array.from(neighborSet));
  }

  function clearSelection() {
    selectedNode = null;
    neighborSet = new Set();
    scheduleRender();
    if (callbacks.onClearSelection) callbacks.onClearSelection();
  }

  // ---------- Public: filters & modes ----------

  function setTypeFilter(type) {
    typeFilter = type || 'all';
    scheduleRender();
  }

  function setViewMode(mode) {
    viewMode = mode === 'episodes' ? 'episodes' : 'community';
    _fitToView();
    scheduleRender();
  }

  function setColorMode(mode) {
    colorMode = mode === 'community' ? 'community' : 'type';
    scheduleRender();
  }

  function setShowLabels(v) { showLabels = !!v; scheduleRender(); }

  function toggleHiddenType(type) {
    if (hiddenTypes.has(type)) hiddenTypes.delete(type);
    else hiddenTypes.add(type);
    _updateLegendState();
    scheduleRender();
  }

  // ---------- Legend ----------

  function _buildLegend() {
    var wrap = document.getElementById('legend-items');
    if (!wrap) return;
    wrap.innerHTML = '';
    var order = ['episode', 'person', 'organization', 'work', 'concept', 'event', 'location', 'theme'];
    order.forEach(function (t) {
      var hasAny = nodes.some(function (n) { return n.type === t; });
      if (!hasAny) return;
      var item = document.createElement('div');
      item.className = 'legend-item';
      item.setAttribute('data-type', t);
      item.innerHTML =
        '<span class="legend-dot" style="background:' + TYPE_COLORS[t] + '"></span>' +
        '<span>' + (TYPE_LABELS[t] || t) + '</span>';
      item.addEventListener('click', function () { toggleHiddenType(t); });
      wrap.appendChild(item);
    });
  }

  function _updateLegendState() {
    var items = document.querySelectorAll('.legend-item');
    items.forEach(function (el) {
      var t = el.getAttribute('data-type');
      if (hiddenTypes.has(t)) el.classList.add('muted');
      else el.classList.remove('muted');
    });
  }

  // ---------- Beautify (rigid per-community translation) ----------

  // Outward spread factor for cached community targets. Higher = more
  // inter-community separation.
  var BEAUTIFY_SPREAD = 1.40;

  // Minimum gap (px, layout space) between community bounding circles when
  // resolving inter-community overlaps.
  var BEAUTIFY_COMMUNITY_GAP = 40;

  var beautifyRunning = false;

  function _groupNodesByCommunity() {
    var groups = {};
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'episode') continue;
      if (n.community == null) continue;
      (groups[n.community] || (groups[n.community] = [])).push(n);
    }
    return groups;
  }

  // Cache per-community target centroids: pipeline centroid pushed outward
  // from global center by BEAUTIFY_SPREAD.
  function _cacheBeautifyTargets() {
    var groups = _groupNodesByCommunity();
    var centroids = {};
    Object.keys(groups).forEach(function (cid) {
      var g = groups[cid];
      var sx = 0, sy = 0;
      g.forEach(function (nd) { sx += nd.baseX; sy += nd.baseY; });
      centroids[cid] = { x: sx / g.length, y: sy / g.length };
    });

    var gx = 0, gy = 0, cnt = 0;
    Object.keys(centroids).forEach(function (cid) {
      gx += centroids[cid].x; gy += centroids[cid].y; cnt++;
    });
    if (cnt > 0) { gx /= cnt; gy /= cnt; }

    beautifyTargets = { fallback: { x: gx, y: gy }, byCommunity: {} };
    Object.keys(centroids).forEach(function (cid) {
      var c = centroids[cid];
      beautifyTargets.byCommunity[cid] = {
        x: gx + (c.x - gx) * BEAUTIFY_SPREAD,
        y: gy + (c.y - gy) * BEAUTIFY_SPREAD
      };
    });
  }

  // Push whole communities apart until no two bounding circles overlap.
  // Moves every node in a community by the same delta — internal layout intact.
  function _separateCommunities(groups) {
    var comms = Object.keys(groups).map(function (cid) {
      var g = groups[cid];
      var sx = 0, sy = 0;
      for (var i = 0; i < g.length; i++) { sx += g[i].baseX; sy += g[i].baseY; }
      var cx = sx / g.length, cy = sy / g.length;
      var r = 0;
      for (var j = 0; j < g.length; j++) {
        var dx = g[j].baseX - cx, dy = g[j].baseY - cy;
        var d = Math.sqrt(dx * dx + dy * dy) + g[j].r0;
        if (d > r) r = d;
      }
      return { cx: cx, cy: cy, r: r, nodes: g };
    });

    var MAX_ITERS = 60;
    for (var iter = 0; iter < MAX_ITERS; iter++) {
      var moved = false;
      for (var a = 0; a < comms.length; a++) {
        for (var b = a + 1; b < comms.length; b++) {
          var A = comms[a], B = comms[b];
          var ddx = B.cx - A.cx, ddy = B.cy - A.cy;
          var distSq = ddx * ddx + ddy * ddy;
          var minDist = A.r + B.r + BEAUTIFY_COMMUNITY_GAP;
          if (distSq < minDist * minDist) {
            var dist = Math.sqrt(distSq) || 0.001;
            var push = (minDist - dist) / 2;
            var nx = ddx / dist, ny = ddy / dist;
            var ax = -nx * push, ay = -ny * push;
            var bx =  nx * push, by =  ny * push;
            A.cx += ax; A.cy += ay;
            B.cx += bx; B.cy += by;
            for (var na = 0; na < A.nodes.length; na++) {
              A.nodes[na].baseX += ax;
              A.nodes[na].baseY += ay;
            }
            for (var nb = 0; nb < B.nodes.length; nb++) {
              B.nodes[nb].baseX += bx;
              B.nodes[nb].baseY += by;
            }
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  function beautify() {
    if (beautifyRunning) return;
    if (!beautifyTargets) _cacheBeautifyTargets();
    beautifyRunning = true;
    var btn = document.getElementById('beautify-btn');
    if (btn) { btn.disabled = true; btn.classList.add('running'); }

    var targets = beautifyTargets.byCommunity;
    var groups = _groupNodesByCommunity();

    // Compute per-community delta: target centroid - current centroid.
    // Every node in the community is translated by the same delta, preserving
    // internal structure and making the community visibly travel as a block.
    var plan = [];
    Object.keys(groups).forEach(function (cid) {
      var t = targets[cid];
      if (!t) return;
      var g = groups[cid];
      var sx = 0, sy = 0;
      for (var i = 0; i < g.length; i++) { sx += g[i].baseX; sy += g[i].baseY; }
      var cx = sx / g.length, cy = sy / g.length;
      var dx = t.x - cx, dy = t.y - cy;
      var starts = new Array(g.length);
      for (var j = 0; j < g.length; j++) {
        starts[j] = { x0: g[j].baseX, y0: g[j].baseY };
      }
      plan.push({ nodes: g, dx: dx, dy: dy, starts: starts });
    });

    var FRAMES = 50;
    var step = 0;

    function frame() {
      step++;
      var t = step / FRAMES;
      var eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      for (var p = 0; p < plan.length; p++) {
        var pl = plan[p];
        for (var i = 0; i < pl.nodes.length; i++) {
          pl.nodes[i].baseX = pl.starts[i].x0 + pl.dx * eased;
          pl.nodes[i].baseY = pl.starts[i].y0 + pl.dy * eased;
        }
      }

      if ((step & 3) === 0) _computeCommunityHulls();
      scheduleRender();

      if (step < FRAMES) {
        requestAnimationFrame(frame);
      } else {
        _separateCommunities(groups);
        _resolveCollisions('community');
        _computeCommunityHulls();
        _fitToView();
        scheduleRender();
        beautifyRunning = false;
        if (btn) { btn.disabled = false; btn.classList.remove('running'); }
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- Public: search integration ----------

  function highlightSearchResults(ids) {
    // Treat as selection of first node if any
    if (ids && ids.length > 0) {
      selectNode(ids[0]);
    } else {
      clearSelection();
    }
  }

  // ---------- Public accessors ----------

  function getTypeLabels() { return TYPE_LABELS; }
  function getTypeColors() { return TYPE_COLORS; }
  function getCommunities() {
    var out = {};
    hulls.forEach(function (h) { out[h.id] = { label: h.name, color: h.color }; });
    return out;
  }
  function getNodeById(id) { return nodeMap[id] || null; }
  function getSelectedNode() { return selectedNode; }

  return {
    init: init,
    selectNode: selectNode,
    clearSelection: clearSelection,
    setTypeFilter: setTypeFilter,
    setViewMode: setViewMode,
    setColorMode: setColorMode,
    setShowLabels: setShowLabels,
    toggleHiddenType: toggleHiddenType,
    highlightSearchResults: highlightSearchResults,
    beautify: beautify,
    setCommunitySpacing: setCommunitySpacing,
    getTypeLabels: getTypeLabels,
    getTypeColors: getTypeColors,
    getCommunities: getCommunities,
    getNodeById: getNodeById,
    getSelectedNode: getSelectedNode,
    render: scheduleRender
  };
})();
