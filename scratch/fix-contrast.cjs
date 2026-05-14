const fs = require('fs');
const path = require('path');

const directory = 'site/public';
const files = fs.readdirSync(directory).filter(file => file.endsWith('.html'));

files.forEach(file => {
  const filePath = path.join(directory, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace hardcoded dark green with theme primary color (more vibrant)
  content = content.replace(/text-\[#0d631b\]/g, 'text-primary');
  content = content.replace(/border-\[#0d631b\]/g, 'border-primary');
  content = content.replace(/text-\[#2e7d32\]/g, 'text-primary-fixed-dim'); // For dark mode
  
  // Improve contrast for stone text (links)
  content = content.replace(/text-stone-600/g, 'text-stone-800');
  content = content.replace(/dark:text-stone-400/g, 'dark:text-stone-200');

  // Specific fix for the logo color if it was hardcoded differently
  content = content.replace(/text-\[\#0d631b\]/g, 'text-primary');

  fs.writeFileSync(filePath, content);
});
