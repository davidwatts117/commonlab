'use strict';

// Shared site behavior. The data-driven page calls this after its slots exist.
function initializeSimulationChrome() {
    const simLayout = document.querySelector('.sim-layout');
    const canvasWrap = document.querySelector('.canvas-wrapper');
    if (!simLayout || !canvasWrap || canvasWrap.querySelector('.btn-fullscreen')) return;

    const btn = document.createElement('button');
    btn.className = 'btn-fullscreen'; btn.type = 'button'; btn.textContent = '⛶';
    btn.title = 'Fullscreen simulation'; btn.setAttribute('aria-label', btn.title);
    if (getComputedStyle(canvasWrap).position === 'static') canvasWrap.style.position = 'relative';
    canvasWrap.appendChild(btn);
    const isFs = () => document.fullscreenElement === simLayout;
    btn.addEventListener('click', () => {
        if (isFs()) {
            if (document.exitFullscreen) document.exitFullscreen();
        } else {
            const req = simLayout.requestFullscreen || simLayout.webkitRequestFullscreen;
            if (req) { const result = req.call(simLayout); if (result?.catch) result.catch(() => {}); }
        }
    });
    const syncUi = () => {
        const active = isFs();
        simLayout.classList.toggle('fs-active', active); document.body.classList.toggle('sim-fs', active);
        btn.textContent = active ? '⤢' : '⛶';
        btn.title = active ? 'Exit fullscreen' : 'Fullscreen simulation'; btn.setAttribute('aria-label', btn.title);
    };
    document.addEventListener('fullscreenchange', syncUi);
    document.addEventListener('webkitfullscreenchange', syncUi);
}
window.CommonLabSite = { initializeSimulationChrome };

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', event => {
            const targetId = anchor.getAttribute('href');
            if (targetId === '#') return;
            const target = document.querySelector(targetId);
            if (!target) return;
            event.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.primary-nav a');
    const updateActiveNav = () => {
        let currentId = '';
        sections.forEach(section => { if (window.scrollY >= section.offsetTop - 100) currentId = section.getAttribute('id'); });
        navLinks.forEach(link => {
            const active = link.getAttribute('href') === `#${currentId}`;
            link.classList.toggle('is-active', active);
        });
    };
    window.addEventListener('scroll', updateActiveNav, { passive: true }); updateActiveNav();
    initializeSimulationChrome();
});
