// refraction.js — Chromium-only Liquid Glass refraction (ported from
// design/liquid-glass/refract.js). Extracted from overlay.js so the material
// system is a standalone, independently mergeable unit.
//
// Builds SVG displacement maps (each pixel's R/G encodes an X/Y offset, 128 =
// neutral), injects the #lg-lens-* filters the overlay.css refraction rules
// reference, then arms html.lg-lens. Only Chromium renders SVG filters inside
// backdrop-filter — CSS.supports() can't tell (Safari parses but renders
// nothing) — so detection is a userAgentData brand probe. Off-Chromium this
// no-ops and the frosted backdrop-filter baseline stands. No dependencies.
//
// Loaded as a separate content script before overlay.js (see manifest.json
// "js" order) and exposes window.__rvMountRefraction for overlay.js to call
// once, when #rv-root first mounts.
(() => {
  'use strict';

  function mountRefraction() {
    if (document.getElementById('lg-lens-capsule')) return; // once
    const brands = navigator.userAgentData && navigator.userAgentData.brands;
    const chromium = !!(brands && brands.some((b) => /chromium/i.test(b.brand)));
    if (!chromium) return;
    if (typeof CSS === 'undefined' || !CSS.supports('backdrop-filter', 'blur(1px)')) return;

    function makeMap(w, h, r, bezel) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      const px = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x + 0.5 - w / 2;
          const dy = y + 0.5 - h / 2;
          const qx = Math.abs(dx) - (w / 2 - r);
          const qy = Math.abs(dy) - (h / 2 - r);
          const ax = Math.max(qx, 0);
          const ay = Math.max(qy, 0);
          const dist = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
          const inward = -dist;
          let mag = 0;
          if (inward >= 0 && inward < bezel) mag = Math.pow(1 - inward / bezel, 1.6);
          let nx = 0;
          let ny = 0;
          if (ax > 0 || ay > 0) {
            const len = Math.hypot(ax, ay) || 1;
            nx = (Math.sign(dx) * ax) / len;
            ny = (Math.sign(dy) * ay) / len;
          } else if (qx > qy) {
            nx = Math.sign(dx) || 1;
          } else {
            ny = Math.sign(dy) || 1;
          }
          const i = (y * w + x) * 4;
          px[i] = Math.round(128 + nx * mag * 127);
          px[i + 1] = Math.round(128 + ny * mag * 127);
          px[i + 2] = 128;
          px[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL('image/png');
    }

    const NS = 'http://www.w3.org/2000/svg';
    function filterEl(id, imgId) {
      const f = document.createElementNS(NS, 'filter');
      f.setAttribute('id', id);
      f.setAttribute('x', '0'); f.setAttribute('y', '0');
      f.setAttribute('width', '100%'); f.setAttribute('height', '100%');
      f.setAttribute('color-interpolation-filters', 'sRGB');
      const fe = document.createElementNS(NS, 'feImage');
      fe.setAttribute('id', imgId);
      fe.setAttribute('preserveAspectRatio', 'none');
      fe.setAttribute('width', '100%'); fe.setAttribute('height', '100%');
      fe.setAttribute('result', 'map');
      const disp = document.createElementNS(NS, 'feDisplacementMap');
      disp.setAttribute('in', 'SourceGraphic');
      disp.setAttribute('in2', 'map');
      disp.setAttribute('scale', '-46');
      disp.setAttribute('xChannelSelector', 'R');
      disp.setAttribute('yChannelSelector', 'G');
      f.appendChild(fe); f.appendChild(disp);
      return f;
    }
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.appendChild(filterEl('lg-lens-capsule', 'lg-lens-capsule-img'));
    svg.appendChild(filterEl('lg-lens-card', 'lg-lens-card-img'));
    (document.body ?? document.documentElement).appendChild(svg);

    function setHref(elm, url) {
      elm.setAttribute('href', url);
      elm.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
    }
    setHref(svg.querySelector('#lg-lens-capsule-img'), makeMap(320, 44, 22, 14));
    setHref(svg.querySelector('#lg-lens-card-img'), makeMap(320, 200, 16, 16));
    document.documentElement.classList.add('lg-lens');
  }

  window.__rvMountRefraction = mountRefraction;
})();
