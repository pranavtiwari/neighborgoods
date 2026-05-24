const fs = require('fs');

const circlesNavHtml = `
<a class="flex flex-col items-center justify-center text-stone-500 px-5 py-2 hover:text-primary transition-all active:scale-90 duration-200" href="circles.html">
<span class="material-symbols-outlined mb-1">groups</span>
<span class="font-lexend text-[11px] font-medium uppercase tracking-wider">Circles</span>
</a>`;

const files = fs.readdirSync('site/public').filter(f => f.endsWith('.html'));
for (const file of files) {
  let content = fs.readFileSync('site/public/' + file, 'utf8');
  
  if (content.includes('bottom-0')) {
    // Check if bottom nav already has circles
    const bottomNavMatch = content.match(/<nav[^>]*bottom-0[^>]*>([\s\S]*?)<\/nav>/);
    if (bottomNavMatch) {
      const bottomNavContent = bottomNavMatch[1];
      if (!bottomNavContent.includes('href="circles.html"')) {
        const exploreRegex = /<a[^>]*href=\"explore\.html\"[^>]*>[\s\S]*?<\/a>/;
        const exploreMatch = bottomNavContent.match(exploreRegex);
        if (exploreMatch) {
          const newBottomNavContent = bottomNavContent.replace(exploreRegex, exploreMatch[0] + circlesNavHtml);
          content = content.replace(bottomNavContent, newBottomNavContent);
          fs.writeFileSync('site/public/' + file, content);
          console.log('Updated ' + file);
        }
      }
    }
  }
}
