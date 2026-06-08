document.addEventListener("DOMContentLoaded", function () {

  if (document.querySelector(".dmap-global-header")) return;

  const header = `
  <header class="dmap-global-header">
  <div class="dmap-global-inner">
    
    <a href="/" class="dmap-global-brand" aria-label="DMAP-AI home">
      <picture>
        <source media="(max-width: 640px)" srcset="/assets/logo-dmap-ai-225.webp">
        <img src="/assets/logo-dmap-ai-225.webp"
             srcset="/assets/logo-dmap-ai-225.webp 1x, /assets/logo-dmap-ai-450.webp 2x"
             width="225"
             height="69"
             alt="DMAP-AI - Drought Monitoring and Analysis Platform"
             class="dmap-global-logo"
             decoding="async"
             fetchpriority="high">
      </picture>
      
    </a>

    <input class="dmap-menu-checkbox" type="checkbox" id="dmap-main-menu-toggle" aria-hidden="true">
    <label class="dmap-menu-button" for="dmap-main-menu-toggle" aria-label="Open main navigation">
      <span class="dmap-menu-button-bars" aria-hidden="true"></span>
      Menu
    </label>

    
      <a class="dmap-menu-link" href="/">Home</a>

      <details class="dmap-menu-details dmap-menu-details-active">
        <summary>Learn</summary>
        <div class="dmap-dropdown-panel">
          <a href="/tutorials"><strong>Tutorials</strong><span>DMAP-AI learning pages</span></a>
          <a href="/spi_tutorial"><strong>SPI Tutorial</strong><span>Point-based SPI video workflow</span></a>
          <a href="/sv_tutorial"><strong>Research Version Guide</strong><span>Tables, charts, severity, and wavelet outputs</span></a>
          <a href="/formulas"><strong>Methods &amp; Formulas</strong><span>SPI thresholds and drought metrics</span></a>
          <a href="/method-comparison/"><strong>AI Interpretation Study</strong><span>Chart-only vs structured AI outputs</span></a>
        </div>
      </details>

      <details class="dmap-menu-details">
        <summary>Platform</summary>
        <div class="dmap-dropdown-panel">
          <a href="/DMAP_AI_App"><strong>Launch Research Version</strong><span>Open the free SPI analysis tool</span></a>
          <a href="/farmer-version"><strong>Farmer Version</strong><span>Future crop-aware decision support</span></a>
          <a href="/gpt"><strong>GPT App</strong><span>Open GPT App</span></a>
        </div>
      </details>

      <details class="dmap-menu-details">
        <summary>Company</summary>
        <div class="dmap-dropdown-panel">
          <a href="https://agrimetsoft.com/about"><strong>About AgriMetSoft</strong><span>Company background</span></a>
          <a href="https://agrimetsoft.com/contact"><strong>Contact</strong><span>Questions, support, and pilots</span></a>
          <a href="/privacy"><strong>Privacy Policy</strong><span>DMAP-AI privacy information</span></a>
          <a href="/terms"><strong>Terms</strong><span>Website and tool use terms</span></a>
        </div>
      </details>
    </nav>
  </div>
</header>
  `;

  const container = document.createElement("div");
  container.innerHTML = header;

  document.body.prepend(container);
});
document.addEventListener("click", function (e) {
  const details = document.querySelectorAll(".dmap-menu-details");

  // If clicking inside a dropdown, close others
  if (e.target.closest(".dmap-menu-details")) {
    const current = e.target.closest(".dmap-menu-details");

    details.forEach(d => {
      if (d !== current) {
        d.removeAttribute("open");
      }
    });
  } else {
    // click outside → close all
    details.forEach(d => d.removeAttribute("open"));
  }
});