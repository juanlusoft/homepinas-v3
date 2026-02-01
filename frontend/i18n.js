/**
 * HomePiNAS - Internationalization Module
 * v2.1.0 - i18n support for ES and EN
 */

// Current translations cache
let translations = {};
let currentLang = 'es';

// Load translations for a language
async function loadTranslations(lang) {
    try {
        const response = await fetch(`/frontend/i18n/${lang}.json`);
        if (!response.ok) throw new Error('Failed to load translations');
        translations = await response.json();
        currentLang = lang;
        return true;
    } catch (e) {
        console.error('i18n load error:', e);
        return false;
    }
}

// Get translation by key (supports nested keys like "auth.username")
function t(key, fallback = '') {
    const keys = key.split('.');
    let value = translations;
    
    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            return fallback || key;
        }
    }
    
    return typeof value === 'string' ? value : (fallback || key);
}

// Apply translations to all elements with data-i18n attribute
function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translated = t(key);
        if (translated && translated !== key) {
            el.textContent = translated;
        }
    });
    
    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const translated = t(key);
        if (translated && translated !== key) {
            el.placeholder = translated;
        }
    });
    
    // Update titles
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const translated = t(key);
        if (translated && translated !== key) {
            el.title = translated;
        }
    });
}

// Initialize i18n
async function initI18n() {
    // Get saved language or detect from browser
    const savedLang = localStorage.getItem('homepinas-lang');
    const browserLang = navigator.language.split('-')[0];
    const lang = savedLang || (browserLang === 'es' ? 'es' : 'en');
    
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.setAttribute('lang', lang);
    
    await loadTranslations(lang);
    applyTranslations();
    
    // Listen for language changes
    window.addEventListener('langchange', async (e) => {
        const newLang = e.detail.lang;
        await loadTranslations(newLang);
        applyTranslations();
        // Dispatch event for dynamic content re-render
        window.dispatchEvent(new CustomEvent('i18n-updated'));
    });
}

// Get current language
function getCurrentLang() {
    return currentLang;
}

// Export functions
export { initI18n, t, applyTranslations, loadTranslations, getCurrentLang };
