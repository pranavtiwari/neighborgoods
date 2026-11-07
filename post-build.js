import fs from 'fs';
import path from 'path';

try {
    if (fs.existsSync('site/public/config.js')) {
        fs.copyFileSync('site/public/config.js', 'dist/config.js');
    } else if (fs.existsSync('site/public/config.example.js')) {
        fs.copyFileSync('site/public/config.example.js', 'dist/config.js');
    }
    fs.copyFileSync('site/public/firebase-client.js', 'dist/firebase-client.js');
    console.log('Assets copied successfully to dist/!');
} catch (e) {
    console.error('Error copying assets:', e);
    process.exit(1);
}
