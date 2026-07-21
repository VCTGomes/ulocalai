/* ════════════════════════════════════════════════════════════════
   RMF — Material 3 top app bar: estado "on-scroll".
   Em repouso a app bar usa surface (= fundo da página). Quando o conteúdo
   rola por baixo, ganha o tom elevado surface-container (classe .is-scrolled).

   Funciona tanto com app bar position:fixed (privacidade/feedback, documento
   rola) quanto sticky (páginas SSR de cidade). Usa IntersectionObserver sobre
   uma sentinela de 1px no topo — mais barato que escutar scroll. Fallback de
   scroll passivo para navegadores sem IO.

   Acha a app bar por .m3-appbar OU .nv-appbar (Novidades usa a sua própria
   .nv-appbar) — o gancho de JS é independente da classe visual, então nenhuma
   página precisa emprestar a classe de outra só pra ser detectada aqui.

   Uso: <script src="/res/assets/js/m3-appbar-scroll.js" defer></script>
   e no CSS:
     .m3-appbar { transition: background-color 200ms ease; }
     .m3-appbar.is-scrolled { background: var(--md-sys-color-surface-container); }
   ════════════════════════════════════════════════════════════════ */
(function () {
  function init() {
    var bar = document.querySelector('.m3-appbar, .nv-appbar, .topbar');
    if (!bar) return;

    // Captura metas de theme-color e seus valores originais para restaurar ao voltar ao topo
    var themeMetas = Array.prototype.slice.call(document.querySelectorAll('meta[name="theme-color"]'));
    var origColors = themeMetas.map(function (m) { return m.getAttribute('content'); });

    function setScrolled(on) {
      bar.classList.toggle('is-scrolled', !!on);
      if (!themeMetas.length) return;
      if (on) {
        var scrolledColor = getComputedStyle(document.documentElement)
          .getPropertyValue('--md-rmf-appbar-scrolled').trim();
        if (scrolledColor) {
          themeMetas.forEach(function (m) { m.setAttribute('content', scrolledColor); });
        }
      } else {
        themeMetas.forEach(function (m, i) { m.setAttribute('content', origColors[i]); });
      }
    }

    if ('IntersectionObserver' in window) {
      // Sentinela invisível ancorada no topo do documento. Quando sai do
      // viewport (= rolou ao menos 1px), a app bar "eleva".
      var sentinel = document.createElement('div');
      sentinel.setAttribute('aria-hidden', 'true');
      sentinel.style.cssText =
        'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;';
      document.body.prepend(sentinel);
      new IntersectionObserver(function (entries) {
        setScrolled(!entries[0].isIntersecting);
      }).observe(sentinel);
    } else {
      var onScroll = function () {
        setScrolled((window.scrollY || document.documentElement.scrollTop || 0) > 0);
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
