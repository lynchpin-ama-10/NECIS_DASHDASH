// app.js
document.addEventListener('DOMContentLoaded', () => {
    const hamburger = document.getElementById('hamburgerBtn');
    const sidebar = document.querySelector('.sg-sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const mobileToggle = document.getElementById('mobileNavToggle');
    const navLinks = document.querySelector('.sg-nav-links');

    if (hamburger && sidebar && overlay) {
        hamburger.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none';
        });
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.style.display = 'none';
        });
    }
    if (mobileToggle && navLinks) {
        mobileToggle.addEventListener('click', () => {
            navLinks.style.display = navLinks.style.display === 'flex' ? 'none' : 'flex';
        });
    }
});
