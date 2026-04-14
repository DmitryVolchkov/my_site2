// timeline-header.js v5
// Диапазон -2000..2025, подписи по десяткам, центральная метка показывает год под собой.

(function () {
  const defaultConfig = {
    minYear: -2000,
    maxYear: 2025,
    groupSteps: [10, 50, 100],
    centerYear: null,          // если null — использовать текущий год
    labelFrequency: 10,
    keyboardStepYears: 10,
    minYearWidth: 2,
    maxYearWidth: 30
  };

  const cfg = Object.assign({}, defaultConfig, window.timelineConfig || {});

  // если центр не задан, используем текущий календарный год
  if (typeof cfg.centerYear !== 'number') {
    cfg.centerYear = new Date().getFullYear();
  }
  // ограничиваем центр диапазоном
  cfg.centerYear = Math.max(cfg.minYear, Math.min(cfg.maxYear, cfg.centerYear));

  const viewport = document.getElementById('timelineViewport');
  const axis = document.getElementById('timelineAxis');
  const centerTooltip = document.getElementById('timelineCenterTooltip');
  if (!viewport || !axis) return;

  let yearWidth = getInitialYearWidth();
  applyYearWidth(yearWidth);

  buildTicks();
  centerOnYear(cfg.centerYear);
  updateCenterTooltip();

  setupWheelScroll();
  setupDragScroll();
  setupKeyboardNavigation();
  setupHoverHighlight();
  viewport.addEventListener('scroll', updateCenterTooltip);
  window.addEventListener('resize', () => {
    centerOnYear(cfg.centerYear);
    updateCenterTooltip();
  });

  function getInitialYearWidth() {
    const rootStyle = getComputedStyle(document.documentElement);
    const val = parseFloat(rootStyle.getPropertyValue('--timeline-year-width')) || 8;
    return val;
  }

  function applyYearWidth(px) {
    yearWidth = Math.max(cfg.minYearWidth, Math.min(cfg.maxYearWidth, px));
    document.documentElement.style.setProperty('--timeline-year-width', yearWidth + 'px');
  }

  function buildTicks() {
    axis.innerHTML = "";

    for (let year = cfg.minYear; year <= cfg.maxYear; year++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'timeline-tick-wrapper';
      wrapper.dataset.year = String(year);
      wrapper.setAttribute('role', 'listitem');

      const tick = document.createElement('div');
      tick.classList.add('timeline-tick');

      const isZero = year === 0;
      const isMajor = isMajorYear(year);

      if (isZero) {
        tick.classList.add('timeline-tick--zero');
      } else if (isMajor) {
        tick.classList.add('timeline-tick--major');
      } else {
        tick.classList.add('timeline-tick--minor');
      }

      const label = document.createElement('div');
      label.classList.add('timeline-label');
      if (isMajor || isZero) {
        label.classList.add('timeline-label--major');
      }

      if (Math.abs(year % cfg.labelFrequency) === 0 || isZero) {
        label.textContent = formatYearLabel(year);
      } else {
        label.textContent = '';
      }

      wrapper.appendChild(tick);
      wrapper.appendChild(label);
      axis.appendChild(wrapper);
    }

    const totalYears = cfg.maxYear - cfg.minYear + 1;
    axis.style.width = (totalYears * yearWidth) + "px";
  }

  function isMajorYear(year) {
    if (year === 0) return true;
    return cfg.groupSteps.some(step => year % step === 0);
  }

  function formatYearLabel(year) {
    if (year === 0) return '0';
    return String(year);
  }

  function centerOnYear(targetYear) {
    const totalYears = cfg.maxYear - cfg.minYear + 1;
    if (totalYears <= 0) return;
    const index = targetYear - cfg.minYear;
    const centerPos = index * yearWidth + yearWidth / 2;
    const viewportWidth = viewport.clientWidth || 1;
    const scrollLeft = centerPos - viewportWidth / 2;
    viewport.scrollLeft = scrollLeft;
  }

  function scrollYears(deltaYears) {
    viewport.scrollLeft += deltaYears * yearWidth;
  }

  function setupWheelScroll() {
    viewport.addEventListener('wheel', (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        handleZoom(event.deltaY);
        return;
      }
      event.preventDefault();
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      viewport.scrollLeft += delta;
      updateCenterTooltip();
    }, { passive: false });
  }

  function handleZoom(deltaY) {
    const zoomFactor = 1.05;
    if (deltaY < 0) {
      applyYearWidth(yearWidth * zoomFactor);
    } else if (deltaY > 0) {
      applyYearWidth(yearWidth / zoomFactor);
    }
    buildTicks();
    centerOnYear(cfg.centerYear);
    updateCenterTooltip();
  }

  function setupDragScroll() {
    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;

    viewport.addEventListener('mousedown', (event) => {
      isDragging = true;
      viewport.classList.add('dragging');
      startX = event.clientX;
      startScrollLeft = viewport.scrollLeft;
      event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
      if (!isDragging) return;
      const dx = event.clientX - startX;
      viewport.scrollLeft = startScrollLeft - dx;
      updateCenterTooltip();
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      viewport.classList.remove('dragging');
    });
  }

  function setupKeyboardNavigation() {
    viewport.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        scrollYears(-cfg.keyboardStepYears);
        updateCenterTooltip();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        scrollYears(cfg.keyboardStepYears);
        updateCenterTooltip();
      }
    });
  }

  function setupHoverHighlight() {
    axis.addEventListener('mousemove', (event) => {
      const wrapper = event.target.closest('.timeline-tick-wrapper');
      axis.querySelectorAll('.timeline-tick-wrapper.highlighted')
          .forEach(el => el.classList.remove('highlighted'));
      if (wrapper) {
        wrapper.classList.add('highlighted');
      }
    });

    axis.addEventListener('mouseleave', () => {
      axis.querySelectorAll('.timeline-tick-wrapper.highlighted')
          .forEach(el => el.classList.remove('highlighted'));
    });
  }

  function updateCenterTooltip() {
    if (!centerTooltip) return;
    const totalYears = cfg.maxYear - cfg.minYear + 1;
    if (totalYears <= 0) return;

    const viewportWidth = viewport.clientWidth || 1;
    const centerPos = viewport.scrollLeft + viewportWidth / 2;

    let index = centerPos / yearWidth;
    let year = Math.round(cfg.minYear + index);

    if (year < cfg.minYear) year = cfg.minYear;
    if (year > cfg.maxYear) year = cfg.maxYear;

    centerTooltip.textContent = String(year);
  }
})();
