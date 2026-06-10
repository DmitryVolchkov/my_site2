/**
 * Логика точности даты, приблизительности и форматирования для архива.
 */
(function (global) {
  var MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];

  var LABELS = {
    day: 'День',
    month: 'Месяц',
    year: 'Год',
    approximate: 'Приблизительно'
  };

  function hasValue(value) {
    return value != null && String(value).trim() !== '';
  }

  function toInt(value) {
    if (!hasValue(value)) return null;
    var n = parseInt(String(value), 10);
    return Number.isFinite(n) ? n : null;
  }

  function readStartParts(source) {
    var start = source.start_date || source;
    return {
      day: toInt(start.day != null ? start.day : source.start_day),
      month: toInt(start.month != null ? start.month : source.start_month),
      year: toInt(start.year != null ? start.year : source.start_year)
    };
  }

  function readEndParts(source) {
    var end = source.end_date || source;
    return {
      day: toInt(end.day != null ? end.day : source.end_day),
      month: toInt(end.month != null ? end.month : source.end_month),
      year: toInt(end.year != null ? end.year : source.end_year)
    };
  }

  function readSidePrecision(source, side) {
    if (side === 'start') {
      return String(
        source._start_date_precision
        || source.start_date_precision
        || source._date_precision
        || source.date_precision
        || ''
      ).trim();
    }
    return String(source._end_date_precision || source.end_date_precision || '').trim();
  }

  function isApproximateFlag(source, side) {
    var explicit = readSidePrecision(source, side) === 'approximate';
    if (side === 'start') {
      return explicit || !!(source._start_date_approximate || source.start_date_approximate === '1' || source.is_date_approximate === '1');
    }
    return explicit || !!(source._end_date_approximate || source.end_date_approximate === '1');
  }

  function autoPrecisionForParts(parts) {
    if (parts.day != null) return 'day';
    if (parts.month != null) return 'month';
    return 'year';
  }

  function clampPrecision(parts, precision) {
    if (precision === 'day') {
      if (parts.day == null || parts.month == null) {
        return parts.month != null ? 'month' : 'year';
      }
    }
    if (precision === 'month' && parts.month == null) {
      return 'year';
    }
    return precision;
  }

  function effectiveSidePrecision(explicit, parts) {
    if (explicit === 'approximate') return 'approximate';
    if (explicit === 'day' || explicit === 'month' || explicit === 'year') {
      return clampPrecision(parts, explicit);
    }
    return autoPrecisionForParts(parts);
  }

  function formatPart(parts, precision, approximate) {
    var prefix = approximate ? '≈ ' : '';
    if (parts.year == null) return '';

    var resolved = precision === 'approximate' ? autoPrecisionForParts(parts) : precision;

    if (resolved === 'year') {
      return prefix + String(parts.year);
    }

    if (resolved === 'month') {
      if (parts.month != null) {
        return prefix + MONTHS[parts.month - 1] + ' ' + parts.year;
      }
      return prefix + String(parts.year);
    }

    if (parts.day != null && parts.month != null) {
      return prefix + parts.day + ' ' + MONTHS[parts.month - 1] + ' ' + parts.year;
    }
    if (parts.month != null) {
      return prefix + MONTHS[parts.month - 1] + ' ' + parts.year;
    }
    return prefix + String(parts.year);
  }

  function formatEventDate(source) {
    var start = readStartParts(source);
    var end = readEndParts(source);
    var startPrecision = effectiveSidePrecision(readSidePrecision(source, 'start'), start);
    var endPrecision = effectiveSidePrecision(readSidePrecision(source, 'end'), end);
    var startApprox = isApproximateFlag(source, 'start');
    var endApprox = isApproximateFlag(source, 'end');

    if (end.year != null) {
      var left = formatPart(start, startPrecision, startApprox);
      var right = formatPart(end, endPrecision, endApprox);
      if (left && right) return left + ' — ' + right;
      return left || right || '';
    }

    return formatPart(start, startPrecision, startApprox);
  }

  function validateSide(label, precision, parts, requireYear) {
    var issues = [];
    if (!precision) return issues;

    if (requireYear && parts.year == null) {
      issues.push('Укажите год (' + label + ').');
      return issues;
    }

    if (precision === 'day' && parts.day == null) {
      issues.push('Точность «День» (' + label + ') требует день.');
    }
    if (precision === 'month' && parts.month == null) {
      issues.push('Точность «Месяц» (' + label + ') требует месяц.');
    }
    if (precision === 'day' && parts.month == null && parts.day != null) {
      issues.push('Точность «День» (' + label + ') требует месяц.');
    }
    return issues;
  }

  function validateDateInput(source) {
    var start = readStartParts(source);
    var end = readEndParts(source);
    var issues = [];

    if (!start.year) {
      issues.push('Укажите год начала.');
    }

    issues = issues.concat(validateSide('начало', readSidePrecision(source, 'start'), start, false));
    if (end.year != null) {
      issues = issues.concat(validateSide('окончание', readSidePrecision(source, 'end'), end, true));
    }

    if (start.year != null && end.year != null && end.year < start.year) {
      issues.push('Год окончания не может быть раньше года начала.');
    }

    return issues;
  }

  function describeSide(label, explicit, parts, approximate) {
    var precision = effectiveSidePrecision(explicit, parts);
    var text = formatPart(parts, precision, approximate);
    if (!explicit) {
      return label + ': Авто (' + (LABELS[autoPrecisionForParts(parts)] || 'Год') + ')' + (text ? ' → «' + text + '»' : '');
    }
    return label + ': ' + (LABELS[precision] || precision) + (text ? ' → «' + text + '»' : '');
  }

  function describeDateLogic(source) {
    var start = readStartParts(source);
    var end = readEndParts(source);
    var parts = [describeSide('Начало', readSidePrecision(source, 'start'), start, isApproximateFlag(source, 'start'))];
    if (end.year != null) {
      parts.push(describeSide('Окончание', readSidePrecision(source, 'end'), end, isApproximateFlag(source, 'end')));
    }
    return parts.join(' · ');
  }

  global.ArchiveDateFormat = {
    formatEventDate: formatEventDate,
    validateDateInput: validateDateInput,
    describeDateLogic: describeDateLogic,
    effectiveSidePrecision: effectiveSidePrecision,
    readStartParts: readStartParts,
    readEndParts: readEndParts,
    autoPrecisionForParts: autoPrecisionForParts
  };
})(typeof window !== 'undefined' ? window : globalThis);
