/* Төменгі навигация. app.js-ке тиіспейді: бар экрандар мен батырмаларды ғана басқарады. */
(function () {
  'use strict';

  var LABELS = {
    kk: ['Ойын', 'Рейтинг', 'VIP', 'Дүкен', 'Ранг'],
    ru: ['Игра', 'Рейтинг', 'VIP', 'Магазин', 'Ранг'],
    uz: ['O‘yin', 'Reyting', 'VIP', 'Do‘kon', 'Rang'],
    kaa: ['Oyın', 'Reyting', 'VIP', 'Dúkan', 'Rang']
  };

  var TABS = [
    { id: 'menu', screens: ['menu', 'players', 'tour'], icon: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>' },
    { id: 'rating', screens: ['rating'], icon: '<path d="M8 20V9M12 20V4M16 20v-8"/>' },
    { id: 'vip', screens: [], icon: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>' },
    { id: 'shop', screens: ['shop', 'coins', 'refs'], icon: '<path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/>' },
    { id: 'rank', screens: ['rank'], icon: '<circle cx="12" cy="9" r="5"/><path d="M8.5 13.5L7 21l5-3 5 3-1.5-7.5"/>' }
  ];

  var OPEN_BTN = { rating: 'btnRating', vip: 'btnVip', shop: 'btnShop', rank: 'btnRank' };

  function byId(id) { return document.getElementById(id); }

  function init() {
    if (byId('bnav')) return;

    var nav = document.createElement('nav');
    nav.id = 'bnav';
    nav.setAttribute('aria-label', 'Navigation');

    // Сырғитын «шыны» көрсеткіш (iOS Liquid Glass ұқсас)
    var ind = document.createElement('span');
    ind.className = 'ind';
    ind.setAttribute('aria-hidden', 'true');
    nav.appendChild(ind);

    TABS.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-tab', t.id);
      b.innerHTML = '<span class="bt"><svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg></span><span class="bl"></span>';
      b.addEventListener('click', function () { openTab(t.id); });
      nav.appendChild(b);
    });

    document.body.appendChild(nav);

    // «Достарды шақырып койн жина» батырмасы Койн сатып алудың астына көшеді
    var coinBuy = byId('btnCoinsBuy');
    var refsBtn = byId('btnShopRefs');
    if (coinBuy && refsBtn && coinBuy.parentNode && coinBuy.nextElementSibling !== refsBtn) {
      coinBuy.parentNode.insertBefore(refsBtn, coinBuy.nextSibling);
    }

    function activeScreen() {
      var el = document.querySelector('.screen.active');
      return el ? el.id : '';
    }

    function vipOpen() {
      var s = byId('vipSheet');
      return Boolean(s && s.classList.contains('show'));
    }

    // Ойын бөліміне оралу: app.js ішіндегі show('menu') сол экрандардың «артқа» батырмалары арқылы шақырылады
    function goMenu() {
      for (var n = 0; n < 4; n++) {
        var scr = document.querySelector('.screen.active');
        if (!scr || scr.id === 'menu' || scr.id === 'game') return;
        var back = scr.querySelector('[data-back]');
        if (!back && scr.id === 'coins') back = byId('btnCoinsBack');
        if (!back) break;
        back.click();
      }
    }

    var vipBase = '';

    function closeVipPage() {
      var x = byId('vipClose');
      if (x) x.click();
    }

    function openTab(id) {
      if (id === 'vip') {
        if (vipOpen()) return;
        var vb = byId('btnVip');
        if (vb) {
          vipBase = activeScreen();
          document.body.classList.add('vip-page');
          vb.click();
        }
        return;
      }

      if (vipOpen()) closeVipPage();

      if (id === 'menu') {
        goMenu();
        return;
      }

      var btn = byId(OPEN_BTN[id]);
      if (btn) btn.click();
    }

    function setLabels() {
      var lang = document.documentElement.lang;
      var arr = LABELS[lang] || LABELS.kk;
      var labels = nav.querySelectorAll('.bl');
      for (var i = 0; i < labels.length; i++) labels[i].textContent = arr[i];
    }

    var lastIdx = -2;
    var moveTimer = null;

    function moveIndicator(current) {
      var idx = -1;
      TABS.forEach(function (t, i) { if (t.id === current) idx = i; });
      if (idx === lastIdx) return;

      ind.classList.toggle('hide', idx < 0);

      if (idx >= 0) {
        nav.style.setProperty('--i', String(idx));

        if (lastIdx !== -2) {
          nav.classList.add('moving');
          clearTimeout(moveTimer);
          moveTimer = setTimeout(function () { nav.classList.remove('moving'); }, 260);
        }
      }

      lastIdx = idx;
    }

    function sync() {
      var scr = activeScreen();
      var show = false;
      var current = '';

      TABS.forEach(function (t) {
        if (t.screens.indexOf(scr) !== -1) { show = true; current = t.id; }
      });

      if (show && vipOpen()) current = 'vip';

      document.body.classList.toggle('has-nav', show);

      // VIP беті жабылған соң толық экран режимін сәл кідіріп алып тастаймыз (жабылу анимациясы бітуі үшін)
      if (!vipOpen() && document.body.classList.contains('vip-page')) {
        setTimeout(function () {
          if (!vipOpen()) document.body.classList.remove('vip-page');
        }, 350);
      }

      // VIP беті ашық тұрғанда экран өзгерсе (мысалы, шақыру қабылданып ойын басталса), VIP бетін жабамыз
      if (vipOpen() && document.body.classList.contains('vip-page') && scr && scr !== vipBase) {
        closeVipPage();
      }

      moveIndicator(current);

      var btns = nav.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === current);
      }
    }

    window.__bnavSync = sync;
    setLabels();
    sync();
    setTimeout(function () { nav.classList.add('ready'); }, 80);

    if (window.MutationObserver) {
      var mo = new MutationObserver(sync);
      var screens = document.querySelectorAll('.screen');
      for (var i = 0; i < screens.length; i++) mo.observe(screens[i], { attributes: true, attributeFilter: ['class'] });
      if (byId('vipSheet')) mo.observe(byId('vipSheet'), { attributes: true, attributeFilter: ['class'] });

      new MutationObserver(setLabels).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
