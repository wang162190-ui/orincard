/* ═══════════════════════════════════════════════════════════════════════
   Ori — Orincard's brand mark. A paper crane folded from four planes.
   Construction rules: straight edges only, one fold angle per crease,
   ink outline, flat fills from the signal palette, one eye dot, no mouth.
   ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var PLANES = {
    beak:   [[1.8, 8.6], [5.4, 4.8], [3.7, 7.3]],
    neck:   [[5.4, 4.8], [11.0, 11.0], [8.8, 13.4], [3.7, 7.3]],
    wingup: [[11.0, 11.0], [21.2, 3.0], [16.6, 12.8]],
    wingdn: [[8.8, 13.4], [6.4, 20.4], [14.6, 16.2]],
    body:   [[11.0, 11.0], [16.6, 12.8], [14.6, 16.2], [8.8, 13.4]],
    tail:   [[16.6, 12.8], [22.8, 15.6], [14.6, 16.2]]
  };
  var ORDER = ['wingdn', 'body', 'tail', 'wingup', 'neck', 'beak'];
  var FILL = {
    beak: 'var(--sig-blue)', neck: 'var(--sig-blue)',
    wingup: 'var(--sig-yellow)', wingdn: 'var(--sig-pink)',
    body: 'var(--surface)', tail: 'var(--sig-yellow)'
  };
  var EYE = [4.9, 6.7];

  function pts(plane) {
    return PLANES[plane].map(function (p) { return p.join(','); }).join(' ');
  }

  function open(size, cls) {
    return '<svg class="ori ' + (cls || '') + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false">';
  }

  /* Small monochrome mark for the rail and other chrome. Filled, not outlined —
     an outline at 24px loses the fold edges and reads as a scribble. */
  function mark(size, color) {
    var fill = color || 'currentColor';
    var s = open(size || 24, 'ori-mark');
    ORDER.forEach(function (k) {
      s += '<polygon points="' + pts(k) + '" fill="' + fill +
        '" stroke="' + fill + '" stroke-width="1.6" stroke-linejoin="round"/>';
    });
    return s + '</svg>';
  }

  /* Full-colour crane. state: 'rest' | 'folding' */
  function crane(size, state) {
    var s = open(size || 96, 'ori-crane' + (state === 'folding' ? ' is-folding' : ''));
    ORDER.forEach(function (k, i) {
      s += '<polygon class="ori-p" style="--i:' + i + '" points="' + pts(k) +
        '" fill="' + FILL[k] + '" stroke="var(--fg)" stroke-width="0.85" stroke-linejoin="round"/>';
    });
    s += '<circle cx="' + EYE[0] + '" cy="' + EYE[1] + '" r="0.78" fill="var(--fg)"/>';
    return s + '</svg>';
  }

  /* The sheet that never got folded — used when an import cannot restore an
     asset. The creases still say what it was meant to become. */
  function unfolded(size) {
    var s = open(size || 96, 'ori-unfolded');
    s += '<polygon points="12,1.6 22.4,12 12,22.4 1.6,12" fill="var(--surface)" ' +
      'stroke="var(--fg)" stroke-width="0.85" stroke-linejoin="round"/>';
    var creases = [
      [12, 1.6, 12, 22.4], [1.6, 12, 22.4, 12],
      [6.8, 6.8, 17.2, 17.2], [17.2, 6.8, 6.8, 17.2]
    ];
    creases.forEach(function (c) {
      s += '<line x1="' + c[0] + '" y1="' + c[1] + '" x2="' + c[2] + '" y2="' + c[3] +
        '" stroke="var(--fg)" stroke-width="0.4" stroke-dasharray="1.4 1.1" opacity="0.5"/>';
    });
    return s + '</svg>';
  }

  global.Ori = { mark: mark, crane: crane, unfolded: unfolded };
})(window);
