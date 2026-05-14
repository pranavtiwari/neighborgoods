const fs = require('fs');
const path = require('path');

const directory = 'site/public';
const files = fs.readdirSync(directory).filter(file => file.endsWith('.html'));

files.forEach(file => {
    const filePath = path.join(directory, file);
    let content = fs.readFileSync(filePath, 'utf8');

    // Replace legacy greens with theme primary
    content = content.replace(/text-green-900/g, 'text-primary');
    content = content.replace(/text-green-800/g, 'text-primary');
    content = content.replace(/text-green-700/g, 'text-primary');
    
    // Replace hardcoded logo green (just in case)
    content = content.replace(/text-\[#0d631b\]/g, 'text-primary');
    content = content.replace(/text-\[#2e7d32\]/g, 'text-primary-fixed-dim');

    // Ensure the inner container of the header is consistent
    // From index.html: <div class="flex justify-between items-center px-6 py-4 max-w-7xl mx-auto">
    content = content.replace(/<header[^>]*>\s*<div class="flex justify-between items-center px-6 py-4 [^"]*">/g, (match) => {
        return match.includes('header') ? match.replace(/class="[^"]*"/, 'class="flex justify-between items-center px-6 py-4 max-w-7xl mx-auto"') : match;
    });

    // Specifically for explore.html and others that might have "w-full"
    content = content.replace(/px-6 py-4 w-full/g, 'px-6 py-4 max-w-7xl mx-auto');

    fs.writeFileSync(filePath, content);
});
