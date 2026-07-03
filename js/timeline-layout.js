/**
 * Раскладка menubar слева без перемещения узлов TimelineJS (сохраняет работу слайдера).
 */
(function () {
  var menubarObserver = null;
  var timenavObserver = null;
  var embedResizeObserver = null;
  var pageScrollTimer = null;
  var layoutTimer = null;
  var layoutRetries = 0;
  // true после первого успешного timenav.updateDisplay(): пока false, TimelineJS ещё
  // не отрисовал реальные размеры (например #timelinejs-embed скрыт/нулевой при 'loaded').
  var displayInitialized = false;
  var MAX_LAYOUT_RETRIES = 40;

  function childByClass(parent, className) {
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].classList.contains(className)) {
        return parent.children[i];
      }
    }
    return null;
  }

  function restoreTimenavStructure(embed) {
    var timenav = embed.querySelector('.tl-timenav');
    if (!timenav) {
      return;
    }

    var stack = childByClass(timenav, 'tl-timenav-stack');
    if (stack) {
      while (stack.firstChild) {
        timenav.insertBefore(stack.firstChild, stack);
      }
      stack.remove();
    }

    var menubar = timenav.querySelector(':scope > .tl-menubar') || childByClass(timenav, 'tl-menubar');
    if (menubar && menubar.parentElement === timenav) {
      embed.appendChild(menubar);
    }
  }

  function collapseAlternateTimegroup(embed) {
    var groups = embed.querySelectorAll('.tl-timegroup.tl-timegroup-alternate');
    for (var i = 0; i < groups.length; i++) {
      groups[i].style.setProperty('display', 'none', 'important');
      groups[i].style.setProperty('height', '0', 'important');
      groups[i].style.setProperty('min-height', '0', 'important');
      groups[i].style.setProperty('max-height', '0', 'important');
      groups[i].style.setProperty('overflow', 'hidden', 'important');
      groups[i].style.setProperty('pointer-events', 'none', 'important');
    }
  }

  function getEmbedSize(embed) {
    return {
      width: embed.offsetWidth || embed.clientWidth || 0,
      height: embed.clientHeight || embed.offsetHeight || 0
    };
  }

  function hasValidEmbedSize(embed) {
    var size = getEmbedSize(embed);
    return size.width > 0 && size.height > 0;
  }

  function pinTimenavHeight(embed, timenav) {
    var h = getEmbedSize(embed).height;
    if (h > 0) {
      timenav.style.setProperty('height', h + 'px', 'important');
      timenav.style.setProperty('max-height', h + 'px', 'important');
      timenav.style.setProperty('overflow', 'hidden', 'important');
    }
  }

  // withRedraw=false пропускает updateDisplay() — используется на pinsOnly-проходах
  // (скролл страницы), где дорогой внутренний layout TimelineJS не нужен, достаточно
  // поправить CSS-пины оси/menubar.
  function syncTimenavOptions(timeline, embed, withRedraw) {
    if (!timeline || !embed) {
      return false;
    }

    var size = getEmbedSize(embed);
    if (size.height <= 0) {
      return false;
    }

    timeline.options.timenav_height = size.height;

    if (!timeline._timenav || !timeline._timenav.options) {
      return false;
    }

    timeline._timenav.options.height = size.height;

    if (!withRedraw || typeof timeline._timenav.updateDisplay !== 'function') {
      return true;
    }

    if (size.width <= 0) {
      return false;
    }

    timeline._timenav.updateDisplay(size.width, size.height);
    displayInitialized = true;
    return true;
  }

  function watchTimenavHeight(embed, timenav) {
    if (timenavObserver) {
      timenavObserver.disconnect();
    }

    pinTimenavHeight(embed, timenav);
    timenavObserver = new MutationObserver(function () {
      var expected = getEmbedSize(embed).height;
      var current = parseInt(timenav.style.height, 10);
      if (!expected || current !== expected) {
        pinTimenavHeight(embed, timenav);
      }
    });
    timenavObserver.observe(timenav, { attributes: true, attributeFilter: ['style'] });
  }

  function pinMarkerHeights(embed) {
    var h = getComputedStyle(document.documentElement).getPropertyValue('--tl-marker-height').trim() || '55px';
    var nodes = embed.querySelectorAll(
      '.tl-timemarker-content-container, .tl-timemarker-timespan-content'
    );

    for (var i = 0; i < nodes.length; i++) {
      nodes[i].style.setProperty('height', h, 'important');
      nodes[i].style.setProperty('max-height', h, 'important');
      nodes[i].style.setProperty('min-height', h, 'important');
    }
  }

  function pinTimeAxis(embed) {
    var axisHeight = getComputedStyle(document.documentElement).getPropertyValue('--tl-timeaxis-height').trim() || '39px';
    var axisBg = embed.querySelector('.tl-timeaxis-background');
    var axis = embed.querySelector('.tl-timeaxis');
    [axisBg, axis].forEach(function (el) {
      if (!el) return;
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('height', axisHeight, 'important');
      el.style.setProperty('min-height', axisHeight, 'important');
      el.style.setProperty('max-height', axisHeight, 'important');
      el.style.setProperty('bottom', '0', 'important');
      el.style.setProperty('top', 'auto', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
    });

    var layers = embed.querySelectorAll(
      '.tl-timeaxis-major, .tl-timeaxis-minor, ' +
      '.tl-timeaxis-major .tl-timeaxis-tick-text, .tl-timeaxis-minor .tl-timeaxis-tick-text'
    );
    for (var i = 0; i < layers.length; i++) {
      layers[i].style.setProperty('opacity', '1', 'important');
      layers[i].style.setProperty('visibility', 'visible', 'important');
    }
  }

  function pinMenubar(embed, menubar) {
    var w = 36;
    embed.style.setProperty('--tl-menubar-width', w + 'px');

    menubar.style.setProperty('position', 'absolute', 'important');
    menubar.style.setProperty('top', '0', 'important');
    menubar.style.setProperty('left', '0', 'important');
    menubar.style.setProperty('right', 'auto', 'important');
    menubar.style.setProperty('width', w + 'px', 'important');
    menubar.style.setProperty('height', '100%', 'important');
    menubar.style.setProperty('transform', 'none', 'important');
    menubar.style.setProperty('justify-content', 'space-evenly', 'important');
    menubar.style.removeProperty('gap');
  }

  function watchMenubar(embed, menubar) {
    if (menubarObserver) {
      menubarObserver.disconnect();
    }
    pinMenubar(embed, menubar);
    menubarObserver = new MutationObserver(function () {
      pinMenubar(embed, menubar);
    });
    menubarObserver.observe(menubar, { attributes: true, attributeFilter: ['style'] });
  }

  // pinsOnly=true — облегчённый проход (используется при скролле страницы): только
  // переустановка CSS-пинов оси/menubar, без перестройки structure/timenav и без
  // updateDisplay(). Полный проход (pinsOnly=false) нужен один раз при 'loaded'/resize.
  function layoutTimelineNav(timeline, options) {
    options = options || {};
    var withRedraw = options.withRedraw !== false;
    var pinsOnly = options.pinsOnly === true;

    var embed = document.getElementById('timelinejs-embed');
    if (!embed) {
      return false;
    }

    var menubar = embed.querySelector('.tl-menubar');
    var timenav = embed.querySelector('.tl-timenav');
    if (!menubar || !timenav) {
      return false;
    }

    if (!pinsOnly) {
      restoreTimenavStructure(embed);

      var storyslider = embed.querySelector('.tl-storyslider');
      if (storyslider) {
        storyslider.style.height = '0px';
      }

      var attribution = embed.querySelector('.tl-attribution');
      if (attribution) {
        attribution.remove();
      }

      embed.classList.add('tl-layout-custom');
      collapseAlternateTimegroup(embed);
      pinTimenavHeight(embed, timenav);
      var redrawOk = syncTimenavOptions(timeline, embed, withRedraw);
      pinMarkerHeights(embed);
      watchTimenavHeight(embed, timenav);
      watchMenubar(embed, menubar);

      if (withRedraw && !redrawOk) {
        return false;
      }
    }

    pinTimeAxis(embed);
    if (pinsOnly) {
      pinMenubar(embed, menubar);
    }

    return true;
  }

  function applyLayout(timeline, options) {
    var ok = layoutTimelineNav(timeline, options);
    requestAnimationFrame(function () {
      layoutTimelineNav(timeline, options);
    });
    return ok;
  }

  function bindPageScrollRefresh(timeline) {
    var embed = document.getElementById('timelinejs-embed');
    if (!embed) {
      return;
    }

    function scheduleRefresh() {
      clearTimeout(pageScrollTimer);
      pageScrollTimer = setTimeout(function () {
        var rect = embed.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) {
          applyLayout(timeline, { withRedraw: false, pinsOnly: true });
        }
      }, 150);
    }

    window.addEventListener('scroll', scheduleRefresh, { passive: true });
  }

  function bind(timeline) {
    if (!timeline || typeof timeline.on !== 'function') {
      return;
    }

    var fullLayoutOptions = { withRedraw: true, pinsOnly: false };

    // TimelineJS может эмитить 'loaded' до того, как .tl-timemarker появился в DOM или
    // #timelinejs-embed получил ненулевые размеры (скрытый таб, ещё не завершённый layout
    // страницы). Поэтому вместо однократного apply() — поллинг с ретраями, пока оба условия
    // не выполнены; ResizeObserver ниже подстраховывает случай, когда контейнер становится
    // видимым уже после исчерпания или до первого запуска ретраев.
    function scheduleFullLayout(forceRedraw) {
      clearTimeout(layoutTimer);

      layoutTimer = setTimeout(function () {
        var embed = document.getElementById('timelinejs-embed');
        if (!embed || !embed.querySelector('.tl-timemarker')) {
          if (layoutRetries < MAX_LAYOUT_RETRIES) {
            layoutRetries += 1;
            scheduleFullLayout(forceRedraw);
          }
          return;
        }

        if (!hasValidEmbedSize(embed)) {
          if (layoutRetries < MAX_LAYOUT_RETRIES) {
            layoutRetries += 1;
            scheduleFullLayout(forceRedraw);
          }
          return;
        }

        if (forceRedraw) {
          displayInitialized = false;
        }

        if (displayInitialized && !forceRedraw) {
          applyLayout(timeline, { withRedraw: false, pinsOnly: true });
          return;
        }

        var ok = applyLayout(timeline, fullLayoutOptions);
        if (!ok && layoutRetries < MAX_LAYOUT_RETRIES) {
          layoutRetries += 1;
          scheduleFullLayout(forceRedraw);
        } else if (ok) {
          layoutRetries = 0;
        }
      }, layoutRetries ? 50 : 0);
    }

    function onResize() {
      layoutRetries = 0;
      scheduleFullLayout(true);
    }

    timeline.on('loaded', function () {
      layoutRetries = 0;
      scheduleFullLayout(true);
    });

    timeline.on('resize', onResize);
    window.addEventListener('resize', onResize);
    bindPageScrollRefresh(timeline);

    var embed = document.getElementById('timelinejs-embed');
    if (embed && 'ResizeObserver' in window) {
      if (embedResizeObserver) {
        embedResizeObserver.disconnect();
      }
      embedResizeObserver = new ResizeObserver(function () {
        if (!displayInitialized && hasValidEmbedSize(embed) && embed.querySelector('.tl-timemarker')) {
          scheduleFullLayout(true);
        }
      });
      embedResizeObserver.observe(embed);
    }

    if (document.readyState === 'complete') {
      scheduleFullLayout(true);
    } else {
      window.addEventListener('load', function () {
        scheduleFullLayout(true);
      });
    }
  }

  window.layoutTimelineNav = function (timeline) {
    displayInitialized = false;
    applyLayout(timeline || window.__timeline, { withRedraw: true, pinsOnly: false });
  };
  window.bindTimelineLayout = bind;
})();
