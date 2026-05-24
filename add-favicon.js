import fs from 'fs';
import path from 'path';

const publicDir = './site/public';
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

const faviconLink = '    <link rel="icon" type="image/svg+xml" href="/favicon.svg">\n';

files.forEach(file => {
    const filePath = path.join(publicDir, file);
    let html = fs.readFileSync(filePath, 'utf8');
    
    // Check if favicon is already present
    if (html.includes('favicon.svg')) {
        console.log(`Favicon already present in ${file}`);
        return;
    }
    
    // Insert before </head>
    if (html.includes('</head>')) {
        html = html.replace('</head>', `${faviconLink}</head>`);
        fs.writeFileSync(filePath, html, 'utf8');
        console.log(`Added favicon to ${file}`);
    } else {
        console.log(`Warning: </head> tag not found in ${file}`);
    }
});
