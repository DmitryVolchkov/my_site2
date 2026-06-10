/**
 * Раскладка menubar слева без перемещения узлов TimelineJS (сохраняет работу слайдера).
 */
(function () {
  var menubarObserver = null;
  var timenavObserver = null;
  var pageScrollTimer = null;
  var intersectionObserver = null;

  function childByClass(parent, className) {
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].classList.contains(className)) {
        return parent.children[i];
      }
    }
    return null;
  }

  /** Вернуть DOM, если осталась старая обёртка tl-timenav-stack */
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

  function getEmbedHeight(embed) {
    return embed.clientHeight || embed.offsetHeight || 0;
  }

  function pinTimenavHeight(embed, timenav) {
    var h = getEmbedHeight(embed);
    if (h > 0) {
      timenav.style.setProperty('height', h + 'px', 'important');
      timenav.style.setProperty('max-height', h + 'px', 'important');
      timenav.style.setProperty('overflow', 'hidden', 'important');
    }
  }

  function syncTimenavOptions(timeline, embed) {
    if (!timeline || !embed) {
      return;
    }

    var h = getEmbedHeight(embed);
    if (h <= 0) {
      return;
    }

    timeline.options.timenav_height = h;

    if (timeline._timenav && timeline._timenav.options) {
      timeline._timenav.options.height = h;
      if (typeof timeline._timenav.updateDisplay === 'function') {
        var w = embed.offsetWidth || embed.clientWidth || timeline.options.width;
        timeline._timenav.updateDisplay(w, h);
      }
    }
  }

  function watchTimenavHeight(embed, timenav) {
    if (timenavObserver) {
      timenavObserver.disconnect();
    }

    pinTimenavHeight(embed, timenav);
    timenavObserver = new MutationObserver(function () {
      var expected = getEmbedHeight(embed);
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

    var majors = embed.querySelectorAll('.tl-timeaxis-major, .tl-timeaxis-minor');
    for (var i = 0; i < majors.length; i++) {
      majors[i].style.setProperty('opacity', '1', 'important');
      majors[i].style.setProperty('visibility', 'visible', 'important');
    }

    var tickTexts = embed.querySelectorAll('.tl-timeaxis-major .tl-timeaxis-tick-text');
    for (var j = 0; j < tickTexts.length; j++) {
      tickTexts[j].style.setProperty('opacity', '1', 'important');
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

  function layoutTimelineNav(timeline) {
    var embed = document.getElementById('timelinejs-embed');
    if (!embed) {
      return;
    }

    restoreTimenavStructure(embed);

    var menubar = embed.querySelector('.tl-menubar');
    var timenav = embed.querySelector('.tl-timenav');
    if (!menubar || !timenav) {
      return;
    }

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
    syncTimenavOptions(timeline, embed);
    pinMarkerHeights(embed);
    pinTimeAxis(embed);
    watchTimenavHeight(embed, timenav);
    watchMenubar(embed, menubar);
  }

  function refreshAfterPageScroll(timeline) {
    layoutTimelineNav(timeline);
    requestAnimationFrame(function () {
      layoutTimelineNav(timeline);
    });
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
          refreshAfterPageScroll(timeline);
        }
      }, 150);
    }

    window.addEventListener('scroll', scheduleRefresh, { passive: true });
    window.addEventListener('pageshow', function () {
      refreshAfterPageScroll(timeline);
    });

    if (intersectionObserver) {
      intersectionObserver.disconnect();
    }
    if ('IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              scheduleRefresh();
            }
          });
        },
        { threshold: 0.2 }
      );
      intersectionObserver.observe(embed);
    }
  }

  function bind(timeline) {
    if (!timeline || typeof timeline.on !== 'function') {
      return;
    }

    function apply() {
      layoutTimelineNav(timeline);
      requestAnimationFrame(function () {
        layoutTimelineNav(timeline);
      });
    }

    timeline.on('loaded', apply);
    timeline.on('resize', apply);
    bindPageScrollRefresh(timeline);
    apply();
    setTimeout(apply, 50);
    setTimeout(apply, 300);
  }

  window.layoutTimelineNav = function (timeline) {
    layoutTimelineNav(timeline || window.__timeline);
  };
  window.bindTimelineLayout = bind;
})();
