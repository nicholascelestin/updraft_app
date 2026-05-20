// Mounts a small "Desktop" link in the right side of aitools' header.
// On click, lazy-imports the modal module (which itself lazy-imports
// the heavyweight sources/compose/fflate modules only when the user
// actually starts a download).
//
// This is the ONLY file in desktop/ that's imported by the web app on
// page load. Everything else is loaded on demand.

function makeNavItem() {
  const li = document.createElement('li');
  li.innerHTML = `
    <a href="#" data-desktop-download>
      <i class="fas fa-download"></i> Desktop
    </a>
  `;
  li.querySelector('a').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const { openDownloadModal } = await import('./download-modal.js');
      await openDownloadModal();
    } catch (err) {
      console.error('[desktop-download] failed to open modal:', err);
      alert('Could not open desktop download dialog: ' + (err?.message || err));
    }
  });
  return li;
}

function mount() {
  // Aitools' header has two <ul>s in nav.container-fluid: brand on the
  // left, feature links on the right. We append to the right one.
  const rightNav = document.querySelector('nav.container-fluid > ul:last-child');
  if (!rightNav) {
    console.warn('[desktop-download] could not find right-side nav; skipping mount');
    return;
  }
  // Avoid double-mount on hot-reload.
  if (rightNav.querySelector('[data-desktop-download]')) return;
  rightNav.appendChild(makeNavItem());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
