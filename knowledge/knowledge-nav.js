(function () {
  function normalize(text) {
    return String(text || '').toLowerCase().trim();
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function articleCard(article, currentSlug) {
    const status = article.status || 'Available';
    const available = normalize(status) === 'available';
    const active = article.slug === currentSlug;
    const classes = ['station-card'];

    if (active) classes.push('is-active');
    if (!available) classes.push('is-disabled');

    const label = [
      article.title,
      article.summary,
      article.category,
      article.difficulty,
      article.status
    ].join(' ');

    const badge = active ? 'Current page' : status;

    const inner = `
      <strong>${escapeHtml(article.title)}</strong>
      <span><strong>Category:</strong> ${escapeHtml(article.category || 'Knowledge Center')}</span>
      <span>${escapeHtml(article.summary || '')}</span>
      <span>📖 Reading time: ${escapeHtml(article.readingTime || '—')}</span>
      <span>🎓 Level: ${escapeHtml(article.difficulty || '—')}</span>
      <span class="station-status">${escapeHtml(badge)}</span>
    `;

    if (available) {
      return `<a class="${classes.join(' ')}" href="/knowledge/${encodeURIComponent(article.slug)}/" data-article-card data-search="${escapeHtml(label)}">${inner}</a>`;
    }

    return `<div class="${classes.join(' ')}" data-article-card data-search="${escapeHtml(label)}" aria-disabled="true">${inner}</div>`;
  }

  function render(root, articles) {
    const currentSlug = root.getAttribute('data-current-slug') || '';
    const availableCount = articles.filter(a => normalize(a.status || 'Available') === 'available').length;

    root.innerHTML = `
      <div class="station-toolbar">
        <input class="station-search" type="search" placeholder="Search articles..." aria-label="Search Knowledge Center articles">
        <span class="station-count-pill">${availableCount} available / ${articles.length} total</span>
      </div>

      <div class="knowledge-scroll-panel" style="max-height:720px;overflow-y:auto;padding-right:6px;">
        <div class="station-grid">
          ${articles.map(article => articleCard(article, currentSlug)).join('')}
        </div>
      </div>

      <div class="station-empty" role="status">No article matched your search.</div>
    `;

    const input = root.querySelector('.station-search');
    const cards = Array.from(root.querySelectorAll('[data-article-card]'));
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
    const roots = Array.from(document.querySelectorAll('[data-articles-nav]'));
    if (!roots.length) return;

    fetch('/knowledge/articles.json', { cache: 'no-cache' })
      .then(response => {
        if (!response.ok) throw new Error('Article list not available');
        return response.json();
      })
      .then(data => {
        if (!Array.isArray(data.articles)) throw new Error('articles.json must include an articles array');
        roots.forEach(root => render(root, data.articles));
      })
      .catch(error => {
        console.error(error);
      });
  });
})();
