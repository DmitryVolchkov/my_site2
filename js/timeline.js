// timeline.js - логика построения шкалы времени

document.addEventListener('DOMContentLoaded', () => {
  const track = document.getElementById('timelineTrack');
  const scrollContainer = document.querySelector('.timeline-scroll');

  // Ожидаем, что timelineEvents определён в глобальной области (в index.html)
  if (!track || !scrollContainer || !Array.isArray(window.timelineEvents)) return;

  const years = window.timelineEvents.map(e => e.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const range = maxYear - minYear || 1; // защита от деления на ноль

  // Делает track достаточно широким: 40 пикселей на каждый "век"
  const pxPerCentury = 40;
  const centuries = range / 100;
  const baseWidth = Math.max(600, Math.round(centuries * pxPerCentury));
  track.style.width = baseWidth + 'px';

  // Создаём маркеры
  window.timelineEvents.forEach(event => {
    const year = event.year;
    const label = event.label || String(year);
    const tooltip = event.tooltip;

    // Позиция по оси: 0% = minYear, 100% = maxYear
    const ratio = (year - minYear) / range;
    const leftPercent = ratio * 100;

    const wrapper = document.createElement('div');
    wrapper.className = 'timeline-marker-wrapper';
    wrapper.style.left = leftPercent + '%';

    const button = document.createElement('button');
    button.className = 'timeline-marker';
    button.type = 'button';
    button.setAttribute('data-year', String(year));
    button.setAttribute('aria-label', label);

    if (typeof tooltip === 'string' && tooltip.length > 0) {
      button.setAttribute('data-tooltip', tooltip);
    }

    // Выделяем нулевой год
    if (year === 0) {
      button.classList.add('timeline-marker-zero');
    } else if (year < 0) {
      button.classList.add('timeline-marker-bc');
    } else if (year > 0) {
      button.classList.add('timeline-marker-ad');
    }

    // Клик по маркеру: центрируем его в видимой области
    button.addEventListener('click', () => {
      const markerCenter = wrapper.offsetLeft + wrapper.offsetWidth / 2;
      const targetScrollLeft = markerCenter - scrollContainer.clientWidth / 2;
      scrollContainer.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth'
      });
    });

    // Подпись года под маркером
    const labelEl = document.createElement('div');
    labelEl.className = 'timeline-label';
    labelEl.textContent = label;

    wrapper.appendChild(button);
    wrapper.appendChild(labelEl);
    track.appendChild(wrapper);
  });

  // При загрузке центрируем 0 год (если есть)
  const zeroElement = track.querySelector('.timeline-marker-zero');
  if (zeroElement) {
    const wrapper = zeroElement.parentElement;
    if (wrapper) {
      const markerCenter = wrapper.offsetLeft + wrapper.offsetWidth / 2;
      const targetScrollLeft = markerCenter - scrollContainer.clientWidth / 2;
      scrollContainer.scrollLeft = Math.max(0, targetScrollLeft);
    }
  }
});
