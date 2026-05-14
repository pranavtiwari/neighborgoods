const fs = require('fs');
const path = require('path');

const directory = 'site/public';
const files = fs.readdirSync(directory).filter(file => file.endsWith('.html'));

// The "Golden" Header and Bottom Nav patterns from index.html (with fixes)
const GOLDEN_HEADER_CLASSES = 'bg-[#fbf9f6]/80 dark:bg-stone-900/80 backdrop-blur-xl docked full-width top-0 sticky z-50 shadow-[0_12px_40px_rgba(51,51,51,0.06)]';

files.forEach(file => {
    const filePath = path.join(directory, file);
    let content = fs.readFileSync(filePath, 'utf8');

    // 1. Sync Header Classes
    content = content.replace(/<header class="[^"]*">/g, `<header class="${GOLDEN_HEADER_CLASSES}">`);

    // 2. Fix Hamburger Menu (add id and onclick)
    content = content.replace(/material-symbols-outlined text-green-800 active:scale-95/g, 'material-symbols-outlined text-primary cursor-pointer active:scale-95 mobile-menu-trigger');
    
    // Ensure every hamburger icon has the trigger class
    content = content.replace(/<span class="md:hidden material-symbols-outlined/g, '<span class="md:hidden material-symbols-outlined mobile-menu-trigger');

    // 3. Add 'Circles' to Bottom Nav if missing
    if (content.includes('BottomNavBar') && !content.includes('href="circles.html"') && content.includes('<nav')) {
        const bottomNavEnd = content.lastIndexOf('</nav>');
        const circlesLink = `
<a class="flex flex-col items-center justify-center text-stone-400 dark:text-stone-500 hover:text-primary active:scale-90 transition-all duration-300 ease-out" href="circles.html">
<span class="material-symbols-outlined">group</span>
<span class="font-lexend text-[11px] font-medium tracking-wide uppercase mt-1">Circles</span>
</a>`;
        // Insert before the last link in the bottom nav for better spacing
        content = content.slice(0, bottomNavEnd) + circlesLink + content.slice(bottomNavEnd);
    }

    fs.writeFileSync(filePath, content);
});
