(function () {
  // Station-list renderer only.
  // Clean URL redirects must be handled by the server, not JavaScript,
  // because some hosts redirect folder URLs to /index and JS redirects can create a loop.

  function normalize(text) {
    return String(text || '').toLowerCase().trim();
  }

  function stationCard(station, currentSlug) {
    const status = station.status || 'Available';
    const available = normalize(status) === 'available' && station.url;
    const active = station.slug === currentSlug;
    const classes = ['station-card'];
    if (active) classes.push('is-active');
    if (!available) classes.push('is-disabled');

    const label = `${station.name || 'Station'} ${station.coordinates || ''} ${station.period || ''} ${station.summary || ''}`;
    const inner = `
      <strong>${station.station_number ? 'Station ' + station.station_number + '. ' : ''}${station.name || 'Unnamed station'}</strong>
      <span>${station.coordinates ? 'Coordinates: ' + station.coordinates : ''}</span>
      <span>${station.period ? 'Period: ' + station.period : ''}</span>
      <span>${station.summary || ''}</span>
      <span class="station-status">${active ? 'Current page' : status}</span>
    `;

    if (available) {
      return `<a class="${classes.join(' ')}" href="${station.url}" data-station-card data-search="${label.replace(/"/g, '&quot;')}">${inner}</a>`;
    }
    return `<div class="${classes.join(' ')}" data-station-card data-search="${label.replace(/"/g, '&quot;')}">${inner}</div>`;
  }

  function render(root, stations) {
    const currentSlug = root.getAttribute('data-current-slug') || '';
    const availableCount = stations.filter(s => normalize(s.status || 'Available') === 'available').length;
    root.innerHTML = `
      <div class="station-toolbar">
        <input class="station-search" type="search" placeholder="Search station or city..." aria-label="Search comparison stations">
        <span class="station-count-pill">${availableCount} available / ${stations.length} total</span>
      </div>
      <div class="station-grid">
        ${stations.map(station => stationCard(station, currentSlug)).join('')}
      </div>
      <div class="station-empty" role="status">No station matched your search.</div>
    `;

    const input = root.querySelector('.station-search');
    const cards = Array.from(root.querySelectorAll('[data-station-card]'));
    const empty = root.querySelector('.station-empty');
    input.addEventListener('input', function () {
      const q = normalize(input.value);
      let visible = 0;
      cards.forEach(card => {
        const show = !q || normalize(card.getAttribute('data-search')).includes(q);
        card.style.display = show ? '' : 'none';
        if (show) visible += 1;
      });
      empty.classList.toggle('is-visible', visible === 0);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    const roots = Array.from(document.querySelectorAll('[data-stations-nav]'));
    if (!roots.length) return;

    fetch('/method-comparison/stations.json', { cache: 'no-cache' })
      .then(response => {
        if (!response.ok) throw new Error('Station list not available');
        return response.json();
      })
      .then(stations => {
        if (!Array.isArray(stations)) throw new Error('Station list must be an array');
        roots.forEach(root => render(root, stations));
      })
      .catch(() => {
        // Keep the HTML fallback visible if the JSON cannot load.
      });
  });
})();
