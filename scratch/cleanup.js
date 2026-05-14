const fs = require('fs');
const path = require('path');

const directory = 'site/public';
const files = fs.readdirSync(directory).filter(file => file.endsWith('.html'));

files.forEach(file => {
  const filePath = path.join(directory, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace Tailwind CDN
  content = content.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@\d+"><\/script>/g, '');
  content = content.replace(/<script src="https:\/\/cdn\.tailwindcss\.com\?plugins=forms,container-queries"><\/script>/g, '');
  
  // Add new stylesheet
  if (!content.includes('href="/style.css"')) {
    content = content.replace(/<\/head>/, '  <link rel="stylesheet" href="/style.css">\n</head>');
  }

  // Remove inline tailwind config
  content = content.replace(/<script id="tailwind-config">[\s\S]*?<\/script>/g, '');
  
  // Remove config.js script
  content = content.replace(/<script type="module" src="config\.js"><\/script>/g, '');

  fs.writeFileSync(filePath, content);
});
